// Inkbox A2A: Aze has its own Inkbox agent identity (INKBOX_HANDLE, default "aze"). Other Inkbox agents send it A2A
// tasks in plain text:
//   check <service>          -> the free advisory (same lookup as notes_query)
//   file {"kind":...}        -> a field note (same privacy gate + audit as notes_file), filed VERIFIED: Inkbox, not the
//                               caller, sets an A2A task's caller identity. The caller's handle never goes on the note.
// POST /inkbox/webhook. A delivery must carry the subscription's Bearer token (INKBOX_WEBHOOK_TOKEN) and a valid HMAC
// (INKBOX_SIGNING_KEY, `sha256=` hex over "{request_id}.{timestamp}.{raw body}"), be within 300 s of now (the SDK's
// verifyWebhook checks neither the window nor replays), and not repeat an event or request id. It is acked first and
// handled after, so a slow store or reply never makes Inkbox redeliver. Replies use INKBOX_API_KEY (Aze's own key).
// Email (message.received) is ignored: the sender match on mail is not authenticated.
// Privacy: task text and rejected notes are never logged; logs carry event type, a short task id and a result code.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NoteAudit, Settings, Store } from "../types.js";
import type { RuntimeDeps } from "../runtime/types.js";
import { errorClass, gate, normalizeSurface } from "../gate/index.js";
import { buildEnvelope, formatUsdc } from "../advise/index.js";

export const INKBOX_API_BASE = "https://inkbox.ai";
export const WEBHOOK_PATH = "/inkbox/webhook";
export const MAX_SKEW_MS = 300_000;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_TEXT_CHARS = 4_000;
export const REPLY_TIMEOUT_MS = 10_000;
const SEEN_MAX = 5_000;
const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const TASK_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface InkboxConfig {
  signingKey: string;
  webhookToken: string;
  apiKey: string | null; // null: deliveries are handled but Aze cannot reply
  handle: string;
  baseUrl: string;
}

/** null unless both INKBOX_SIGNING_KEY and INKBOX_WEBHOOK_TOKEN are set (the route is then not registered at all). */
export function inkboxConfig(env: NodeJS.ProcessEnv): InkboxConfig | null {
  const signingKey = env.INKBOX_SIGNING_KEY?.trim() ?? "";
  const webhookToken = env.INKBOX_WEBHOOK_TOKEN?.trim() ?? "";
  if (!signingKey || !webhookToken) return null;
  const handle = env.INKBOX_HANDLE?.trim() || "aze";
  if (!HANDLE_RE.test(handle)) return null;
  // INKBOX_BASE_URL: https only (Aze's key rides on every reply); plain http only for a localhost test server.
  let baseUrl = INKBOX_API_BASE;
  const raw = env.INKBOX_BASE_URL?.trim().replace(/\/+$/, "");
  if (raw) {
    try {
      const u = new URL(raw);
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (!u.username && !u.password && !u.search && !u.hash && (u.protocol === "https:" || (u.protocol === "http:" && local))) baseUrl = raw;
    } catch { /* keep the default */ }
  }
  return { signingKey, webhookToken, apiKey: env.INKBOX_API_KEY?.trim() || null, handle, baseUrl };
}

// ---------- delivery checks ----------

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();
/** Constant-time equality on any two strings (hashing first equalizes the lengths). */
const sameString = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

/** The SDK's HMAC check, but never throws (its timingSafeEqual throws on a wrong-length signature). */
export function signatureOk(rawBody: string, h: { signature: string; requestId: string; timestamp: string }, secret: string): boolean {
  if (!h.signature.startsWith("sha256=")) return false;
  const key = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const expected = createHmac("sha256", key).update(`${h.requestId}.${h.timestamp}.`).update(rawBody).digest("hex");
  return sameString(expected, h.signature.slice("sha256=".length).toLowerCase());
}

/** x-inkbox-timestamp as unix seconds, unix milliseconds or ISO 8601; true when within MAX_SKEW_MS of now. */
export function timestampOk(ts: string, now: number): boolean {
  const t = ts.trim();
  let ms: number;
  if (/^\d{9,11}$/.test(t)) ms = Number(t) * 1000;
  else if (/^\d{12,14}$/.test(t)) ms = Number(t);
  else ms = Date.parse(t);
  return Number.isFinite(ms) && Math.abs(now - ms) <= MAX_SKEW_MS;
}

/** Remembers ids for twice the skew window, so a replay inside the window is refused. */
export function createSeen(now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return (id: string): boolean => {
    const t = now();
    for (const [k, exp] of seen) {
      if (exp > t && seen.size <= SEEN_MAX) break;
      seen.delete(k);
    }
    if ((seen.get(id) ?? 0) > t) return true;
    seen.set(id, t + 2 * MAX_SKEW_MS);
    return false;
  };
}

// ---------- commands ----------

export type Command =
  | { kind: "check"; surface: string; tool: string | null }
  | { kind: "file"; note: Record<string, unknown> }
  | { kind: "help" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The text of an A2A message: every part's `text`, joined, capped. */
export function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n").slice(0, MAX_TEXT_CHARS);
}

function jsonObjectIn(s: string): Record<string, unknown> | null {
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** `check <service> [/ <tool>]`, `file {json}`, or a bare note object; anything else gets the help text. */
export function parseCommand(text: string): Command {
  const t = text.replace(/```(?:json)?/gi, "").trim();
  const check = /^(?:check|query)\b[\s:]*(.+)$/is.exec(t);
  if (check) {
    const [surface, tool] = check[1].split(/\s+\/\s+/, 2).map((s) => s.trim().replace(/[.?!]+$/, ""));
    if (surface) return { kind: "check", surface: surface.slice(0, 60), tool: tool ? tool.slice(0, 80) : null };
  }
  if (/^file\b/i.test(t) || t.startsWith("{")) {
    const note = jsonObjectIn(t);
    if (note) return { kind: "file", note };
  }
  return { kind: "help" };
}

export function helpText(mcpUrl: string | undefined): string {
  return [
    "Aze is the bottleneck map for AI agents: field notes about what blocked other agents. Send one of:",
    "  check <service>            e.g. check GitHub   (free advisory)",
    '  file {"kind":"barrier|friction|worked_well|wish","category":"...","surface":"<public service>","what":"<what happened>","workaround":"<optional>"}',
    "Notes filed over Inkbox A2A are VERIFIED (Inkbox sets who called). Never include names, emails, repos, paths, ids or URLs: classes, not names.",
    mcpUrl ? `Full workarounds unlock over MCP at ${mcpUrl} (notes_unlock, x402, Base Sepolia test USDC).` : "",
  ].filter(Boolean).join("\n");
}

// ---------- handling ----------

export interface InkboxDeps {
  store: Store;
  runtime: RuntimeDeps | null;
  settingsOf: () => Promise<Settings>;
  mcpUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

type Reply = { intent: "complete" | "ask_caller" | "fail"; text: string };

export async function runCommand(cmd: Command, deps: InkboxDeps): Promise<Reply & { code: string }> {
  const settings = await deps.settingsOf();
  if (cmd.kind === "help") return { intent: "ask_caller", text: helpText(deps.mcpUrl), code: "help" };

  if (cmd.kind === "check") {
    const key = normalizeSurface(cmd.surface);
    const matches = await deps.store.findMatches({ surface: key, tool: cmd.tool, error_class: null }, 5);
    const score = (await deps.store.scores(key))[0] ?? null;
    await deps.store.logQuery({ surface: key, tool: cmd.tool, matched: matches.length }).catch(() => {});
    const env = buildEnvelope(key, matches, settings, score);
    const lines = [`Aze: ${env.advisories.length} known issue${env.advisories.length === 1 ? "" : "s"} for ${cmd.surface}.`];
    env.advisories.forEach((a, i) => {
      lines.push(`${i + 1}. [${a.label}] ${a.what} (reports: ${a.reports})${a.teaser ? ` Workaround teaser: ${a.teaser}` : ""}` +
        `${a.price_usdc ? ` Unlock: notes_unlock note_id=${a.note_id} (${a.price_usdc} test USDC)` : ""}`);
    });
    if (env.next) lines.push(String(env.next));
    if (deps.mcpUrl && env.advisories.some((a) => a.price_usdc)) lines.push(`MCP: ${deps.mcpUrl}`);
    return { intent: "complete", text: lines.join("\n"), code: `check:${env.advisories.length}` };
  }

  if (!settings.filing_enabled) return { intent: "fail", text: "Filing is paused by the operator. Try again later.", code: "paused" };
  const { proof: _proof, ...rest } = cmd.note;
  const g = gate(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null)));
  if (!g.ok) {
    // Name the rule and field only; never echo the note text back or log it.
    const problems = g.problems.map((p) => `- ${p.field}: ${p.rule} (${p.hint})`).join("\n");
    return { intent: "ask_caller", text: `Not filed: the privacy gate rejected it. Fix each problem and send it again once:\n${problems}`, code: "rejected_by_gate" };
  }
  let audit: NoteAudit | null = null;
  if (deps.runtime?.auditor) {
    const similar = await deps.store.findMatches({ surface: g.note.surface, tool: g.note.tool, error_class: g.note.error_class }, 3).catch(() => []);
    audit = await deps.runtime.auditor.audit(g.note, similar);
    if (audit.status === "rejected") {
      return { intent: "ask_caller", text: `Not filed: a reviewer model flagged it (${audit.reason ?? "describe classes, never names"}). Fix it and send it again once.`, code: "rejected_by_audit" };
    }
  }
  const note = await deps.store.insertNote(g.note, { attestation: "verified", payout_address: g.payout_address, audit });
  const earns = note.workaround
    ? ` You earn ${settings.filer_bps / 100}% of each unlock (${formatUsdc(Math.floor((settings.price_micro * settings.filer_bps) / 10000))} test USDC)${g.payout_address ? "" : " once you send a payout_address"}.`
    : "";
  return { intent: "complete", text: `Filed. note_id=${note.id}, status VERIFIED (Inkbox A2A caller).${earns}`, code: "filed" };
}

async function sendReply(cfg: InkboxConfig, taskId: string, reply: Reply, fetchImpl: typeof fetch): Promise<string> {
  if (!cfg.apiKey) return "no_api_key";
  const url = `${cfg.baseUrl}/api/v1/identities/${encodeURIComponent(cfg.handle)}/a2a/tasks/${encodeURIComponent(taskId)}/reply`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "X-API-Key": cfg.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ intent: reply.intent, parts: [{ text: reply.text }] }),
      signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
    });
    return res.ok ? "replied" : `reply_http_${res.status}`;
  } catch (e) {
    return `reply_error_${(e as Error)?.name === "TimeoutError" ? "timeout" : "network"}`;
  }
}

/** One verified A2A delivery: run the command, reply on the task. Never throws. */
export async function handleDelivery(payload: unknown, cfg: InkboxConfig, deps: InkboxDeps): Promise<string> {
  if (!isObj(payload) || !isObj(payload.data)) return "ignored:shape";
  const type = String(payload.event_type ?? "");
  if (type !== "a2a.task.created" && type !== "a2a.task.message") return `ignored:${type.slice(0, 40) || "none"}`;
  const d = payload.data;
  const taskId = typeof d.task_id === "string" && TASK_ID_RE.test(d.task_id) ? d.task_id : null;
  if (!taskId) return "ignored:task_id";
  const caller = isObj(d.caller) ? d.caller : null;
  if (!caller || typeof caller.identity_id !== "string" || !caller.identity_id) return "ignored:caller";
  if (typeof caller.handle === "string" && caller.handle.toLowerCase() === cfg.handle.toLowerCase()) return "ignored:self";
  let result: Reply & { code: string };
  try {
    result = await runCommand(parseCommand(textOf(d.parts)), deps);
  } catch (e) {
    console.error("[inkbox] command failed:", String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 120));
    result = { intent: "fail", text: "Aze could not handle that right now; nothing was filed. Try again in a minute.", code: "error" };
  }
  const sent = await sendReply(cfg, taskId, result, deps.fetchImpl ?? fetch);
  return `${result.code} ${sent}`;
}

/** Registers POST /inkbox/webhook when INKBOX_SIGNING_KEY and INKBOX_WEBHOOK_TOKEN are set. Returns whether it did. */
export function registerInkbox(app: any, env: NodeJS.ProcessEnv, deps: InkboxDeps & { now?: () => number }): boolean {
  const cfg = inkboxConfig(env);
  if (!cfg) return false;
  const now = deps.now ?? Date.now;
  const seen = createSeen(now);
  const log = deps.log ?? ((l: string) => console.log(l));
  app.post(WEBHOOK_PATH, async (c: any) => {
    const auth = c.req.header("authorization") ?? "";
    if (!sameString(auth, `Bearer ${cfg.webhookToken}`)) return c.json({ ok: false }, 401);
    if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) return c.json({ ok: false }, 413);
    const raw: string = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return c.json({ ok: false }, 413);
    const h = {
      signature: c.req.header("x-inkbox-signature") ?? "",
      requestId: c.req.header("x-inkbox-request-id") ?? "",
      timestamp: c.req.header("x-inkbox-timestamp") ?? "",
    };
    if (!h.requestId || !signatureOk(raw, h, cfg.signingKey)) return c.json({ ok: false }, 401);
    if (!timestampOk(h.timestamp, now())) return c.json({ ok: false, code: "stale" }, 401);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ ok: false }, 400);
    }
    const eventId = isObj(payload) && typeof payload.id === "string" ? payload.id : "";
    if (seen(`r:${h.requestId}`) || (eventId && seen(`e:${eventId}`))) return c.json({ ok: true, duplicate: true });
    const type = isObj(payload) ? String(payload.event_type ?? "").slice(0, 40) : "";
    const task = isObj(payload) && isObj(payload.data) && typeof payload.data.task_id === "string" ? payload.data.task_id.slice(0, 8) : "-";
    void handleDelivery(payload, cfg, deps).then((r) => log(`[inkbox] ${type} task=${task} ${r}`));
    return c.json({ ok: true });
  });
  log(`[inkbox] A2A webhook on ${WEBHOOK_PATH} as @${cfg.handle} (replies ${cfg.apiKey ? "on" : "off: INKBOX_API_KEY missing"})`);
  return true;
}
