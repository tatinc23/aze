// SubQ chat client (OpenAI-compatible POST /v1/chat/completions). UNWIRED ON PURPOSE (Ken, 2026-10-20): no runtime
// job calls it. Its intended job is synthesizing filed notes into bottleneck reports. It turns on when the SubQ key
// gets SubQ 1.1 Small: set SUBQ_CHAT_MODEL to that model id (then /admin/diag also probes it as "subq-chat"), and wire
// the report job to ChatClient + askJson. It does not fill tool inputs, distill pages, answer tasks or draft notes.
// JSON mode is response_format json_schema with a strict schema (Muse M1). If the server rejects a schema (400/422
// naming response_format/json_schema) that schema name stops being sent, and the same goes for reasoning_effort.
// Replies are extracted robustly: think blocks and code fences stripped, the outermost {...} taken, one corrective retry.
import type { Usage } from "../runtime/types.js";
import {
  SubqError, ZERO_USAGE, addUsage, buildChatRequest, errorDetail, isObj, parseChatResponse, subqRequestRetry, type ChatMessage,
  type JsonSchemaFormat, type SubqConfig,
} from "./wire.js";

/** One budget per askJson call, shared by the corrective retry. */
export const CHAT_TIMEOUT_MS = 30_000;
/** A corrective retry is only worth starting with at least this much budget left. */
export const MIN_RETRY_MS = 2_000;

const FORMAT_REJECTED = /response_format|json_schema|json_object|json mode|structured output|additionalProperties/i;
const EFFORT_REJECTED = /reasoning/i;

/** Which optional request features a 400/422 refused. Reads the error's own message/param when the body has one
 * (so task text echoed elsewhere in a body can't trigger it), else the raw excerpt. */
export function rejectedFeatures(e: unknown, sent: { format: boolean; effort: boolean }): { format: boolean; effort: boolean } {
  const no = { format: false, effort: false };
  if (!(e instanceof SubqError) || e.code !== "http" || (e.status !== 400 && e.status !== 422)) return no;
  const d = errorDetail(e.excerpt ?? "");
  const text = d.message || d.param ? `${d.message ?? ""} ${d.param ?? ""}` : (e.excerpt ?? "");
  return { format: sent.format && FORMAT_REJECTED.test(text), effort: sent.effort && EFFORT_REJECTED.test(text) };
}

export interface ChatResult {
  text: string;
  usage: Usage;
  ms: number;
  raw: string;
  finish_reason: string | null;
  /** The schema name actually sent on the call that answered (null: plain text call). */
  schema: string | null;
  /** The reasoning_effort actually sent on the call that answered. */
  reasoning_effort: string | null;
  /** Features the server refused during this call (and that are now off), with the redacted error excerpt. */
  dropped: Array<{ feature: "response_format" | "reasoning_effort"; status: number | null; excerpt: string }>;
}

/** What a job needs from a chat model (ChatClient; a test double in tests). */
export interface ChatBackend {
  /** Error-message prefix, e.g. "subq". */
  readonly provider: string;
  readonly model: string;
  complete(messages: ChatMessage[], opts?: { schema?: JsonSchemaFormat | null; timeoutMs?: number; maxTokens?: number }): Promise<ChatResult>;
}

export class ChatClient implements ChatBackend {
  readonly provider = "subq";
  /** Schema names the server refused: never sent again (per name, so one tool's odd schema can't turn JSON mode off for the rest). */
  private readonly rejectedSchemas = new Set<string>();
  private readonly acceptedSchemas = new Set<string>();
  /** The server refused reasoning_effort: never sent again. */
  private effortRejected = false;
  constructor(private readonly cfg: SubqConfig) {}
  get model(): string {
    return this.cfg.chatModel;
  }
  schemaStatus(name: string): "unknown" | "accepted" | "rejected" {
    return this.rejectedSchemas.has(name) ? "rejected" : this.acceptedSchemas.has(name) ? "accepted" : "unknown";
  }
  get reasoningEffort(): string | null {
    return this.effortRejected ? null : (this.cfg.reasoningEffort ?? null);
  }
  /** One completion inside one timeout budget. A refused response_format or reasoning_effort is dropped and the call
   * resent without it (at most 3 sends); any other error is thrown. */
  async complete(
    messages: ChatMessage[],
    opts: { schema?: JsonSchemaFormat | null; timeoutMs?: number; maxTokens?: number } = {},
  ): Promise<ChatResult> {
    const t0 = Date.now();
    const timeoutMs = opts.timeoutMs ?? CHAT_TIMEOUT_MS;
    let schema = opts.schema && !this.rejectedSchemas.has(opts.schema.name) ? opts.schema : null;
    let effort = this.reasoningEffort;
    const dropped: ChatResult["dropped"] = [];
    for (;;) {
      const body = buildChatRequest(this.cfg.chatModel, messages, { schema, maxTokens: opts.maxTokens, reasoningEffort: effort });
      try {
        const res = await subqRequestRetry(this.cfg, { path: "/chat/completions", body, timeoutMs: Math.max(1, timeoutMs - (Date.now() - t0)) });
        if (schema) this.acceptedSchemas.add(schema.name);
        const parsed = parseChatResponse(res.json);
        return {
          text: parsed.text, usage: parsed.usage, ms: Date.now() - t0, raw: res.text, finish_reason: parsed.finish_reason,
          schema: schema?.name ?? null, reasoning_effort: effort, dropped,
        };
      } catch (e) {
        const r = rejectedFeatures(e, { format: schema !== null, effort: effort !== null });
        if (!r.format && !r.effort) throw e;
        const err = e as SubqError;
        if (r.format && schema) {
          this.rejectedSchemas.add(schema.name);
          this.acceptedSchemas.delete(schema.name);
          console.warn(`[subq] chat rejected response_format json_schema '${schema.name}' (http ${err.status}); not sending it for that schema again`);
          dropped.push({ feature: "response_format", status: err.status, excerpt: (err.excerpt ?? "").slice(0, 300) });
          schema = null;
        }
        if (r.effort && effort) {
          this.effortRejected = true;
          console.warn(`[subq] chat rejected reasoning_effort (http ${err.status}); not sending it again`);
          dropped.push({ feature: "reasoning_effort", status: err.status, excerpt: (err.excerpt ?? "").slice(0, 300) });
          effort = null;
        }
      }
    }
  }
}

/** The JSON object in a model reply: think blocks and code fences stripped, else the outermost {...}. */
export function extractJson(text: string): Record<string, unknown> {
  const t = String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(t);
  const candidates = [t, fence?.[1]?.trim() ?? ""];
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(t.slice(start, end + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      const v = JSON.parse(c);
      if (isObj(v)) return v;
    } catch { /* next candidate */ }
  }
  throw new Error(`reply was not one JSON object (${t.length} chars)`);
}

/** Ask for JSON; one corrective retry when parsing or validation fails, inside one `timeoutMs` budget for both
 * attempts. Timeouts and HTTP errors are not retried here. Errors never include the model's reply (it may hold text we
 * must not log). */
export async function askJson<T>(
  chat: ChatBackend,
  opts: {
    system: string; user: string; validate: (v: Record<string, unknown>) => T; timeoutMs?: number; maxTokens?: number;
    /** Strict schema for response_format json_schema; null/absent = no response_format. */
    schema?: JsonSchemaFormat | null;
  },
): Promise<{ value: T; usage: Usage; ms: number }> {
  const t0 = Date.now();
  const messages: ChatMessage[] = [
    { role: "system", content: `${opts.system}\n\nReply with ONLY one JSON object. No prose, no code fences.` },
    { role: "user", content: opts.user },
  ];
  const budget = opts.timeoutMs ?? CHAT_TIMEOUT_MS;
  let usage: Usage = { ...ZERO_USAGE };
  let lastErr: Error | null = null;
  let tries = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = budget - (Date.now() - t0);
    if (attempt > 0 && left < Math.min(MIN_RETRY_MS, budget / 2)) break; // no time for a useful retry
    tries++;
    let res;
    try {
      res = await chat.complete(messages, { schema: opts.schema ?? null, timeoutMs: Math.max(1, left), maxTokens: opts.maxTokens });
    } catch (e) {
      if (e instanceof SubqError) e.usage = usage;
      else if (e instanceof Error) {
        // Another backend's error may already carry tokens spent inside complete(): add, don't replace.
        const err = e as Error & { usage?: Usage };
        err.usage = addUsage(usage, err.usage ?? ZERO_USAGE);
      }
      throw e;
    }
    usage = addUsage(usage, res.usage);
    try {
      return { value: opts.validate(extractJson(res.text)), usage, ms: Date.now() - t0 };
    } catch (e) {
      lastErr = e as Error;
      messages.push({ role: "assistant", content: res.text.slice(0, 4000) });
      messages.push({ role: "user", content: `That was not valid: ${lastErr.message.slice(0, 500)}. Reply again with ONLY the corrected JSON object.` });
    }
  }
  throw new SubqError("bad_output", `${chat.provider} ${chat.model} gave no valid JSON after ${tries > 1 ? "a retry" : "one try (no time left to retry)"}: ${lastErr?.message.slice(0, 300)}`, null, null, usage);
}
