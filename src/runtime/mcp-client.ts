// Stream A: a tiny MCP client for the runtime's executors. One connected client per URL, reused across calls,
// dropped and reconnected lazily when the connection or session breaks (e.g. after a redeploy restarts the server).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

export interface ToolCallResult {
  /** The tool answered and did not set isError. */
  ok: boolean;
  /** The tool answered with isError, or the call failed in transport. */
  isError: boolean;
  /** structuredContent, else JSON-parsed text content, else the text itself; null on transport failure. */
  data: unknown;
  /** Concatenated text content items. */
  text: string;
  /** Transport/protocol failure message (never includes arguments); null when the tool answered. */
  error: string | null;
  timedOut: boolean;
}

export interface CallOptions {
  timeoutMs?: number;
  /** Safe to resend after an ambiguous failure. Non-idempotent calls retry only when the session was clearly stale. */
  idempotent?: boolean;
}

const pool = new Map<string, Promise<Client>>();

function drop(url: string, p?: Promise<Client>) {
  const cur = pool.get(url);
  if (!cur || (p && cur !== p)) return;
  pool.delete(url);
  cur.then((c) => c.close()).catch(() => {});
}

function getClient(url: string, timeoutMs: number): Promise<Client> {
  const existing = pool.get(url);
  if (existing) return existing;
  const p = (async () => {
    const client = new Client({ name: "aze-runtime", version: "0.1.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: timeoutMs });
    client.onclose = () => drop(url, p);
    return client;
  })();
  pool.set(url, p);
  p.catch(() => { if (pool.get(url) === p) pool.delete(url); });
  return p;
}

const TIMEOUT_CODE = -32001; // ErrorCode.RequestTimeout
const CLOSED_CODE = -32000; // ErrorCode.ConnectionClosed
const codeOf = (e: unknown) => (e as { code?: unknown })?.code;
const textOf = (e: unknown) => {
  const cause = (e as { cause?: { code?: unknown; message?: unknown } })?.cause;
  return `${String((e as Error)?.message ?? e ?? "")} ${String(cause?.code ?? "")} ${String(cause?.message ?? "")}`;
};
const isTimeout = (e: unknown) => codeOf(e) === TIMEOUT_CODE || /timed? ?out/i.test(String((e as Error)?.message ?? ""));

/** How a call failed, which decides whether the shared connection is dropped and whether the call may be resent.
 * - timeout: the tool is slow; the connection is fine (other calls may be in flight on it). Never resent.
 * - protocol: the server answered with a JSON-RPC error (bad params, unknown tool...). Never resent.
 * - stale_session: HTTP 404 (or 400 naming the session): the server refused the request before running it, e.g. after
 *   a redeploy. Reconnect; safe to resend even for non-idempotent tools.
 * - not_delivered: the request never left (connection refused, DNS, client not connected). Reconnect; safe to resend.
 * - http: another HTTP status (5xx, 401...). The session is fine; only idempotent calls are resent.
 * - connection: ambiguous (reset mid-request, closed): the tool may have run. Reconnect; only idempotent calls resent. */
export type CallFailure = "timeout" | "protocol" | "stale_session" | "not_delivered" | "http" | "connection";
export function classifyError(e: unknown): CallFailure {
  const c = codeOf(e);
  if (isTimeout(e)) return "timeout";
  if (typeof c === "number" && c < 0 && c !== CLOSED_CODE) return "protocol";
  if (c === 404 || (c === 400 && /session/i.test(textOf(e)))) return "stale_session";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|not connected/i.test(textOf(e))) return "not_delivered";
  if (typeof c === "number" && c >= 400 && c < 600) return "http";
  return "connection";
}
const SAFE_TO_RESEND = new Set<CallFailure>(["stale_session", "not_delivered"]);

export function parseToolResult(r: unknown): Pick<ToolCallResult, "data" | "text" | "isError"> {
  const res = (r ?? {}) as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; isError?: boolean; toolResult?: unknown };
  const text = Array.isArray(res.content) ? res.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n") : "";
  let data: unknown = res.structuredContent ?? null;
  if (data === null && text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (data === null && res.toolResult !== undefined) data = res.toolResult; // legacy compatibility shape
  return { data, text, isError: res.isError === true };
}

/** Call one MCP tool. Never throws: transport failures come back as { ok: false, isError: true, error }. */
export async function callTool(url: string, name: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<ToolCallResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const idempotent = opts.idempotent ?? true;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let p: Promise<Client> | undefined;
    try {
      p = getClient(url, timeoutMs);
      const client = await p;
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
      const parsed = parseToolResult(r);
      return { ok: !parsed.isError, isError: parsed.isError, data: parsed.data, text: parsed.text, error: null, timedOut: false };
    } catch (e) {
      lastErr = e;
      const kind = classifyError(e);
      if (kind === "timeout" || kind === "protocol") break;
      // Dropping closes the shared client, which aborts other calls in flight on it: only when the connection is bad.
      if (kind !== "http") drop(url, p);
      // A non-idempotent call (notes_file) is resent only when the server certainly did not run it (no duplicate notes).
      if (!idempotent && !SAFE_TO_RESEND.has(kind)) break;
    }
  }
  const timedOut = isTimeout(lastErr);
  const msg = String((lastErr as Error)?.message ?? lastErr ?? "unknown error").replace(/\s+/g, " ").slice(0, 200);
  return { ok: false, isError: true, data: null, text: "", error: timedOut ? `timed out after ${timeoutMs / 1000} s` : msg, timedOut };
}

/** List tool names (for diags). Throws on failure. */
export async function listTools(url: string, opts: { timeoutMs?: number } = {}): Promise<{ names: string[]; raw: unknown }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    let p: Promise<Client> | undefined;
    try {
      p = getClient(url, timeoutMs);
      const r = await (await p).listTools(undefined, { timeout: timeoutMs });
      return { names: (r.tools ?? []).map((t) => t.name), raw: r };
    } catch (e) {
      const kind = classifyError(e);
      if (kind === "timeout" || kind === "protocol" || attempt >= 1) throw e;
      if (kind !== "http") drop(url, p);
    }
  }
}

/** Close every pooled client (tests, shutdown). */
export async function closeAll(): Promise<void> {
  const all = [...pool.values()];
  pool.clear();
  await Promise.all(all.map((p) => p.then((c) => c.close()).catch(() => {})));
}
