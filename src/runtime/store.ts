// Stream A: the run store. Supabase (tables warehouse_assets + runs, migration 0003) when configured, else memory.
// Runs hold only public task text, classes, timings and costs: never identities, keys, payout addresses.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Asset, ExecutorKind, NewRun, RunRecord, RunStats, RunStore, Tier, TierTiming } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_LIST = 500;
const clampList = (n: number) => Math.min(MAX_LIST, Math.max(1, Math.floor(n) || 1));
const TIERS: readonly Tier[] = ["snap", "args", "execute", "distill", "render", "notes"];

/** Pure stats over runs. avg_ms_by_tier: per run, the sum of that tier's ok timings (failed/unavailable entries are
 * excluded so fallbacks don't pull averages toward 0), averaged over runs that have one. cost: sums per tier, nulls
 * skipped (a tier with no known cost is absent). compression: sum distilled / sum raw over done runs with both. */
export function computeRunStats(runs: Array<Pick<RunRecord, "status" | "timings" | "raw_bytes" | "distilled_bytes" | "cost_micro_usd" | "notes_filed">>): RunStats {
  const msSum: Partial<Record<Tier, number>> = {};
  const msRuns: Partial<Record<Tier, number>> = {};
  const cost: Partial<Record<Tier, number>> = {};
  let raw = 0, distilled = 0, notes = 0, done = 0, failed = 0, running = 0;
  for (const r of runs) {
    if (r.status === "done") done++;
    else if (r.status === "failed") failed++;
    else running++;
    notes += Array.isArray(r.notes_filed) ? r.notes_filed.length : 0;
    const perRun: Partial<Record<Tier, number>> = {};
    for (const t of Array.isArray(r.timings) ? r.timings : []) {
      if (!t || t.ok === false || !TIERS.includes(t.tier) || !Number.isFinite(Number(t.ms))) continue;
      perRun[t.tier] = (perRun[t.tier] ?? 0) + Number(t.ms);
    }
    for (const [tier, ms] of Object.entries(perRun) as Array<[Tier, number]>) {
      msSum[tier] = (msSum[tier] ?? 0) + ms;
      msRuns[tier] = (msRuns[tier] ?? 0) + 1;
    }
    for (const [tier, c] of Object.entries(r.cost_micro_usd ?? {}) as Array<[Tier, number | null]>) {
      if (!TIERS.includes(tier) || c === null || c === undefined || !Number.isFinite(Number(c))) continue;
      cost[tier] = (cost[tier] ?? 0) + Number(c);
    }
    if (r.status === "done" && r.raw_bytes !== null && r.distilled_bytes !== null && Number(r.raw_bytes) > 0) {
      raw += Number(r.raw_bytes);
      distilled += Number(r.distilled_bytes);
    }
  }
  const avg: Partial<Record<Tier, number>> = {};
  for (const tier of Object.keys(msSum) as Tier[]) avg[tier] = Math.round(msSum[tier]! / msRuns[tier]!);
  for (const tier of Object.keys(cost) as Tier[]) cost[tier] = Math.round(cost[tier]! * 10_000) / 10_000;
  return {
    runs: runs.length, done, failed, running, notes_filed: notes,
    avg_ms_by_tier: avg, cost_micro_usd_by_tier: cost,
    compression_ratio: raw > 0 ? distilled / raw : null,
  };
}

function newRecord(r: NewRun, id: string = randomUUID(), created_at = new Date().toISOString()): RunRecord {
  return {
    id, created_at, agent_id: r.agent_id, swarm_id: r.swarm_id ?? null, task: r.task, surface: r.surface ?? null,
    status: "running", attestation: r.attestation === "verified" ? "verified" : "unverified",
    assets: [], timings: [], raw_bytes: null, distilled_bytes: null, cost_micro_usd: {}, answer: null, notes_filed: [],
    error: null, finished_at: null,
  };
}

const PATCH_KEYS = [
  "agent_id", "swarm_id", "task", "surface", "status", "attestation", "assets", "timings", "raw_bytes", "distilled_bytes",
  "cost_micro_usd", "answer", "notes_filed", "error", "finished_at",
] as const satisfies ReadonlyArray<keyof RunRecord>;
type Patch = Partial<Omit<RunRecord, "id" | "created_at">>;
function pickPatch(p: Patch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PATCH_KEYS) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

const cloneAsset = (a: Asset): Asset => ({ ...a, input_schema: structuredClone(a.input_schema ?? {}) });

export class MemoryRunStore implements RunStore {
  readonly kind = "memory" as const;
  private assets = new Map<string, Asset>();
  private runs: RunRecord[] = []; // newest last
  constructor(private readonly maxRuns = 5000) {}

  async listAssets(): Promise<Asset[]> {
    return [...this.assets.values()].sort((a, b) => a.id.localeCompare(b.id)).map(cloneAsset);
  }
  async upsertAssets(assets: Asset[]): Promise<void> {
    for (const a of assets) this.assets.set(a.id, cloneAsset(a));
  }
  async insertRun(r: NewRun): Promise<RunRecord> {
    const rec = newRecord(r);
    this.runs.push(rec);
    if (this.runs.length > this.maxRuns) this.runs.splice(0, this.runs.length - this.maxRuns);
    return structuredClone(rec);
  }
  async finishRun(id: string, patch: Patch): Promise<void> {
    const rec = this.runs.find((r) => r.id === id);
    if (rec) Object.assign(rec, structuredClone(pickPatch(patch)));
  }
  async listRuns(opts: { swarm_id?: string; limit: number }): Promise<RunRecord[]> {
    const out: RunRecord[] = [];
    for (let i = this.runs.length - 1; i >= 0 && out.length < clampList(opts.limit); i--) {
      const r = this.runs[i];
      if (opts.swarm_id === undefined || r.swarm_id === opts.swarm_id) out.push(structuredClone(r));
    }
    return out;
  }
  async runStats(swarm_id?: string): Promise<RunStats> {
    return computeRunStats(swarm_id === undefined ? this.runs : this.runs.filter((r) => r.swarm_id === swarm_id));
  }
}

// --- Supabase ------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};
const jsonish = <T>(v: unknown, fallback: T): T => {
  if (typeof v === "string") {
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }
  return (v ?? fallback) as T;
};
const arr = <T>(v: unknown): T[] => {
  const x = jsonish<unknown>(v, []);
  return Array.isArray(x) ? (x as T[]) : [];
};
const STATUS = new Set(["running", "done", "failed"]);
const EXECUTORS = new Set<ExecutorKind>(["aze", "mcp", "http_fetch", "instabox", "inkbox"]);
const KINDS = new Set<Asset["kind"]>(["mcp_tool", "fetch", "sandbox", "comms"]);

export function toRun(r: Row): RunRecord {
  const cost = jsonish<unknown>(r.cost_micro_usd, {});
  return {
    id: String(r.id),
    created_at: iso(r.created_at) ?? new Date(0).toISOString(),
    agent_id: String(r.agent_id ?? ""),
    swarm_id: str(r.swarm_id),
    task: String(r.task ?? ""),
    surface: str(r.surface),
    status: STATUS.has(String(r.status)) ? (r.status as RunRecord["status"]) : "running",
    attestation: r.attestation === "verified" ? "verified" : "unverified",
    assets: arr<{ asset_id: string; p: number }>(r.assets),
    timings: arr<TierTiming>(r.timings),
    raw_bytes: num(r.raw_bytes),
    distilled_bytes: num(r.distilled_bytes),
    cost_micro_usd: cost && typeof cost === "object" && !Array.isArray(cost) ? (cost as RunRecord["cost_micro_usd"]) : {},
    answer: str(r.answer),
    notes_filed: arr<unknown>(r.notes_filed).map(String),
    error: str(r.error),
    finished_at: iso(r.finished_at),
  };
}

export function toAsset(r: Row): Asset | null {
  const executor = String(r.executor) as ExecutorKind;
  const kind = String(r.kind) as Asset["kind"];
  if (!r.id || !EXECUTORS.has(executor) || !KINDS.has(kind)) return null;
  const schema = jsonish<unknown>(r.input_schema, {});
  return {
    id: String(r.id), kind, executor, description: String(r.description ?? ""),
    input_schema: schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as Record<string, unknown>) : {},
    endpoint: str(r.endpoint), tool_name: str(r.tool_name), active: r.active !== false,
  };
}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`supabase ${what}: ${res.error.message}`);
  return res.data;
}

const STATS_PAGE = 1000; // PostgREST's default max-rows on Supabase
const STATS_MAX_PAGES = 5;

export class SupabaseRunStore implements RunStore {
  readonly kind = "supabase" as const;
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string, db?: SupabaseClient) {
    this.db = db ?? createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async listAssets(): Promise<Asset[]> {
    const rows = (check(await this.db.from("warehouse_assets").select("*").order("id", { ascending: true }), "list assets") ?? []) as Row[];
    return rows.map(toAsset).filter((a): a is Asset => a !== null);
  }

  async upsertAssets(assets: Asset[]): Promise<void> {
    if (!assets.length) return;
    const now = new Date().toISOString();
    const rows = assets.map((a) => ({
      id: a.id, kind: a.kind, executor: a.executor, description: a.description, input_schema: a.input_schema ?? {},
      endpoint: a.endpoint, tool_name: a.tool_name, active: a.active, updated_at: now,
    }));
    check(await this.db.from("warehouse_assets").upsert(rows, { onConflict: "id" }), "upsert assets");
  }

  async insertRun(r: NewRun): Promise<RunRecord> {
    const row = check(
      await this.db.from("runs").insert({
        agent_id: r.agent_id, swarm_id: r.swarm_id ?? null, task: r.task, surface: r.surface ?? null,
        attestation: r.attestation === "verified" ? "verified" : "unverified",
      }).select("*").single(),
      "insert run",
    ) as Row;
    return toRun(row);
  }

  async finishRun(id: string, patch: Patch): Promise<void> {
    if (!UUID.test(id)) return;
    const p = pickPatch(patch);
    if (!Object.keys(p).length) return;
    check(await this.db.from("runs").update(p).eq("id", id), "finish run");
  }

  async listRuns(opts: { swarm_id?: string; limit: number }): Promise<RunRecord[]> {
    let q = this.db.from("runs").select("*");
    if (opts.swarm_id !== undefined) q = q.eq("swarm_id", opts.swarm_id);
    const rows = (check(await q.order("created_at", { ascending: false }).limit(clampList(opts.limit)), "list runs") ?? []) as Row[];
    return rows.map(toRun);
  }

  /** Stats over the newest ≤ 5000 runs (paged; Supabase caps one response at 1000 rows). */
  async runStats(swarm_id?: string): Promise<RunStats> {
    const all: RunRecord[] = [];
    for (let page = 0; page < STATS_MAX_PAGES; page++) {
      let q = this.db.from("runs").select("id, status, timings, raw_bytes, distilled_bytes, cost_micro_usd, notes_filed");
      if (swarm_id !== undefined) q = q.eq("swarm_id", swarm_id);
      const from = page * STATS_PAGE;
      const rows = (check(await q.order("created_at", { ascending: false }).range(from, from + STATS_PAGE - 1), "run stats") ?? []) as Row[];
      all.push(...rows.map(toRun));
      if (rows.length < STATS_PAGE) break;
    }
    return computeRunStats(all);
  }
}

/** Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set, else memory. Side-effect free (no network). */
export function createRunStore(env: NodeJS.ProcessEnv = process.env): RunStore {
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    try {
      return new SupabaseRunStore(url, key);
    } catch (e) {
      // e.g. a malformed SUPABASE_URL: createClient throws. Keep booting; the run log is memory-only until fixed.
      console.error("[runtime] run store: supabase client failed, using memory:", String((e as Error)?.message ?? e).slice(0, 120));
    }
  }
  return new MemoryRunStore();
}
