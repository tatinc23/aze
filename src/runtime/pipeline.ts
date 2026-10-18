// Stream A: the runtime pipeline. One run = check Aze first (notes_query) → Tier 1 route (Snap) → args → execute →
// Tier 2 distill (SubQ) → Tier 3 render (Workers AI) → file friction as notes (through Aze's own notes_file, so the
// privacy gate + Snap audit apply). Every provider is optional: a null provider has a deterministic fallback and a
// timing entry that says so. run() never throws; a whole run has a soft 120 s deadline.
import { randomUUID } from "node:crypto";
import type { Store } from "../types.js";
import { DEFAULT_ASSETS, defaultAssets, isNotesAsset } from "./catalog.js";
import { truncateBytes } from "./fetch.js";
import type {
  AgentContext, Asset, Executor, Pipeline, RunRecord, RunStore, RuntimeDeps, StepResult, Tier, TierTiming, Usage,
} from "./types.js";

export const RUN_DEADLINE_MS = 120_000;
/** supabase-js has no request timeout: a hung store must not hang a run (or a swarm slot) forever. */
export const STORE_TIMEOUT_MS = 10_000;
export const RAW_FALLBACK_BYTES = 4_096; // facts when there is no distiller: raw truncated to 4 KB
export const ANSWER_MAX_BYTES = 4_096;
export const MIN_P = 0.5;
export const MAX_ASSETS = 3;
export const MAX_NOTES = 2;
/** SubQ Snap: $0.05 per 1M input tokens = 0.05 micro-USD per input token (lead-provided price). */
export const SNAP_PRICE_IN_PER_M = 0.05;
const ASSET_TTL_MS = 30_000;
const NOTE_FIELDS = ["kind", "category", "surface", "what", "tool", "error", "tokens_spent", "dollars_spent", "workaround", "wish"] as const;
export const NOTHING_TO_DO = "Nothing to report: no surface was given and no warehouse asset was needed or available for this task.";

export interface PipelineOptions {
  env?: NodeJS.ProcessEnv;
  deadlineMs?: number;
  storeTimeoutMs?: number;
}

/** Reject after `ms` (the underlying call is not cancelled; its late result or rejection is ignored). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  p.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

class DeadlineError extends Error {
  constructor(readonly stage: string) { super(`deadline at ${stage}`); }
}

const msg = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 160);
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isRunStore = (s: unknown): s is RunStore => isObj(s) && typeof (s as { insertRun?: unknown }).insertRun === "function";
/** Tokens a provider reports on a failed call (stream B attaches `usage` to its errors): they were billed, so they count. */
export function usageOf(e: unknown): Usage | undefined {
  const u = (e as { usage?: unknown } | null)?.usage;
  if (!isObj(u)) return undefined;
  const input_tokens = Number(u.input_tokens), output_tokens = Number(u.output_tokens);
  if (!Number.isFinite(input_tokens) || !Number.isFinite(output_tokens) || input_tokens + output_tokens <= 0) return undefined;
  return { input_tokens, output_tokens };
}

/** Failures that are the runtime's own (placeholder executor, missing config, our SSRF policy, bad arguments), not the
 * service's: they are never turned into field notes, or the public map would fill with notes about our plumbing. */
const OWN_FAILURE = /^(not configured|missing url argument|asset has no valid https MCP endpoint|no [a-z_]+ executor|executor threw|\S+ is not callable by the runtime|refused: |invalid URL)/;
export const isOwnFailure = (s: StepResult): boolean => !s.ok && !s.friction && OWN_FAILURE.test(String(s.error ?? ""));

// --- deterministic fallbacks -----------------------------------------------------------------------------------

const TLDS = "com|net|org|edu|gov|io|ai|dev|app|co|sh|so|me|gg|ly|tv|fm|to|run|pro|live|xyz|cloud|tech|site|info|biz|page|" +
  "us|uk|de|ca|fr|nl|eu|ch|se|es|it|in|au|jp|br";
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/i;
const DOMAIN_RE = new RegExp(String.raw`(?<![\w@.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${TLDS}))(?![\w-])(\/[^\s<>"'` + "`" + String.raw`)\]]*)?`, "i");
const trimPunct = (s: string) => s.replace(/[.,;:!?]+$/, "");

/** The first URL (or bare public domain) in a task, as https. */
export function urlFromTask(task: string): string | null {
  const u = task.match(URL_RE);
  if (u) return trimPunct(u[0]).replace(/^http:\/\//i, "https://");
  const d = task.match(DOMAIN_RE);
  if (d) return `https://${d[1].toLowerCase()}${trimPunct(d[2] ?? "")}`;
  return null;
}

/** Router fallback: web_fetch when the task names a URL or domain, else nothing. p = 1 marks a deterministic pick. */
export function fallbackRoute(task: string, candidates: Asset[]): Array<{ asset_id: string; p: number }> {
  return candidates.some((a) => a.id === "web_fetch") && urlFromTask(task) ? [{ asset_id: "web_fetch", p: 1 }] : [];
}

function fallbackArgs(task: string, asset: Asset): Record<string, unknown> | null {
  if (asset.executor === "http_fetch") {
    const url = urlFromTask(task);
    return url ? { url } : null;
  }
  return null;
}

const requiredArgs = (a: Asset): string[] => (Array.isArray(a.input_schema?.required) ? (a.input_schema.required as unknown[]).map(String) : []);
const missingArgs = (a: Asset, args: Record<string, unknown>) =>
  requiredArgs(a).filter((k) => args[k] === undefined || args[k] === null || (typeof args[k] === "string" && !(args[k] as string).trim()));

/** Whitelist the NoteInput fields a note writer may set; payout/proof come only from the agent's context. */
export function sanitizeNote(note: Record<string, unknown>, surface: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of NOTE_FIELDS) {
    const v = note[k];
    if (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v)) out[k] = typeof v === "string" ? v.trim() : v;
  }
  if (!out.surface) out.surface = surface;
  return out;
}

/** What the distiller sees: Aze's advisories for the surface, then every step's output. */
export function buildRaw(surface: string | null, envelope: string | null, steps: StepResult[]): string {
  const parts: string[] = [];
  if (surface && envelope) parts.push(`## Aze known issues for "${surface}" (notes_query)\n${envelope}`);
  steps.forEach((s, i) => {
    const head = `## Step ${i + 1}: ${s.asset_id} (${s.ok ? "ok" : `failed: ${s.error ?? "error"}`}${s.friction ? ", friction" : ""}, ${s.ms} ms)`;
    parts.push(s.output ? `${head}\n${s.output}` : head);
  });
  return parts.join("\n\n");
}

/** micro-USD for a tier's calls; null when the price is unknown (never invented); undefined when nothing ran. */
export function tierCost(usages: Usage[], priceInPerM: number | null, priceOutPerM: number | null, inputOnly = false): number | null | undefined {
  if (!usages.length) return undefined;
  if (priceInPerM === null || (!inputOnly && priceOutPerM === null)) return null;
  // $X per 1M tokens = X micro-USD per token.
  let c = 0;
  for (const u of usages) c += (Number(u?.input_tokens) || 0) * priceInPerM + (inputOnly ? 0 : (Number(u?.output_tokens) || 0) * (priceOutPerM as number));
  return Math.round(c * 10_000) / 10_000;
}

const price = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

function parseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

async function safeExec(ex: Executor, asset: Asset, args: Record<string, unknown>, ctx: AgentContext): Promise<StepResult> {
  const t0 = Date.now();
  try {
    const s = await ex.execute(asset, args, ctx);
    return { asset_id: asset.id, ok: Boolean(s?.ok), output: String(s?.output ?? ""), ms: Number(s?.ms) || Date.now() - t0, error: s?.ok ? null : s?.error ?? "error", friction: Boolean(s?.friction) };
  } catch (e) {
    return { asset_id: asset.id, ok: false, output: "", ms: Date.now() - t0, error: `executor threw: ${msg(e)}`, friction: false };
  }
}

// --- the pipeline ---------------------------------------------------------------------------------------------

export function createPipeline(store: RunStore | Store, runtime: RuntimeDeps, opts: PipelineOptions = {}): Pipeline {
  // Accept either the RunStore or the notes Store (then the runtime's own RunStore is used).
  const runs: RunStore = isRunStore(store) ? store : runtime.runs;
  const env = opts.env ?? process.env;
  const deadlineMs = opts.deadlineMs ?? RUN_DEADLINE_MS;
  const storeMs = opts.storeTimeoutMs ?? STORE_TIMEOUT_MS;
  let cache: { at: number; assets: Asset[] } | null = null;

  async function catalog(): Promise<{ assets: Asset[]; detail: string | null }> {
    if (cache && Date.now() - cache.at < ASSET_TTL_MS) return { assets: cache.assets, detail: null };
    try {
      const assets = await withTimeout(Promise.resolve().then(() => runs.listAssets()), storeMs, "listAssets");
      if (assets.length) {
        cache = { at: Date.now(), assets };
        return { assets, detail: null };
      }
      return { assets: defaultAssets(env), detail: "catalog empty: default assets" };
    } catch (e) {
      return { assets: defaultAssets(env), detail: `catalog unavailable (${msg(e)}): default assets` };
    }
  }

  async function run(task: string, surface: string | null, ctx: AgentContext): Promise<RunRecord> {
    const t0 = Date.now();
    const deadline = t0 + deadlineMs;
    const left = () => deadline - Date.now();
    const within = <T>(p: Promise<T>, stage: string): Promise<T> => {
      p.catch(() => {}); // a late rejection after the deadline must not go unhandled
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new DeadlineError(stage)), Math.max(0, left())); });
      return Promise.race([p, limit]).finally(() => clearTimeout(timer));
    };
    const checkDeadline = (stage: string) => { if (left() <= 0) throw new DeadlineError(stage); };

    const surf = typeof surface === "string" && surface.trim() ? surface.trim().slice(0, 60) : null;
    const newRun = { agent_id: String(ctx.agent_id), swarm_id: ctx.swarm_id ?? null, task, surface: surf, attestation: ctx.attestation }; // throws on a malformed ctx (outer catch)
    let rec: RunRecord;
    try {
      rec = await withTimeout(Promise.resolve().then(() => runs.insertRun(newRun)), storeMs, "insertRun");
    } catch (e) {
      // No run log, no spend: refuse before any provider is called.
      const now = new Date().toISOString();
      return {
        id: `unsaved-${randomUUID()}`, created_at: now, agent_id: newRun.agent_id, swarm_id: newRun.swarm_id, task, surface: surf,
        status: "failed", attestation: ctx?.attestation === "verified" ? "verified" : "unverified", assets: [], timings: [], raw_bytes: null,
        distilled_bytes: null, cost_micro_usd: {}, answer: null, notes_filed: [], error: `run store unavailable: ${msg(e)}`, finished_at: now,
      };
    }

    const timings: TierTiming[] = [];
    type Billed = "snap" | "args" | "distill" | "render" | "notes";
    const usage: Record<Billed, Usage[]> = { snap: [], args: [], distill: [], render: [], notes: [] };
    // Tiers where a real call (ms > 0) reported no tokens: the providers' parsers map missing usage to zeros, and $0
    // would be an invented number, so those tiers' cost is null (unknown).
    const unreported = new Set<Billed>();
    /** Record a resolved call's usage; returns the usage to show in its timing (none when nothing was reported). */
    const bill = (tier: Billed, r: { usage?: Usage | null; ms?: number } | null | undefined): Usage | undefined => {
      const u = r?.usage ?? undefined;
      if (u && (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0) > 0) {
        usage[tier].push(u);
        return u;
      }
      if (Number(r?.ms) > 0) unreported.add(tier);
      return undefined;
    };
    const time = (tier: Tier, start: number, ok: boolean, detail: string, u?: Usage) => {
      timings.push({ tier, ms: Date.now() - start, ok, detail, ...(u ? { usage: u } : {}) });
    };
    let chosen: Array<{ asset_id: string; p: number }> = [];
    const notesFiled: string[] = [];
    let raw: string | null = null;
    let facts: string | null = null;
    let answer: string | null = null;
    let rawBytes: number | null = null;
    let distilledBytes: number | null = null;
    let status: RunRecord["status"] = "done";
    let error: string | null = null;

    try {
      const { assets, detail: catDetail } = await catalog();
      const byId = new Map(assets.map((a) => [a.id, a]));
      const fromDefaults = (id: string) => byId.get(id) ?? defaultAssets(env).find((a) => a.id === id) ?? DEFAULT_ASSETS.find((a) => a.id === id)!;
      const aze = runtime.executors.aze ?? null;

      // 1. Check the map first.
      let envelope: string | null = null;
      if (surf) {
        const t = Date.now();
        if (!aze) time("notes", t, false, "pre-check skipped: aze executor unavailable");
        else {
          checkDeadline("notes");
          const s = await within(safeExec(aze, fromDefaults("notes_query"), { surface: surf }, ctx), "notes");
          const body = parseJson(s.output);
          const n = Array.isArray(body?.advisories) ? (body!.advisories as unknown[]).length : null;
          if (s.ok) envelope = s.output;
          time("notes", t, s.ok, s.ok ? `pre-check: ${n ?? "?"} advisories${body?.degraded ? " (degraded)" : ""}` : `pre-check failed: ${s.error}`);
        }
      }

      // 2. Tier 1: which assets does the task need?
      const candidates = assets.filter((a) => a.active && !isNotesAsset(a.id));
      const ids = new Set(candidates.map((a) => a.id));
      {
        const t = Date.now();
        const pick = () => fallbackRoute(task, candidates);
        if (runtime.router && candidates.length) {
          checkDeadline("snap");
          try {
            const r = await within(runtime.router.route(task, candidates), "snap");
            const seen = new Set<string>();
            chosen = (Array.isArray(r?.choices) ? r.choices : [])
              .filter((c) => ids.has(c?.asset_id) && Number.isFinite(c?.p) && c.p >= MIN_P)
              .sort((a, b) => b.p - a.p)
              .filter((c) => !seen.has(c.asset_id) && Boolean(seen.add(c.asset_id)))
              .slice(0, MAX_ASSETS)
              .map((c) => ({ asset_id: c.asset_id, p: c.p }));
            const u = bill("snap", r);
            time("snap", t, true, `${chosen.length ? `chose ${chosen.map((c) => `${c.asset_id} p=${c.p.toFixed(2)}`).join(", ")}` : `no asset needed (none of ${candidates.length} at p >= ${MIN_P})`}${catDetail ? `; ${catDetail}` : ""}`, u);
          } catch (e) {
            if (e instanceof DeadlineError) throw e;
            const u = usageOf(e);
            if (u) usage.snap.push(u);
            chosen = pick();
            time("snap", t, false, `router failed (${msg(e)}): fallback${chosen.length ? " web_fetch" : ", nothing chosen"}`, u);
          }
        } else {
          chosen = pick();
          time("snap", t, false, `${runtime.router ? "no active assets" : "router unavailable"}: fallback${chosen.length ? " web_fetch (URL in task)" : ", nothing chosen"}${catDetail ? `; ${catDetail}` : ""}`);
        }
      }

      // 3. Arguments + execution, in rank order (later args see earlier results).
      const steps: StepResult[] = [];
      for (const c of chosen) {
        checkDeadline("execute");
        const asset = byId.get(c.asset_id)!;
        let args: Record<string, unknown> | null = null;
        const ta = Date.now();
        if (runtime.args) {
          try {
            const r = await within(runtime.args.fill(task, asset, steps.slice()), "args");
            args = isObj(r?.args) ? r.args : {};
            time("args", ta, true, asset.id, bill("args", r));
          } catch (e) {
            if (e instanceof DeadlineError) throw e;
            const u = usageOf(e);
            if (u) usage.args.push(u);
            time("args", ta, false, `${asset.id}: arg filler failed (${msg(e)})`, u);
          }
        }
        const missing = args ? missingArgs(asset, args) : requiredArgs(asset);
        if (missing.length) {
          const fb = fallbackArgs(task, asset);
          if (fb) {
            args = { ...(args ?? {}), ...fb };
            time("args", Date.now(), false, `${asset.id}: ${runtime.args ? `missing ${missing.join(", ")}` : "arg filler unavailable"}; url taken from task`);
          } else {
            time("args", Date.now(), false, `${asset.id}: skipped (${runtime.args ? `missing ${missing.join(", ")}` : "arg filler unavailable"})`);
            continue;
          }
        }
        const ex = runtime.executors[asset.executor];
        const s = ex
          ? await within(safeExec(ex, asset, args ?? {}, ctx), "execute")
          : { asset_id: asset.id, ok: false, output: "", ms: 0, error: `no ${asset.executor} executor`, friction: false };
        steps.push(s);
        timings.push({ tier: "execute", ms: s.ms, ok: s.ok, detail: `${asset.id}${s.ok ? "" : `: ${String(s.error).slice(0, 160)}`}${s.friction ? " (friction)" : ""}` });
      }

      // 4. Tier 2: compress everything into facts.
      raw = buildRaw(surf, envelope, steps);
      rawBytes = bytes(raw);
      {
        const t = Date.now();
        if (!raw.trim()) {
          facts = "";
          time("distill", t, false, "nothing to distill");
        } else if (runtime.distiller) {
          checkDeadline("distill");
          try {
            const r = await within(runtime.distiller.distill(task, raw), "distill");
            const u = bill("distill", r);
            if (typeof r?.facts === "string" && r.facts.trim()) {
              facts = r.facts.trim();
              distilledBytes = bytes(facts);
              time("distill", t, true, `${rawBytes} -> ${distilledBytes} bytes`, u);
            } else {
              facts = truncateBytes(raw, RAW_FALLBACK_BYTES);
              time("distill", t, false, "distiller returned no facts: raw truncated to 4 KB", u);
            }
          } catch (e) {
            if (e instanceof DeadlineError) throw e;
            const u = usageOf(e);
            if (u) usage.distill.push(u);
            facts = truncateBytes(raw, RAW_FALLBACK_BYTES);
            time("distill", t, false, `distiller failed (${msg(e)}): raw truncated to 4 KB`, u);
          }
        } else {
          facts = truncateBytes(raw, RAW_FALLBACK_BYTES);
          time("distill", t, false, "distiller unavailable: raw truncated to 4 KB");
        }
      }

      // 5. Tier 3: the answer, from the facts only.
      {
        const t = Date.now();
        if (!facts) {
          answer = NOTHING_TO_DO;
          time("render", t, false, "skipped: no facts");
        } else if (runtime.renderer) {
          checkDeadline("render");
          try {
            const r = await within(runtime.renderer.render(task, facts), "render");
            const u = bill("render", r);
            const text = typeof r?.text === "string" ? r.text.trim() : "";
            answer = text || facts;
            time("render", t, Boolean(text), `${r?.model ?? "unknown model"}${r?.fallback_used ? " (fallback)" : ""}${text ? "" : ": empty answer, facts returned"}`, u);
          } catch (e) {
            if (e instanceof DeadlineError) throw e;
            const u = usageOf(e);
            if (u) usage.render.push(u);
            answer = facts;
            time("render", t, false, `renderer failed (${msg(e)}): facts returned`, u);
          }
        } else {
          answer = facts;
          time("render", t, false, "renderer unavailable: facts returned");
        }
      }

      // 6. Friction becomes field notes (gate + Snap audit apply inside notes_file).
      const own = steps.filter(isOwnFailure);
      if (own.length) time("notes", Date.now(), true, `not filed: ${own.map((s) => s.asset_id).join(", ")} failed on the runtime's side, not the service's`);
      const worth = steps.filter((s) => (s.friction || !s.ok) && !isOwnFailure(s)).slice(0, MAX_NOTES);
      if (worth.length) {
        const t = Date.now();
        if (!surf) time("notes", t, false, "friction not filed: no surface");
        else if (!runtime.noteWriter) time("notes", t, false, "friction not filed: note writer unavailable");
        else if (!aze) time("notes", t, false, "friction not filed: aze executor unavailable");
        else {
          for (const s of worth) {
            checkDeadline("notes");
            const tn = Date.now();
            let u: Usage | undefined;
            try {
              const w = await within(runtime.noteWriter.write(task, surf, s), "notes");
              u = bill("notes", w);
              if (!isObj(w?.note)) {
                time("notes", tn, true, `${s.asset_id}: nothing worth filing`, u);
                continue;
              }
              const f = await within(safeExec(aze, fromDefaults("notes_file"), sanitizeNote(w.note, surf), ctx), "notes");
              const body = parseJson(f.output);
              const id = typeof body?.note_id === "string" ? body.note_id : null;
              if (f.ok && id) {
                notesFiled.push(id);
                const audit = isObj(body?.audit) ? ` (audit ${String(body!.audit.status)})` : "";
                time("notes", tn, true, `${s.asset_id}: filed ${id}${audit}`, u);
              } else {
                // Codes and rule names only: rejected note text is never logged or stored.
                const rules = Array.isArray(body?.problems) ? [...new Set((body!.problems as Array<{ rule?: unknown }>).map((p) => String(p?.rule ?? "")).filter(Boolean))] : [];
                time("notes", tn, false, `${s.asset_id}: not filed (${f.error ?? "unknown"}${rules.length ? `: ${rules.join(", ")}` : ""})`, u);
              }
            } catch (e) {
              if (e instanceof DeadlineError) throw e;
              const eu = u ? undefined : usageOf(e); // a writer that threw reports its spend on the error
              if (eu) usage.notes.push(eu);
              time("notes", tn, false, `${s.asset_id}: note writer failed (${msg(e)})`, u ?? eu);
            }
          }
        }
      }
    } catch (e) {
      status = "failed";
      if (e instanceof DeadlineError) {
        error = `soft deadline (${Math.round(deadlineMs / 1000)} s) exceeded at ${e.stage}`;
        timings.push({ tier: (["snap", "args", "execute", "distill", "render", "notes"].includes(e.stage) ? e.stage : "execute") as Tier, ms: 0, ok: false, detail: `stopped: ${error}` });
      } else error = `pipeline error: ${msg(e)}`;
      answer = answer ?? facts ?? (raw ? truncateBytes(raw, RAW_FALLBACK_BYTES) : null);
    }

    const rIn = price(env.RENDER_PRICE_IN_PER_M), rOut = price(env.RENDER_PRICE_OUT_PER_M);
    // On ARGS_BACKEND=workers-ai the chat tiers run on the renderer's models, so they take the renderer's price.
    const waiChat = runtime.chatBackend === "workers-ai";
    const pIn = waiChat ? rIn : price(env.SUBQ_CHAT_PRICE_IN_PER_M), pOut = waiChat ? rOut : price(env.SUBQ_CHAT_PRICE_OUT_PER_M);
    const costs: Partial<Record<Tier, number | null | undefined>> = {
      snap: unreported.has("snap") ? null : tierCost(usage.snap, price(env.SNAP_PRICE_IN_PER_M) ?? SNAP_PRICE_IN_PER_M, null, true),
      args: unreported.has("args") ? null : tierCost(usage.args, pIn, pOut),
      distill: unreported.has("distill") ? null : tierCost(usage.distill, pIn, pOut),
      notes: unreported.has("notes") ? null : tierCost(usage.notes, pIn, pOut),
      render: unreported.has("render") ? null : tierCost(usage.render, rIn, rOut),
    };
    const cost_micro_usd = Object.fromEntries(Object.entries(costs).filter(([, v]) => v !== undefined)) as RunRecord["cost_micro_usd"];

    const patch = {
      status, assets: chosen, timings, raw_bytes: rawBytes, distilled_bytes: distilledBytes,
      cost_micro_usd, answer: answer === null ? null : truncateBytes(answer, ANSWER_MAX_BYTES), notes_filed: notesFiled, error,
      finished_at: new Date().toISOString(),
    } satisfies Partial<RunRecord>;
    try {
      await withTimeout(Promise.resolve().then(() => runs.finishRun(rec.id, patch)), storeMs, "finishRun");
    } catch (e) {
      console.error(`[runtime] finishRun failed for ${rec.id}: ${msg(e)}`);
    }
    return { ...rec, ...patch };
  }

  return {
    async run(task, surface, ctx) {
      try {
        return await run(String(task ?? ""), surface ?? null, ctx);
      } catch (e) {
        // Last line of defence (e.g. a malformed context): still never throw.
        const now = new Date().toISOString();
        return {
          id: `unsaved-${randomUUID()}`, created_at: now, agent_id: String(ctx?.agent_id ?? "unknown"), swarm_id: ctx?.swarm_id ?? null,
          task: String(task ?? ""), surface: surface ?? null, status: "failed", attestation: "unverified", assets: [], timings: [],
          raw_bytes: null, distilled_bytes: null, cost_micro_usd: {}, answer: null, notes_filed: [], error: `pipeline error: ${msg(e)}`, finished_at: now,
        };
      }
    },
  };
}
