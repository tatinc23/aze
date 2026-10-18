// Stream E: swarm admin routes and the public run APIs behind the dashboard's agent grid and economics panel.
//   POST /admin/swarm {n, concurrency}  (x-admin-key) → {ok, swarm_id, ...}; 409 while one is running
//   POST /admin/swarm/stop              (x-admin-key) → {ok, stopped, swarm_id}
//   POST /admin/run {task, surface}     (x-admin-key) → one pipeline run, the RunRecord (operator view)
//   GET  /api/swarm                     → current/last swarm for the grid (no addresses, no identities)
//   GET  /api/runs?limit=20[&swarm_id=] → recent runs (public task text, rendered answers, timings, costs)
//   GET  /api/runs/stats[?swarm_id=]    → RunStats
// Admin routes spend provider credits, so the key is required and compared in constant time, and every operator run
// (swarm agents + /admin/run) counts against one hourly run budget (SWARM_RUNS_PER_HOUR, default 300).
// Public reads are cached for a few seconds so many dashboards polling cannot hammer the store, time out (503) because
// supabase-js has no request timeout, and at most a few uncached store reads run at once (503 "busy" beyond that).
// Public run records carry only the rendered answer and timings: never the raw tool output (fetched page text), the
// distilled facts that stand in for an answer when rendering failed, or provider response excerpts.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Store } from "../types.js";
import { createPipeline, NOTHING_TO_DO } from "../runtime/pipeline.js";
import type { AgentContext, Pipeline, RunRecord, RunStats, RuntimeDeps, Tier, TierTiming } from "../runtime/types.js";
import { createRunBudget, runsPerHour, type RunBudget } from "../swarm/budget.js";
import { defaultRunner, intInRange, MAX_AGENTS, SwarmBusyError, SwarmInputError, type SwarmRunner, type SwarmState } from "../swarm/runner.js";
import { hasControlChars, loadTasks, MAX_SURFACE_CHARS, MAX_TASK_CHARS, SECRET_MASK_RE, surfaceRule, taskTextRule } from "../swarm/tasks.js";
import { createWallets, type Wallets } from "../swarm/wallets.js";

export const RUNS_DEFAULT_LIMIT = 20;
export const RUNS_MAX_LIMIT = 100;
export const PUBLIC_CACHE_MS = 3_000;
export const PUBLIC_STORE_TIMEOUT_MS = 5_000;
/** Uncached store reads from the public endpoints that may run at once (counted until the store call settles). */
export const PUBLIC_MAX_IN_FLIGHT = 6;
/** POST /admin/run calls that may run at once (each can take up to the pipeline's 120 s). */
export const ADMIN_RUN_MAX_IN_FLIGHT = 3;
export const PUBLIC_DETAIL_MAX = 240;
const SWARM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TIERS: readonly Tier[] = ["snap", "args", "execute", "distill", "render", "notes"];

export interface RuntimeWebDeps {
  store: Store;
  runtime: RuntimeDeps;
  adminKey?: string;
  baseUrl?: string;
  /** Test seams; production uses the defaults. */
  pipeline?: Pipeline;
  runner?: SwarmRunner;
  wallets?: Wallets | null;
  env?: NodeJS.ProcessEnv;
  cacheMs?: number;
  storeTimeoutMs?: number;
  /** Hourly run budget shared by swarms and /admin/run; default from SWARM_RUNS_PER_HOUR. */
  budget?: RunBudget;
  maxInFlight?: number;
  adminRunMaxInFlight?: number;
  /** Override the task list (tests); default loadTasks() on each swarm start. */
  loadTasks?: typeof loadTasks;
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
/** Constant-time key check (hashing first makes the lengths equal). No key configured = nobody is admin. */
export function isAdmin(given: string | undefined | null, key: string | undefined): boolean {
  if (!key) return false;
  return timingSafeEqual(digest(typeof given === "string" ? given : ""), digest(key));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** One line for the server log: masked like the public strings (a provider error can echo a key prefix). */
const short = (e: unknown) => redactPublic(String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 160));

// An EVM address (0x + exactly 40 hex; 64-hex tx hashes are left alone). Operational strings (errors, step details)
// never need one, and a payout address must never reach a public endpoint, so they are masked there, as are
// secret-shaped tokens (some providers echo a key prefix in their error text).
const EVM_ADDRESS_RE = /\b0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
/** Mask EVM addresses and secret-shaped tokens in an operational string; non-strings pass through (null stays null). */
export function redactPublic<T>(v: T): T {
  return (typeof v === "string" ? v.replace(EVM_ADDRESS_RE, "0x[address]").replace(SECRET_MASK_RE, "[secret]") : v) as T;
}

// Provider errors carry a raw response excerpt (SubQ: "http 422 validation_error: {...}", "returned non-JSON: ...";
// Workers AI: "http 500: ..."). An error body can echo the request, and the distiller's request is the fetched page
// text, so on public endpoints the excerpt is cut. The pipeline's own wording around it is kept.
const EXCERPT_RE = /\b(http \d{3}(?: [a-z_]+)?|returned non-JSON|gave no valid JSON after (?:a retry|one try \(no time left to retry\))): /i;
const PIPELINE_TAIL_RE = /\)(?:: (?:raw truncated to 4 KB|facts returned|fallback(?: web_fetch(?: \(URL in task\))?|, nothing chosen)))?$/;
/** An operational string (timing detail, run or agent error) as shown publicly: excerpt cut, addresses and
 * secret-shaped tokens masked, one line, length-capped. Non-strings pass through. */
export function publicText<T>(v: T): T {
  if (typeof v !== "string") return v;
  let s = v.replace(/\s+/g, " ");
  const m = EXCERPT_RE.exec(s);
  if (m) {
    const tail = PIPELINE_TAIL_RE.exec(s.slice(m.index + m[0].length));
    s = `${s.slice(0, m.index)}${m[1]}: [response excerpt hidden]${tail ? tail[0] : ""}`;
  }
  s = redactPublic(s);
  return (s.length > PUBLIC_DETAIL_MAX ? `${s.slice(0, PUBLIC_DETAIL_MAX - 1)}…` : s) as T;
}

/** The answer only when it is the renderer's (a render timing with ok: true) or the pipeline's fixed "nothing to
 * report" text. Otherwise the pipeline put the distilled facts or the raw tool output (fetched page text) there as a
 * stand-in, and that never goes on a public endpoint. */
export function renderedAnswer(r: Pick<RunRecord, "answer" | "timings">): string | null {
  if (typeof r.answer !== "string" || !r.answer) return null;
  if (r.answer === NOTHING_TO_DO) return r.answer;
  const rendered = Array.isArray(r.timings) && r.timings.some((t) => t?.tier === "render" && t.ok === true);
  return rendered ? redactPublic(r.answer) : null;
}

/** Task/surface text as shown publicly. Runs also come from the agent_run tool, which does not apply the swarm task
 * rules, so text that breaks them (credentials, secrets, emails, private hosts, non-public names) is hidden here. */
function publicTask(t: unknown): string {
  const s = typeof t === "string" ? t : "";
  const rule = taskTextRule(s.replace(/\s+/g, " ").trim().slice(0, MAX_TASK_CHARS));
  return rule ? `[task hidden: ${rule}]` : s;
}
function publicSurface(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  return surfaceRule(v.replace(/\s+/g, " ").trim()) ? "[hidden]" : v;
}

/** Reject after `ms` (the store call is not cancelled; its late result is ignored). */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  const call = Promise.resolve(p);
  call.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms); });
  return Promise.race([call, limit]).finally(() => clearTimeout(timer));
}

/** The grid's view of a swarm: whitelisted fields only (never addresses, identities or machines). */
export function publicSwarm(s: SwarmState | null): Record<string, unknown> | null {
  if (!s) return null;
  return {
    swarm_id: s.swarm_id, status: s.status, n: s.n, concurrency: s.concurrency, task_source: s.task_source, task_count: s.task_count,
    payout_addresses: s.payout_addresses === true, started_at: s.started_at, finished_at: s.finished_at, counts: { ...s.counts },
    agents: s.agents.map((a) => ({
      agent_id: a.agent_id, task_id: a.task_id, surface: a.surface, status: a.status, run_id: a.run_id, ms: a.ms, notes_filed: a.notes_filed,
      error: publicText(a.error),
    })),
  };
}

const timingWith = (text: (s: string) => string) => (t: TierTiming) => ({
  tier: t?.tier, ms: t?.ms, ok: t?.ok, ...(typeof t?.detail === "string" ? { detail: text(t.detail) } : {}),
  ...(t?.usage ? { usage: { input_tokens: t.usage.input_tokens, output_tokens: t.usage.output_tokens } } : {}),
});
const publicTiming = timingWith(publicText);
const operatorTiming = timingWith(redactPublic);
/** Only the six tiers, each a number or null (price unknown). */
const publicCost = (c: unknown): RunRecord["cost_micro_usd"] => {
  const out: RunRecord["cost_micro_usd"] = {};
  if (!isObj(c)) return out;
  for (const k of TIERS) {
    const v = c[k];
    if (v === null) out[k] = null;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
};

/** A RunRecord with whitelisted fields only (the store row may carry more columns than the contract): rule-breaking
 * task/surface text hidden, the answer only when rendered, provider excerpts cut, addresses and secrets masked. */
export function publicRun(r: RunRecord): RunRecord {
  return {
    id: r.id, created_at: r.created_at, agent_id: r.agent_id, swarm_id: r.swarm_id, task: publicTask(r.task), surface: publicSurface(r.surface), status: r.status,
    attestation: r.attestation, assets: Array.isArray(r.assets) ? r.assets.map((a) => ({ asset_id: a?.asset_id, p: a?.p })) : [],
    timings: Array.isArray(r.timings) ? r.timings.map(publicTiming) as TierTiming[] : [], raw_bytes: r.raw_bytes, distilled_bytes: r.distilled_bytes,
    cost_micro_usd: publicCost(r.cost_micro_usd), answer: renderedAnswer(r),
    notes_filed: Array.isArray(r.notes_filed) ? r.notes_filed.map(String) : [], error: publicText(r.error), finished_at: r.finished_at,
  };
}

/** What POST /admin/run returns to the operator (who holds the key): the same whitelist, with the answer as recorded
 * (facts or truncated raw output when rendering failed) and provider excerpts kept, so the live server's run can be
 * checked against the providers' wire formats. Addresses and secret-shaped tokens are still masked. */
export function operatorRun(r: RunRecord): RunRecord {
  return {
    ...publicRun(r),
    timings: Array.isArray(r.timings) ? r.timings.map(operatorTiming) as TierTiming[] : [],
    answer: redactPublic(typeof r.answer === "string" ? r.answer : null), error: redactPublic(r.error),
  };
}

export class StoreBusyError extends Error {
  readonly code = "busy";
}

/** Tiny TTL cache with in-flight sharing. Failures are not cached; expired entries are swept; bounded key count. */
function ttlCache<T>(ttlMs: number, maxKeys = 32) {
  const m = new Map<string, { at: number; p: Promise<T> }>();
  return (key: string, f: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    const hit = m.get(key);
    if (hit && now - hit.at < ttlMs) return hit.p;
    for (const [k, v] of m) if (now - v.at >= ttlMs) m.delete(k);
    if (m.size >= maxKeys) m.delete(m.keys().next().value as string); // oldest first
    const p = f();
    m.set(key, { at: now, p });
    p.catch(() => { if (m.get(key)?.p === p) m.delete(key); });
    return p;
  };
}

/** At most `max` store calls in flight from public endpoints, counted until the call itself settles (a timed-out
 * call still holds its slot), so random cache keys or a slow store cannot pile up queries. A call that never settles
 * gives its slot back after `holdMs`, so a few hung calls cannot close the public endpoints until a restart. */
function storeGate(max: number, holdMs = 60_000) {
  let n = 0;
  return <T>(f: () => Promise<T>): Promise<T> => {
    if (n >= max) return Promise.reject(new StoreBusyError("too many store reads in flight"));
    n++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      n--;
      clearTimeout(timer);
    };
    const timer = setTimeout(release, holdMs);
    timer.unref?.();
    let p: Promise<T>;
    try {
      p = Promise.resolve(f());
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(release, release);
    return p;
  };
}

export function registerRuntimeWeb(app: any, deps: RuntimeWebDeps): void {
  const env = deps.env ?? process.env;
  const runner = deps.runner ?? defaultRunner;
  const wallets = deps.wallets === undefined ? createWallets(env) : deps.wallets;
  const tasksOf = deps.loadTasks ?? loadTasks;
  const cacheMs = deps.cacheMs ?? PUBLIC_CACHE_MS;
  const storeMs = deps.storeTimeoutMs ?? PUBLIC_STORE_TIMEOUT_MS;
  let pipeline: Pipeline | null = deps.pipeline ?? null;
  // Lazy: nothing is built until an operator runs something.
  const getPipeline = (): Pipeline => (pipeline ??= createPipeline(deps.store, deps.runtime));
  const runsCache = ttlCache<RunRecord[]>(cacheMs);
  const statsCache = ttlCache<RunStats>(cacheMs);
  const gate = storeGate(deps.maxInFlight ?? PUBLIC_MAX_IN_FLIGHT);
  const budget = deps.budget ?? createRunBudget(runsPerHour(env));
  const adminRunMax = deps.adminRunMaxInFlight ?? ADMIN_RUN_MAX_IN_FLIGHT;
  let adminRuns = 0;
  const overBudget = (c: any, need: number, r: { left: number; retry_after_s: number | null }) => {
    if (r.retry_after_s !== null) c.header("retry-after", String(r.retry_after_s));
    return c.json({
      ok: false, code: "run_budget", runs_left: r.left, runs_per_hour: budget.max, need, retry_after_s: r.retry_after_s,
      hint: budget.max === 0
        ? "Operator runs are turned off (SWARM_RUNS_PER_HOUR=0). Nothing was run."
        : `Operator runs are capped at ${budget.max} per hour (swarm agents + /admin/run) because each one spends provider credits. Nothing was run.`,
    }, 429);
  };

  const seedStatus = (): "configured" | "missing" | "invalid" => {
    try {
      return wallets ? wallets.status() : "missing";
    } catch {
      return "invalid";
    }
  };
  const unauthorized = (c: any) => c.json({ ok: false, code: "unauthorized" }, 401);
  const admin = (c: any) => isAdmin(c.req.header("x-admin-key"), deps.adminKey);
  const body = async (c: any): Promise<Record<string, unknown>> => {
    const b = await c.req.json().catch(() => null);
    return isObj(b) ? b : {};
  };
  const storeError = (c: any, e: unknown, what: string) => {
    if (e instanceof StoreBusyError) {
      c.header("retry-after", "2");
      return c.json({ ok: false, code: "busy" }, 503);
    }
    console.error(`${what} store error:`, short(e));
    return c.json({ ok: false, code: "store_unavailable" }, 503);
  };
  const swarmParam = (c: any): string | undefined | false => {
    const v = c.req.query("swarm_id");
    if (v === undefined || v === "") return undefined;
    return SWARM_ID_RE.test(v) ? v : false;
  };

  app.post("/admin/swarm", async (c: any) => {
    if (!admin(c)) return unauthorized(c);
    const b = await body(c);
    let held: number | null = null;
    try {
      if (runner.busy()) throw new SwarmBusyError(runner.state()?.swarm_id ?? "unknown");
      // Validate n before reserving budget for it (the runner validates again).
      const n = intInRange(b.n, 1, MAX_AGENTS, undefined, "n");
      const loaded = tasksOf();
      const slot = budget.take(n);
      if (!slot.ok) return overBudget(c, n, slot);
      held = slot.id;
      const swarm_id = runner.start({
        n, concurrency: b.concurrency as number | undefined, pipeline: getPipeline, runs: deps.runtime.runs,
        tasks: loaded.tasks, task_source: loaded.source, wallets,
        onFinish: (f) => {
          budget.refund(slot.id, f.counts.stopped); // agents a stop kept from starting spent nothing
          console.log(`[swarm] ${f.swarm_id} ${f.status}: ${f.counts.done} done, ${f.counts.failed} failed, ${f.counts.stopped} stopped`);
        },
      });
      held = null;
      const s = runner.state();
      // "configured" | "missing" | "invalid": tells the operator a mistyped SWARM_SEED (never the seed itself).
      const seedState = seedStatus();
      console.log(`[swarm] started ${swarm_id}: n=${s?.n} concurrency=${s?.concurrency} tasks=${loaded.source}(${loaded.tasks.length}) payout_seed=${seedState} runs_left=${budget.left()}/${budget.max}`);
      return c.json({
        ok: true, swarm_id, n: s?.n, concurrency: s?.concurrency, task_source: loaded.source, task_count: loaded.tasks.length,
        tasks_rejected: loaded.rejected, payout_addresses: s?.payout_addresses === true, payout_seed: seedState,
        runs_left: budget.left(), runs_per_hour: budget.max,
      });
    } catch (e) {
      if (held !== null) budget.refund(held, Number.MAX_SAFE_INTEGER); // the swarm never started
      if (e instanceof SwarmBusyError) return c.json({ ok: false, code: "swarm_running", swarm_id: e.swarm_id, hint: "One swarm at a time. Stop it with POST /admin/swarm/stop or wait." }, 409);
      if (e instanceof SwarmInputError) return c.json({ ok: false, code: "invalid_input", hint: e.message }, 400);
      console.error("[swarm] start failed:", short(e));
      return c.json({ ok: false, code: "swarm_failed", hint: "Could not start the swarm." }, 500);
    }
  });

  app.post("/admin/swarm/stop", async (c: any) => {
    if (!admin(c)) return unauthorized(c);
    const r = runner.stop();
    if (r.stopped) console.log(`[swarm] stop requested for ${r.swarm_id}`);
    return c.json({ ok: true, ...r });
  });

  app.post("/admin/run", async (c: any) => {
    if (!admin(c)) return unauthorized(c);
    const b = await body(c);
    // The task and surface land in the public run log (/api/runs), so they get the swarm task rules: no credentials,
    // secrets, emails, private hosts, invisible characters or prompt injection. Rejections name the rule, never echo
    // the text.
    const task = typeof b.task === "string" && !hasControlChars(b.task) ? b.task.replace(/\s+/g, " ").trim() : "";
    if (!task || task.length > MAX_TASK_CHARS) return c.json({ ok: false, code: "invalid_task", hint: `task must be 1-${MAX_TASK_CHARS} characters of plain text.` }, 400);
    const tRule = taskTextRule(task);
    if (tRule) return c.json({ ok: false, code: "invalid_task", rule: tRule, hint: "The task is public in the run log and goes to the models: remove credentials, secrets, emails, private hosts, invisible characters and instructions aimed at the model." }, 400);
    if (b.surface !== undefined && b.surface !== null && typeof b.surface !== "string") return c.json({ ok: false, code: "invalid_surface", hint: "surface must be a string." }, 400);
    const surface = typeof b.surface === "string" && b.surface.trim() ? b.surface.replace(/\s+/g, " ").trim() : null;
    const sRule = surface ? surfaceRule(surface) : null;
    if (sRule) return c.json({ ok: false, code: "invalid_surface", rule: sRule, hint: `surface must be a public product name, at most ${MAX_SURFACE_CHARS} characters.` }, 400);
    if (adminRuns >= adminRunMax) {
      c.header("retry-after", "10");
      return c.json({ ok: false, code: "busy", hint: `At most ${adminRunMax} admin runs at a time; try again when one finishes. Nothing was run.` }, 429);
    }
    const slot = budget.take(1);
    if (!slot.ok) return overBudget(c, 1, slot);
    const ctx: AgentContext = { agent_id: "admin_run", swarm_id: null, attestation: "unverified", payout_address: null, machine: null, identity: null };
    adminRuns++;
    try {
      const r = await getPipeline().run(task, surface, ctx);
      return c.json(operatorRun(r));
    } catch (e) {
      // Pipeline.run never throws by contract; this is the last line of defence.
      console.error("[admin/run] pipeline error:", short(e));
      return c.json({ ok: false, code: "run_failed", hint: "The run failed before it could be logged." }, 500);
    } finally {
      adminRuns--;
    }
  });

  app.get("/api/swarm", (c: any) => c.json({ swarm: publicSwarm(runner.state()) }));

  app.get("/api/runs", async (c: any) => {
    const raw = c.req.query("limit");
    const n = raw === undefined || raw === "" ? RUNS_DEFAULT_LIMIT : Number(raw);
    const limit = Number.isFinite(n) ? Math.min(RUNS_MAX_LIMIT, Math.max(1, Math.floor(n))) : RUNS_DEFAULT_LIMIT;
    const swarm_id = swarmParam(c);
    if (swarm_id === false) return c.json({ ok: false, code: "invalid_swarm_id" }, 400);
    try {
      const runs = await runsCache(`${limit}|${swarm_id ?? ""}`, () =>
        within(gate(() => deps.runtime.runs.listRuns({ limit, ...(swarm_id ? { swarm_id } : {}) })), storeMs, "list runs").then((rs) => rs.map(publicRun)));
      return c.json({ runs });
    } catch (e) {
      return storeError(c, e, "api runs");
    }
  });

  app.get("/api/runs/stats", async (c: any) => {
    const swarm_id = swarmParam(c);
    if (swarm_id === false) return c.json({ ok: false, code: "invalid_swarm_id" }, 400);
    try {
      return c.json(await statsCache(swarm_id ?? "", () => within(gate(() => deps.runtime.runs.runStats(swarm_id)), storeMs, "run stats")));
    } catch (e) {
      return storeError(c, e, "api run stats");
    }
  });
}
