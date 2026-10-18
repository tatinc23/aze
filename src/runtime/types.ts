// Frozen contracts for the Agent Warehouse runtime (S0). Each stream implements one side of these; change them only
// together with every implementer. The pipeline: identity → Snap route → args → execute → distill → render → notes.
import type { Attestation, CleanNote, Match, NoteAudit } from "../types.js";

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

/** Tier 1: System One models (SubQ Snap, plus Workers AI when configured) decide which assets a task needs.
 * `detail` (optional) is shown in the run's snap timing, e.g. each model's vote. */
export interface Router {
  route(task: string, assets: Asset[]): Promise<{ choices: Array<{ asset_id: string; p: number }>; ms: number; usage: Usage; detail?: string }>;
}

/** SubQ generative model: tool arguments, compressed facts, and friction notes. */
export interface ArgFiller {
  fill(task: string, asset: Asset, prior: StepResult[]): Promise<{ args: Record<string, unknown>; ms: number; usage: Usage }>;
}
export interface Distiller {
  distill(task: string, raw: string): Promise<{ facts: string; ms: number; usage: Usage }>;
}
export interface NoteWriter {
  /** Turn a failed/slow step into a field-note input in classes, never names. Returns null if nothing worth filing. */
  write(task: string, surface: string, step: StepResult): Promise<{ note: Record<string, unknown> | null; ms: number; usage: Usage }>;
}

/** Tier 3: Workers AI writes the final answer from distilled facts only. */
export interface Renderer {
  render(task: string, facts: string): Promise<{ text: string; model: string; fallback_used: boolean; ms: number; usage: Usage }>;
}

/** Snap audit of a note that already passed the rule-based gate. Must never throw; fail open with status "skipped". */
export interface NoteAuditor {
  audit(note: CleanNote, similar: Match[]): Promise<NoteAudit>;
}

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

export type Tier = "snap" | "args" | "execute" | "distill" | "render" | "notes";

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
  raw_bytes: number | null;
  distilled_bytes: number | null;
  cost_micro_usd: Partial<Record<Tier, number | null>>; // null = price unknown; never invented
  answer: string | null;
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
  compression_ratio: number | null; // distilled_bytes / raw_bytes over finished runs
}

export interface RunStore {
  listAssets(): Promise<Asset[]>;
  upsertAssets(assets: Asset[]): Promise<void>;
  insertRun(r: NewRun): Promise<RunRecord>;
  finishRun(id: string, patch: Partial<Omit<RunRecord, "id" | "created_at">>): Promise<void>;
  listRuns(opts: { swarm_id?: string; limit: number }): Promise<RunRecord[]>;
  runStats(swarm_id?: string): Promise<RunStats>;
}

/** The whole pipeline. */
export interface Pipeline {
  run(task: string, surface: string | null, ctx: AgentContext): Promise<RunRecord>;
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
  args: ArgFiller | null;
  distiller: Distiller | null;
  noteWriter: NoteWriter | null;
  renderer: Renderer | null;
  auditor: NoteAuditor | null;
  executors: Partial<Record<ExecutorKind, Executor>>;
  diags: ProviderDiag[];
  payments: PaymentsPlugin | null;
  /** Which chat model backs args / distiller / notes (ARGS_BACKEND); shown on the RUNTIME providers line. */
  chatBackend?: "workers-ai" | "subq";
}
