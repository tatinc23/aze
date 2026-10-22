// Contracts for the Aze runtime. Change them only together with every implementer. Since 2026-10-20 a run is
// decide-only: check the map → SubQ Snap picks tools → the decisions and advisories go back to the caller, whose own
// LLM runs the tools and writes the answer. Aze does not fill inputs, run tools, distill, answer or draft notes.
import type { Advisory, Attestation, CleanNote, Match, NoteAudit } from "../types.js";

export type { NoteAudit };

/** How an asset is executed. */
export type ExecutorKind = "aze" | "mcp" | "http_fetch" | "instabox" | "inkbox";

/** One row of the warehouse catalog (Supabase `warehouse_assets`). */
export interface Asset {
  id: string; // stable id, e.g. "notes_query", "web_fetch", "instabox_exec"
  kind: "mcp_tool" | "fetch" | "sandbox" | "comms";
  executor: ExecutorKind;
  description: string; // one plain sentence (Muse M6); Snap reads it
  input_schema: Record<string, unknown>; // JSON Schema of the arguments
  endpoint: string | null; // MCP URL for executor "mcp"; null for in-house executors
  tool_name: string | null; // MCP tool name when it differs from id
  active: boolean;
}

/** Who is running and what they may use. */
export interface AgentContext {
  agent_id: string; // "swarm-007", "sammy"
  swarm_id: string | null;
  attestation: Attestation;
  payout_address: string | null; // filer earnings address (HD-derived for swarm agents)
  machine: string | null; // Instabox machine name, if this agent has a computer
  identity: string | null; // Inkbox identity handle, if any (never logged into notes)
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/** A tool Snap may pick: the caller's own tools (agent_run) or warehouse catalog assets (swarm, /admin/run). */
export interface Candidate {
  id: string; // tool name
  description: string; // one short sentence; Snap reads it
  active?: boolean;
  /** Public service the tool belongs to; its map check (notes_query) runs before Snap decides. */
  surface?: string | null;
}

/** SubQ Snap decides which candidate tools a task needs, with a probability for each. `detail` (optional) is shown
 * in the run's snap timing; `label` names the deciding model in agent_run's `decided_by`. */
export interface Router {
  readonly label?: string;
  route(task: string, candidates: Candidate[]): Promise<{ choices: Array<{ asset_id: string; p: number }>; ms: number; usage: Usage; detail?: string }>;
}

/** Snap audit of a note that already passed the rule-based gate. Must never throw; fail open with status "skipped". */
export interface NoteAuditor {
  audit(note: CleanNote, similar: Match[]): Promise<NoteAudit>;
}

/** Executor contracts (unused by the decide-only pipeline; kept with src/runtime/executors.ts until Ken decides). */
export interface StepResult {
  asset_id: string;
  ok: boolean;
  output: string; // text (truncated to 20 KB by the executor)
  ms: number;
  error: string | null;
  friction: boolean; // executor's judgment: blocked/slow/confusing (feeds NoteWriter)
}

export interface Executor {
  execute(asset: Asset, args: Record<string, unknown>, ctx: AgentContext): Promise<StepResult>;
}

/** One provider health check for /admin/diag (runs on Manufact, which can reach the providers). */
export interface ProviderDiag {
  name: string;
  check(): Promise<{ ok: boolean; detail: string; ms: number }>;
}

/** "notes" = the map check (notes_query lookup); "snap" = the routing decision. Runs before 2026-10-20 also hold
 * args/execute/distill/render timings; readers skip tiers they do not know. */
export type Tier = "notes" | "snap";

export interface TierTiming {
  tier: Tier;
  ms: number;
  ok: boolean;
  detail?: string;
  usage?: Usage;
}

/** A run as stored in Supabase `runs`. Only public task text and classes; no identities, keys or private data. */
export interface RunRecord {
  id: string;
  created_at: string;
  agent_id: string;
  swarm_id: string | null;
  task: string;
  surface: string | null;
  status: "running" | "done" | "failed";
  attestation: Attestation;
  assets: Array<{ asset_id: string; p: number }>;
  timings: TierTiming[];
  raw_bytes: number | null; // legacy column (runs that distilled); null for decide-only runs
  distilled_bytes: number | null; // legacy column; null for decide-only runs
  cost_micro_usd: Partial<Record<Tier, number | null>>; // null = price unknown; never invented
  answer: string | null; // legacy column (runs that rendered an answer); null for decide-only runs
  notes_filed: string[]; // note ids
  error: string | null;
  finished_at: string | null;
}

export type NewRun = Pick<RunRecord, "agent_id" | "swarm_id" | "task" | "surface" | "attestation">;

export interface RunStats {
  runs: number;
  done: number;
  failed: number;
  running: number;
  notes_filed: number;
  avg_ms_by_tier: Partial<Record<Tier, number>>;
  cost_micro_usd_by_tier: Partial<Record<Tier, number>>;
  compression_ratio: number | null; // legacy: distilled_bytes / raw_bytes over runs that distilled (null since 2026-10-20)
}

export interface RunStore {
  listAssets(): Promise<Asset[]>;
  upsertAssets(assets: Asset[]): Promise<void>;
  insertRun(r: NewRun): Promise<RunRecord>;
  finishRun(id: string, patch: Partial<Omit<RunRecord, "id" | "created_at">>): Promise<void>;
  listRuns(opts: { swarm_id?: string; limit: number }): Promise<RunRecord[]>;
  runStats(swarm_id?: string): Promise<RunStats>;
}

/** A known issue that applies to a candidate tool, from the map check of its service. */
export interface ToolAdvisory extends Advisory {
  surface: string;
}

/** What a run decided, returned to the caller (not stored: the run log keeps only the chosen tools and timings). */
export interface Decision {
  /** The router's label, e.g. "SubQ Snap (subq-snap-preview)"; null when it was unavailable or failed (nothing ranked). */
  decided_by: string | null;
  /** Every candidate Snap scored, highest p first. */
  scores: Array<{ tool: string; p: number }>;
  /** Known issues for the chosen tools (or, when nothing could be ranked, for every candidate), deduped by note_id. */
  advisories: ToolAdvisory[];
  /** One line for the caller's LLM: run the tools yourself, then file friction with notes_file. */
  next: string;
}

export type RunResult = RunRecord & { decision: Decision };

/** The whole pipeline. `tools` are the caller's candidates; without them the warehouse catalog is used. */
export interface Pipeline {
  run(task: string, surface: string | null, ctx: AgentContext, tools?: Candidate[]): Promise<RunResult>;
}

/** A settled x402 unlock, as recorded in our ledger. */
export interface SettledUnlock { note_id: string; tx_hash: string; network: string; amount_micro: number }

/** Stripe machine payments (stream D) plug in here so app.ts never changes. All optional. */
export interface PaymentsPlugin {
  /** Called after our ledger rows are written for an x402 settlement (D1: record it in Stripe). Must never throw. */
  onSettled?: (s: SettledUnlock) => Promise<void>;
  /** Extra MCP tools, e.g. a card unlock via MPP (D2). `server` is the mcp-use MCPServer. */
  registerTools?: (server: any, deps: { store: import("../types.js").Store }) => void;
  /** Extra HTTP routes, e.g. the MPP payment endpoint. `app` is the Hono app. */
  registerRoutes?: (app: any, deps: { store: import("../types.js").Store; baseUrl?: string }) => void;
}

/** Everything the runtime needs, built once at boot by src/runtime/deps.ts. Missing providers are null. */
export interface RuntimeDeps {
  runs: RunStore;
  router: Router | null;
  auditor: NoteAuditor | null;
  diags: ProviderDiag[];
  payments: PaymentsPlugin | null;
}
