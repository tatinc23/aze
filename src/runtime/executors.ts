// Stream A: executors for aze (MCP to self), mcp (other MCP servers), http_fetch; S3 adds instabox, inkbox.
// Side-effect free: nothing connects until a step runs or /admin/diag calls a check.
import { isIP } from "node:net";
import { createClient } from "@supabase/supabase-js";
import type { Store } from "../types.js";
import { callTool, listTools, type ToolCallResult } from "./mcp-client.js";
import { createHttpFetchExecutor, formatFetch, isBlockedAddress, isPrivateHostName, safeFetch, truncateBytes, OUTPUT_MAX_BYTES } from "./fetch.js";
import type { AgentContext, Asset, Executor, ExecutorKind, ProviderDiag, StepResult } from "./types.js";

export const AZE_TOOL_TIMEOUT_MS = 30_000;
export const MCP_TOOL_TIMEOUT_MS = 30_000;
/** Aze tools the runtime must never call: agents in the swarm don't pay, and agent_run would recurse. */
const AZE_FORBIDDEN = new Set(["notes_unlock", "agent_run"]);
const DIAG_EXCERPT = 500;

export const selfMcpUrl = (env: NodeJS.ProcessEnv) => `http://localhost:${env.PORT ?? 3000}/mcp`;

const out = (v: unknown) => truncateBytes(typeof v === "string" ? v : JSON.stringify(v ?? null), OUTPUT_MAX_BYTES);

/** Short, argument-free error for a tool result: the structured `code` (and hint) when the tool gave one. */
function toolError(r: ToolCallResult): string {
  if (r.error) return r.error;
  const d = r.data as Record<string, unknown> | null;
  if (d && typeof d === "object" && typeof d.code === "string") return d.code;
  return (r.text || "tool returned an error").replace(/\s+/g, " ").slice(0, 160);
}

function step(asset: Asset, r: ToolCallResult, ms: number, friction: boolean): StepResult {
  return {
    asset_id: asset.id, ok: r.ok, ms, friction,
    output: out(r.data ?? r.text),
    error: r.ok ? null : toolError(r),
  };
}

/** Aze's own tools over the real MCP surface (so the privacy gate + Snap audit apply to notes the runtime files). */
export function createAzeExecutor(url: string): Executor {
  return {
    async execute(asset: Asset, args: Record<string, unknown>, ctx: AgentContext): Promise<StepResult> {
      const name = asset.tool_name ?? asset.id;
      if (AZE_FORBIDDEN.has(name)) return { asset_id: asset.id, ok: false, output: "", ms: 0, error: `${name} is not callable by the runtime`, friction: false };
      const a = { ...(args ?? {}) };
      if (name === "notes_file") {
        delete a.payout_address; // only the agent's own address, from its context, never model output
        delete a.proof;
        if (ctx.payout_address) a.payout_address = ctx.payout_address;
      }
      const t0 = Date.now();
      // notes_file is not idempotent: never resend it after an ambiguous failure.
      const r = await callTool(url, name, a, { timeoutMs: AZE_TOOL_TIMEOUT_MS, idempotent: name !== "notes_file" });
      return step(asset, r, Date.now() - t0, false); // Aze can't file friction about itself through itself
    },
  };
}

/** An MCP endpoint the "mcp" executor may call: https, no credentials, not a private IP literal or private host name.
 * Catalog rows are operator-controlled; this is defense in depth (the SDK's fetch resolves DNS itself, unpinned).
 * http(s)://localhost only with the test-only flag (never wired to env). */
export function allowedEndpoint(e: string | null, allowLocalhostForTests = false): URL | null {
  if (!e) return null;
  let u: URL;
  try { u = new URL(e); } catch { return null; }
  if (u.username || u.password) return null;
  const host = (u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname).toLowerCase().replace(/\.+$/, "");
  if (host === "localhost" || host === "127.0.0.1") return allowLocalhostForTests && (u.protocol === "http:" || u.protocol === "https:") ? u : null;
  if (u.protocol !== "https:") return null;
  if (isIP(host) ? isBlockedAddress(host) : isPrivateHostName(host)) return null;
  return u;
}

/** Another MCP server's tool (asset.endpoint, asset.tool_name ?? asset.id). */
export function createMcpExecutor(opts: { allowLocalhostForTests?: boolean } = {}): Executor {
  return {
    async execute(asset: Asset, args: Record<string, unknown>): Promise<StepResult> {
      const u = allowedEndpoint(asset.endpoint, opts.allowLocalhostForTests === true);
      if (!u) return { asset_id: asset.id, ok: false, output: "", ms: 0, error: "asset has no valid https MCP endpoint", friction: false };
      const t0 = Date.now();
      // A third-party tool may have side effects (send, create...): resend only when it certainly did not run.
      const r = await callTool(u.toString(), asset.tool_name ?? asset.id, args ?? {}, { timeoutMs: MCP_TOOL_TIMEOUT_MS, idempotent: false });
      // Timeouts, unreachable servers and tool errors are all friction an agent would hit.
      return step(asset, r, Date.now() - t0, !r.ok);
    },
  };
}

/** Placeholder until S3 wires the provider (after the API docs arrive). */
const notConfigured = (): Executor => ({
  async execute(asset: Asset): Promise<StepResult> {
    return { asset_id: asset.id, ok: false, output: "", ms: 0, error: "not configured", friction: false };
  },
});

const refuse = (asset: Asset, error: string): StepResult => ({ asset_id: asset.id, ok: false, output: "", ms: 0, error, friction: false });

/** INKBOX_SEND_ALLOW: comma-separated recipient handles (leading @ and case ignored). Empty or unset = no send. */
export function sendAllowlist(env: NodeJS.ProcessEnv): Set<string> {
  return new Set((env.INKBOX_SEND_ALLOW ?? "").split(",").map((h) => h.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));
}

/** inkbox_send only reaches allowlisted recipients. A refusal logs the rule, never the recipient or the text. */
export function guardInkboxSend(inner: Executor, env: NodeJS.ProcessEnv): Executor {
  const allow = sendAllowlist(env);
  return {
    async execute(asset: Asset, args: Record<string, unknown>, ctx: AgentContext): Promise<StepResult> {
      if (asset.id !== "inkbox_send") return inner.execute(asset, args, ctx);
      const to = typeof args.to === "string" ? args.to.trim().replace(/^@/, "").toLowerCase() : "";
      if (!allow.size || !allow.has(to)) {
        console.warn(`INKBOX send refused: ${allow.size ? "recipient not in INKBOX_SEND_ALLOW" : "INKBOX_SEND_ALLOW unset"}`);
        return refuse(asset, "recipient not allowed");
      }
      return inner.execute(asset, args, ctx);
    },
  };
}

/** Instabox box ids come from INSTABOX_BOX_ID only: a step that names a box is refused, and no env id = no exec. */
export function guardInstabox(inner: Executor, env: NodeJS.ProcessEnv): Executor {
  const boxId = env.INSTABOX_BOX_ID?.trim() ?? "";
  return {
    async execute(asset: Asset, args: Record<string, unknown>, ctx: AgentContext): Promise<StepResult> {
      if (Object.keys(args).some((k) => /box/i.test(k))) return refuse(asset, "box id comes from env only");
      if (!boxId) return refuse(asset, "not configured");
      return inner.execute(asset, args, ctx);
    },
  };
}

const excerpt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? null)).slice(0, DIAG_EXCERPT);

type DbRes = { data: unknown; error: { message: string } | null; count?: number | null };
/** supabase-warehouse diag detail: counts, asset ids, and the JS types the newest run's jsonb columns come back as
 * (the run store assumes arrays/objects, tolerating strings), so the live diag verifies that wire assumption. */
export function warehouseDetail(a: DbRes, r: DbRes): Record<string, unknown> {
  const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const newest = Array.isArray(r.data) && r.data[0] && typeof r.data[0] === "object" ? (r.data[0] as Record<string, unknown>) : null;
  return {
    warehouse_assets: a.error ? { error: a.error.message } : { count: a.count ?? null, ids: (Array.isArray(a.data) ? a.data : []).map((x) => (x as { id?: unknown })?.id) },
    runs: r.error ? { error: r.error.message } : {
      count: r.count ?? null,
      newest: newest ? { status: newest.status, timings: kind(newest.timings), cost_micro_usd: kind(newest.cost_micro_usd), notes_filed: kind(newest.notes_filed) } : null,
    },
  };
}

export function createExecutors(env: NodeJS.ProcessEnv, _store: Store): { executors: Partial<Record<ExecutorKind, Executor>>; diags: ProviderDiag[] } {
  const self = selfMcpUrl(env);
  const executors: Partial<Record<ExecutorKind, Executor>> = {
    aze: createAzeExecutor(self),
    mcp: createMcpExecutor(),
    http_fetch: createHttpFetchExecutor(),
    instabox: guardInstabox(notConfigured(), env),
    inkbox: guardInkboxSend(notConfigured(), env),
  };
  const diags: ProviderDiag[] = [
    {
      name: "aze-mcp-self",
      async check() {
        const t0 = Date.now();
        const { names, raw } = await listTools(self, { timeoutMs: 10_000 });
        const ok = names.includes("notes_query") && names.includes("notes_file");
        return { ok, detail: excerpt({ tools: names, raw: excerpt(raw) }), ms: Date.now() - t0 };
      },
    },
    {
      // Proves outbound HTTPS + the pinned-DNS transport work from the live machine. No credits spent.
      name: "http-fetch",
      async check() {
        const t0 = Date.now();
        const r = await safeFetch("https://example.com/");
        return { ok: r.ok, detail: excerpt(formatFetch(r)), ms: Date.now() - t0 };
      },
    },
  ];
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
    diags.push({
      // Proves migration 0003 is applied (warehouse_assets + runs readable by the service role).
      name: "supabase-warehouse",
      async check() {
        const t0 = Date.now();
        const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
        const [a, r] = await Promise.all([
          db.from("warehouse_assets").select("id", { count: "exact" }).limit(20),
          db.from("runs").select("status, timings, cost_micro_usd, notes_filed", { count: "exact" }).order("created_at", { ascending: false }).limit(1),
        ]);
        return { ok: !a.error && !r.error, detail: excerpt(warehouseDetail(a, r)), ms: Date.now() - t0 };
      },
    });
  }
  return { executors, diags };
}
