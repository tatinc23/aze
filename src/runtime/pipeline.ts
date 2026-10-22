// The runtime pipeline, decide-only since 2026-10-20 (Ken): check the map (the notes_query lookup) for each candidate
// tool's service → SubQ Snap picks the tools the task needs → the decisions and the advisories that apply go back to
// the caller. The caller's own LLM runs the tools, writes the answer and files friction with notes_file. Aze fills no
// inputs, runs no tools, distills nothing, writes no answer and drafts no notes. run() never throws.
import { randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS, type Envelope, type Settings, type Store } from "../types.js";
import { checkMap } from "../advise/index.js";
import { normalizeSurface } from "../gate/index.js";
import { defaultAssets, isNotesAsset } from "./catalog.js";
import type {
  AgentContext, Candidate, Decision, Pipeline, RunRecord, RunResult, RunStore, Router, TierTiming, ToolAdvisory, Usage,
} from "./types.js";

/** supabase-js has no request timeout: a hung store must not hang a run (or a swarm slot) forever. */
export const STORE_TIMEOUT_MS = 10_000;
export const MIN_P = 0.5;
/** At most this many tools are returned as chosen (every score is still returned). */
export const MAX_CHOSEN = 3;
/** At most this many candidates go to Snap (16 questions per Snap call, so at most 2 calls). */
export const MAX_CANDIDATES = 20;
/** At most this many distinct services get a map check per run. */
export const MAX_SURFACES = 5;
/** SubQ Snap: $0.05 per 1M input tokens = 0.05 micro-USD per input token (lead-provided price); output is free. */
export const SNAP_PRICE_IN_PER_M = 0.05;
const ASSET_TTL_MS = 30_000;

export interface PipelineDeps {
  /** The notes store: the map check reads it. */
  store: Store;
  /** The run log. */
  runs: RunStore;
  router: Router | null;
  /** Free mode (PAID_UNLOCKS not on): advisories carry the full workaround, as in notes_query. */
  free?: boolean;
}

export interface PipelineOptions {
  env?: NodeJS.ProcessEnv;
  storeTimeoutMs?: number;
}

/** Reject after `ms` (the underlying call is not cancelled; its late result or rejection is ignored). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  p.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

const msg = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 160);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Tokens a provider reports on a failed call (SubQ attaches `usage` to its errors): they were billed, so they count. */
export function usageOf(e: unknown): Usage | undefined {
  const u = (e as { usage?: unknown } | null)?.usage;
  if (!isObj(u)) return undefined;
  const input_tokens = Number(u.input_tokens), output_tokens = Number(u.output_tokens);
  if (!Number.isFinite(input_tokens) || !Number.isFinite(output_tokens) || input_tokens + output_tokens <= 0) return undefined;
  return { input_tokens, output_tokens };
}

/** micro-USD for Snap calls (input tokens only; output is free); undefined when nothing ran. */
export function snapCost(usages: Usage[], priceInPerM: number): number | undefined {
  if (!usages.length) return undefined;
  // $X per 1M tokens = X micro-USD per token.
  const c = usages.reduce((sum, u) => sum + (Number(u?.input_tokens) || 0) * priceInPerM, 0);
  return Math.round(c * 10_000) / 10_000;
}

const price = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const toolList = (names: string[]) => names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** The one line the caller's LLM acts on. */
export function nextStep(d: { decided_by: string | null; chosen: string[]; advisories: ToolAdvisory[] }): string {
  const file = "If a tool blocks or slows you, file one note with notes_file.";
  const n = d.advisories.length;
  const how = d.advisories.some((a) => a.workaround)
    ? "; workarounds are included"
    : d.advisories.some((a) => a.has_workaround && a.price_usdc) ? "; notes_unlock returns a paid workaround by note_id" : "";
  const issues = n ? ` Read the ${n} known issue${n === 1 ? "" : "s"} below first${how}.` : "";
  if (!d.decided_by) return `Snap was unavailable, so no tool was ranked: pick tools yourself and run them.${issues} ${file}`;
  if (!d.chosen.length) return `Snap found no candidate tool needed for this task (none at p >= ${MIN_P}): answer without them or pick one yourself.${issues} ${file}`;
  return `Aze does not run tools: call ${toolList(d.chosen)} yourself with your own inputs, then write the answer.${issues} ${file}`;
}

/** The advisories that apply to these tools: their service's notes filed against the whole service or that tool. */
export function applicableAdvisories(tools: Candidate[], envelopes: Map<string, Envelope>, surface: string | null): ToolAdvisory[] {
  const out: ToolAdvisory[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    const svc = t.surface ?? surface;
    const env = svc ? envelopes.get(normalizeSurface(svc)) : undefined;
    for (const a of env?.advisories ?? []) {
      if (seen.has(a.note_id) || (a.tool !== null && a.tool.trim().toLowerCase() !== t.id.toLowerCase())) continue;
      seen.add(a.note_id);
      out.push({ ...a, surface: env!.surface });
    }
  }
  return out;
}

// --- the pipeline ---------------------------------------------------------------------------------------------

export function createPipeline(deps: PipelineDeps, opts: PipelineOptions = {}): Pipeline {
  const { store, runs, router } = deps;
  const free = deps.free === true;
  const env = opts.env ?? process.env;
  const storeMs = opts.storeTimeoutMs ?? STORE_TIMEOUT_MS;
  let cache: { at: number; tools: Candidate[] } | null = null;

  /** The warehouse catalog as candidates, for runs that bring no tools (swarm, /admin/run). */
  async function catalog(): Promise<{ tools: Candidate[]; detail: string | null }> {
    if (cache && Date.now() - cache.at < ASSET_TTL_MS) return { tools: cache.tools, detail: null };
    const of = (assets: Array<{ id: string; description: string; active: boolean }>) =>
      assets.filter((a) => a.active && !isNotesAsset(a.id)).map((a) => ({ id: a.id, description: a.description }));
    try {
      const assets = await withTimeout(Promise.resolve().then(() => runs.listAssets()), storeMs, "listAssets");
      if (assets.length) {
        cache = { at: Date.now(), tools: of(assets) };
        return { tools: cache.tools, detail: null };
      }
      return { tools: of(defaultAssets(env)), detail: "catalog empty: default assets" };
    } catch (e) {
      return { tools: of(defaultAssets(env)), detail: `catalog unavailable (${msg(e)}): default assets` };
    }
  }

  async function settings(): Promise<Settings> {
    try {
      return await withTimeout(Promise.resolve().then(() => store.getSettings()), storeMs, "getSettings");
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  const unsaved = (task: string, surface: string | null, ctx: AgentContext, error: string): RunResult => {
    const now = new Date().toISOString();
    return {
      id: `unsaved-${randomUUID()}`, created_at: now, agent_id: String(ctx?.agent_id ?? "unknown"), swarm_id: ctx?.swarm_id ?? null, task,
      surface, status: "failed", attestation: ctx?.attestation === "verified" ? "verified" : "unverified", assets: [], timings: [],
      raw_bytes: null, distilled_bytes: null, cost_micro_usd: {}, answer: null, notes_filed: [], error, finished_at: now,
      decision: { decided_by: null, scores: [], advisories: [], next: "Nothing was decided: the run log is unavailable. Try again later." },
    };
  };

  async function run(task: string, surface: string | null, ctx: AgentContext, given: Candidate[] | undefined): Promise<RunResult> {
    const surf = typeof surface === "string" && surface.trim() ? surface.trim().slice(0, 60) : null;
    const newRun = { agent_id: String(ctx.agent_id), swarm_id: ctx.swarm_id ?? null, task, surface: surf, attestation: ctx.attestation }; // throws on a malformed ctx (outer catch)
    let rec: RunRecord;
    try {
      rec = await withTimeout(Promise.resolve().then(() => runs.insertRun(newRun)), storeMs, "insertRun");
    } catch (e) {
      // No run log, no spend: refuse before Snap is called.
      return unsaved(task, surf, ctx, `run store unavailable: ${msg(e)}`);
    }

    const timings: TierTiming[] = [];
    const time = (tier: TierTiming["tier"], start: number, ok: boolean, detail: string, usage?: Usage) => {
      timings.push({ tier, ms: Date.now() - start, ok, detail, ...(usage ? { usage } : {}) });
    };
    const usage: Usage[] = [];
    let unreported = false; // Snap answered but reported no tokens: its cost is unknown (null), never $0
    let error: string | null = null;
    let decidedBy: string | null = null;
    let scores: Array<{ asset_id: string; p: number }> = [];
    let chosen: Array<{ asset_id: string; p: number }> = [];

    const fromCaller = Array.isArray(given) && given.length > 0;
    const { tools: all, detail: catDetail } = fromCaller ? { tools: given!, detail: null } : await catalog();
    const candidates = all.slice(0, MAX_CANDIDATES);
    const ids = new Set(candidates.map((c) => c.id));

    // 1. Check the map for every candidate tool's service.
    const envelopes = new Map<string, Envelope>();
    {
      const t = Date.now();
      const services = [...new Map(candidates
        .map((c) => c.surface ?? surf)
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => [normalizeSurface(s), s] as const)).values()];
      if (!services.length) time("notes", t, false, "map check skipped: no service given");
      else {
        const checked = services.slice(0, MAX_SURFACES);
        const set = await settings();
        const res = await Promise.all(checked.map((s) =>
          withTimeout(checkMap(store, set, s, { free }), storeMs, "map check").catch(() => ({ surface: normalizeSurface(s), advisories: [], score: null, next: "", degraded: true } as Envelope))));
        let n = 0, degraded = 0;
        for (const e of res) {
          envelopes.set(e.surface, e);
          n += e.advisories.length;
          if (e.degraded) degraded++;
        }
        const skipped = services.length - checked.length;
        time("notes", t, degraded < res.length,
          `map check: ${n} advisories across ${checked.length} service${checked.length === 1 ? "" : "s"}${degraded ? ` (${degraded} degraded)` : ""}${skipped ? `; ${skipped} more not checked` : ""}`);
      }
    }

    // 2. SubQ Snap: which tools does the task need?
    {
      const t = Date.now();
      if (!router) {
        error = "SubQ Snap unavailable: no tool was ranked";
        time("snap", t, false, `router unavailable${catDetail ? `; ${catDetail}` : ""}`);
      } else if (!candidates.length) {
        error = "no candidate tools";
        time("snap", t, false, `no candidate tools${catDetail ? `; ${catDetail}` : ""}`);
      } else {
        try {
          const r = await router.route(task, candidates);
          const seen = new Set<string>();
          scores = (Array.isArray(r?.choices) ? r.choices : [])
            .filter((c) => ids.has(c?.asset_id) && Number.isFinite(c?.p))
            .sort((a, b) => b.p - a.p)
            .filter((c) => !seen.has(c.asset_id) && Boolean(seen.add(c.asset_id)))
            .map((c) => ({ asset_id: c.asset_id, p: c.p }));
          chosen = scores.filter((c) => c.p >= MIN_P).slice(0, MAX_CHOSEN);
          decidedBy = router.label ?? "router";
          const u = r?.usage && (Number(r.usage.input_tokens) || 0) + (Number(r.usage.output_tokens) || 0) > 0 ? r.usage : undefined;
          if (u) usage.push(u);
          else if (Number(r?.ms) > 0) unreported = true;
          // The run log is public: caller tool names (which can name a private org) never go into the detail.
          const picked = fromCaller
            ? `chose ${chosen.length} of ${candidates.length} tools (p=${chosen.map((c) => c.p.toFixed(2)).join(", ")})`
            : `chose ${chosen.map((c) => `${c.asset_id} p=${c.p.toFixed(2)}`).join(", ")}`;
          time("snap", t, true, `${chosen.length ? picked : `no tool needed (none of ${candidates.length} at p >= ${MIN_P})`}${typeof r?.detail === "string" && r.detail ? `; ${r.detail.slice(0, 300)}` : ""}${catDetail ? `; ${catDetail}` : ""}`, u);
        } catch (e) {
          const u = usageOf(e);
          if (u) usage.push(u);
          error = `SubQ Snap failed: ${msg(e)}`;
          time("snap", t, false, `router failed (${msg(e)}): nothing ranked`, u);
        }
      }
    }

    // 3. The advisories that apply: to the chosen tools, or to every candidate when nothing could be ranked.
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const targets = decidedBy ? chosen.map((c) => byId.get(c.asset_id)!) : candidates;
    const advisories = applicableAdvisories(targets, envelopes, surf);
    const decision: Decision = {
      decided_by: decidedBy,
      scores: scores.map((c) => ({ tool: c.asset_id, p: c.p })),
      advisories,
      next: nextStep({ decided_by: decidedBy, chosen: chosen.map((c) => c.asset_id), advisories }),
    };

    const snap = unreported ? null : snapCost(usage, price(env.SNAP_PRICE_IN_PER_M) ?? SNAP_PRICE_IN_PER_M);
    const patch = {
      status: (decidedBy ? "done" : "failed") as RunRecord["status"], assets: chosen, timings, raw_bytes: null, distilled_bytes: null,
      cost_micro_usd: snap === undefined ? {} : { snap }, answer: null, notes_filed: [] as string[], error,
      finished_at: new Date().toISOString(),
    } satisfies Partial<RunRecord>;
    try {
      await withTimeout(Promise.resolve().then(() => runs.finishRun(rec.id, patch)), storeMs, "finishRun");
    } catch (e) {
      console.error(`[runtime] finishRun failed for ${rec.id}: ${msg(e)}`);
    }
    return { ...rec, ...patch, decision };
  }

  return {
    async run(task, surface, ctx, tools) {
      try {
        return await run(String(task ?? ""), surface ?? null, ctx, tools);
      } catch (e) {
        // Last line of defence (e.g. a malformed context): still never throw.
        return unsaved(String(task ?? ""), surface ?? null, ctx, `pipeline error: ${msg(e)}`);
      }
    },
  };
}
