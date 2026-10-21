// SubQ wire formats, isolated so the team can correct them from live /admin/diag output without touching logic.
// Snap speaks the System One decision format (POST /v1/systemone): a `state` plus 1-16 named questions of type
// noul | choice | score. SubQ's docs (Muse M1, docs/muse/m1-m2-provider-facts.md) and the System One spec put every
// question's options in `criteria`: noul {true, false} descriptions (SubQ says criteria is required), choice an
// object option -> description|null, score an ordered array, lowest first. Score answers are the probability-weighted
// 0-based level index with `legend`/`probabilities` keyed "0".."n-1" (System One score primitive). Parsers still
// accept variants because nothing here was verified against the live API from this container.
// Chat is OpenAI-compatible (POST /v1/chat/completions); `store: false` keeps our prompts out of SubQ's storage. JSON
// mode is `response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}` (Muse M1). The chat
// client (./chat.ts) is unwired for now. Errors are `{"detail": {"error_type", "message"}}` (Muse M1); errorDetail reads them.
import type { Usage } from "../runtime/types.js";

export const DEFAULT_BASE_URL = "https://api.subq.ai/v1";
export const DEFAULT_SNAP_MODEL = "subq-snap-preview";
/** Chat model when SUBQ_CHAT_MODEL is unset. Set SUBQ_CHAT_MODEL to the SubQ 1.1 Small id once the key has it. */
export const DEFAULT_CHAT_MODEL = "subq-preview";
/** Raw response excerpt length for diag output and errors. */
export const EXCERPT_CHARS = 500;
export const MAX_QUESTIONS = 16;
/** SubQ: answer keys match question names, which are at most 100 characters. */
export const MAX_QUESTION_NAME = 100;

export interface SubqConfig {
  baseUrl: string; // no trailing slash
  apiKey: string;
  snapModel: string;
  chatModel: string;
  /** Chat `reasoning_effort`; null/absent = not sent. subqConfig defaults it to "low" (SUBQ_REASONING_EFFORT). */
  reasoningEffort?: ReasoningEffort | null;
}

/** Documented chat `reasoning_effort` values (Muse M1). Reasoning is billed as output and never returned. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";

export const ZERO_USAGE: Usage = Object.freeze({ input_tokens: 0, output_tokens: 0 }) as Usage;
export const addUsage = (a: Usage, b: Usage): Usage => ({ input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens });

export type SubqErrorCode = "timeout" | "http" | "network" | "bad_json" | "bad_response" | "bad_output";

/** Every SubQ failure. Messages carry a redacted response excerpt (never the key, never note content). */
export class SubqError extends Error {
  constructor(
    readonly code: SubqErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly excerpt: string | null = null,
    public usage: Usage | null = null,
    /** `detail.error_type` (or `error.type`) of an HTTP error body, e.g. "validation_error". */
    readonly errorType: string | null = null,
  ) {
    super(message);
    this.name = "SubqError";
  }
}

/** Remove the API key and anything bearer/key-shaped before text leaves this module; cap the length. */
export function redact(text: string, apiKey?: string, max = EXCERPT_CHARS): string {
  let t = String(text ?? "");
  if (apiKey && apiKey.length >= 6) t = t.split(apiKey).join("[redacted]");
  t = t
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b(?:sk|rk|pk)[-_][\w-]{8,}/g, "[redacted]");
  return t.length > max ? t.slice(0, max) : t;
}

/** The documented error body `{"detail": {"error_type", "message"}}`, plus the usual variants: FastAPI
 * `{"detail": [{loc, msg, type}]}`, `{"detail": "..."}` and OpenAI `{"error": {message, type, param}}`. `param` is the
 * request field the error names, when the body says. Unparseable bodies give all nulls. */
export function errorDetail(text: string): { type: string | null; message: string | null; param: string | null } {
  const none = { type: null, message: null, param: null };
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return none;
  }
  if (!isObj(j)) return none;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const d = j.detail;
  if (isObj(d)) return { type: str(d.error_type) ?? str(d.type), message: str(d.message) ?? str(d.msg), param: str(d.param) ?? str(d.field) };
  if (typeof d === "string") return { ...none, message: str(d) };
  if (Array.isArray(d)) {
    const items = d.filter(isObj);
    const msgs = items.map((x) => [Array.isArray(x.loc) ? x.loc.join(".") : null, str(x.msg) ?? str(x.message)].filter(Boolean).join(": ")).filter(Boolean);
    return { type: items.map((x) => str(x.type)).find(Boolean) ?? null, message: msgs.length ? msgs.join("; ") : null, param: null };
  }
  const e = j.error;
  if (isObj(e)) return { type: str(e.type) ?? str(e.code), message: str(e.message), param: str(e.param) };
  if (typeof e === "string") return { ...none, message: str(e) };
  return { type: str(j.error_type) ?? str(j.type), message: str(j.message), param: str(j.param) };
}

export interface SubqResponse {
  status: number;
  text: string; // raw body
  json: unknown;
  ms: number;
}

/** One HTTP call to SubQ with a hard timeout (also enforced when fetch ignores the abort signal). */
export async function subqRequest(
  cfg: Pick<SubqConfig, "baseUrl" | "apiKey">,
  req: { method?: "GET" | "POST"; path: string; body?: unknown; timeoutMs: number },
): Promise<SubqResponse> {
  const t0 = Date.now();
  const ms = Math.max(1, Math.floor(req.timeoutMs));
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new SubqError("timeout", `subq ${req.path} timed out after ${ms}ms`));
    }, ms);
  });
  timeout.catch(() => {}); // never an unhandled rejection
  const method = req.method ?? (req.body === undefined ? "GET" : "POST");
  try {
    const res = await Promise.race([
      fetch(`${cfg.baseUrl}${req.path}`, {
        method,
        headers: {
          authorization: `Bearer ${cfg.apiKey}`,
          accept: "application/json",
          ...(req.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        signal: ctl.signal,
      }),
      timeout,
    ]);
    const text = await Promise.race([res.text(), timeout]);
    const excerpt = redact(text, cfg.apiKey);
    if (!res.ok) {
      const type = errorDetail(excerpt).type;
      throw new SubqError("http", `subq ${req.path} http ${res.status}${type ? ` ${type}` : ""}: ${excerpt.slice(0, 300)}`, res.status, excerpt, null, type);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SubqError("bad_json", `subq ${req.path} returned non-JSON: ${excerpt.slice(0, 300)}`, res.status, excerpt);
    }
    return { status: res.status, text, json, ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof SubqError) throw e;
    if ((e as Error)?.name === "AbortError") throw new SubqError("timeout", `subq ${req.path} timed out after ${ms}ms`);
    throw new SubqError("network", `subq ${req.path} network error: ${redact((e as Error)?.message ?? String(e), cfg.apiKey, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Backoff before the single retry; tests set these to 0. */
export const RETRY = { waitMs: 200, jitterMs: 300, minLeftMs: 1_000 };
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/** Rate limits, 5xx and network blips are worth one retry; timeouts, 4xx (bad key, no credits, bad request) are not. */
export function isRetryable(e: unknown): boolean {
  return e instanceof SubqError && (e.code === "network" || (e.code === "http" && e.status !== null && RETRY_STATUS.has(e.status)));
}

/** subqRequest plus one retry on a retryable error, with both attempts inside the same timeout budget. */
export async function subqRequestRetry(
  cfg: Pick<SubqConfig, "baseUrl" | "apiKey">,
  req: { method?: "GET" | "POST"; path: string; body?: unknown; timeoutMs: number },
): Promise<SubqResponse> {
  const t0 = Date.now();
  try {
    return await subqRequest(cfg, req);
  } catch (e) {
    if (!isRetryable(e)) throw e;
    const wait = RETRY.waitMs + Math.floor(Math.random() * RETRY.jitterMs);
    const left = req.timeoutMs - (Date.now() - t0) - wait;
    if (left < RETRY.minLeftMs) throw e;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return subqRequest(cfg, { ...req, timeoutMs: left });
  }
}

// ---------- small parsing helpers ----------
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const toNum = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Usage from either shape: {input_tokens, output_tokens} or OpenAI {prompt_tokens, completion_tokens}. Missing = 0. */
export function parseUsage(u: unknown): Usage {
  if (!isObj(u)) return { ...ZERO_USAGE };
  const input = toNum(u.input_tokens) ?? toNum(u.prompt_tokens) ?? 0;
  const output = toNum(u.output_tokens) ?? toNum(u.completion_tokens) ?? 0;
  return { input_tokens: Math.max(0, Math.round(input)), output_tokens: Math.max(0, Math.round(output)) };
}

// ---------- Snap (System One) ----------
/** What yes and no mean for a noul question (System One `criteria: {true, false}`). */
export interface NoulCriteria { true: string; false: string }
export type SnapQuestion =
  | { type: "noul"; instructions: string; criteria?: NoulCriteria } // criteria defaults to a generic yes/no
  | { type: "choice"; instructions: string; options: Record<string, string | null> } // option key -> description (null: the key says it all)
  | { type: "score"; instructions: string; levels: string[] }; // ordered, lowest first

export const DEFAULT_NOUL_CRITERIA: Readonly<NoulCriteria> = Object.freeze({
  true: "Yes: the statement holds for the state",
  false: "No: the statement does not hold for the state",
});

const nonEmpty = (s: unknown): string | null => (typeof s === "string" && s.trim() ? s.trim() : null);

/** Request body for POST /systemone. Throws on limits the API documents (1-16 questions, names <= 100 chars,
 * 2-255 options, 2-10 levels). Every question carries `criteria`; empty descriptions become null (the API refuses ""). */
export function buildSnapRequest(model: string, state: string, questions: Record<string, SnapQuestion>): Record<string, unknown> {
  const names = Object.keys(questions);
  if (names.length < 1 || names.length > MAX_QUESTIONS) throw new SubqError("bad_output", `snap needs 1-${MAX_QUESTIONS} questions, got ${names.length}`);
  const out: Record<string, unknown> = {};
  for (const name of names) {
    if (name.length > MAX_QUESTION_NAME) throw new SubqError("bad_output", `snap question name longer than ${MAX_QUESTION_NAME} chars`);
    const q = questions[name];
    if (q.type === "noul") {
      const criteria = {
        true: nonEmpty(q.criteria?.true) ?? DEFAULT_NOUL_CRITERIA.true,
        false: nonEmpty(q.criteria?.false) ?? DEFAULT_NOUL_CRITERIA.false,
      };
      out[name] = { type: "noul", instructions: q.instructions, criteria };
    } else if (q.type === "choice") {
      const n = Object.keys(q.options).length;
      if (n < 2 || n > 255) throw new SubqError("bad_output", `choice '${name}' needs 2-255 options, got ${n}`);
      out[name] = { type: "choice", instructions: q.instructions, criteria: Object.fromEntries(Object.entries(q.options).map(([k, d]) => [k, nonEmpty(d)])) };
    } else {
      if (q.levels.length < 2 || q.levels.length > 10) throw new SubqError("bad_output", `score '${name}' needs 2-10 levels, got ${q.levels.length}`);
      if (q.levels.some((l) => !nonEmpty(l))) throw new SubqError("bad_output", `score '${name}' has an empty level`);
      out[name] = { type: "score", instructions: q.instructions, criteria: q.levels.map((l) => l.trim()) };
    }
  }
  return { model, state, questions: out };
}

/** One answer, loosely normalized; read it with noulOf / choiceOf / scoreLevelOf. */
export interface SnapAnswer {
  type: string | null;
  number: number | null; // noul probability or score value, whichever the answer carried
  noul: number | null;
  score: number | null;
  choice: string | null;
  legend: Record<string, string> | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
}

export interface SnapResult {
  answers: Record<string, SnapAnswer>;
  usage: Usage;
}

function toRecordOfNumbers(v: unknown): Record<string, number> | null {
  if (isObj(v)) {
    const out: Record<string, number> = {};
    for (const [k, x] of Object.entries(v)) {
      const n = toNum(x);
      if (n !== null) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  }
  if (Array.isArray(v)) {
    // [{option|label|key|level, probability|p}] or a plain array of numbers (index -> p)
    const out: Record<string, number> = {};
    v.forEach((x, i) => {
      if (isObj(x)) {
        const k = x.option ?? x.label ?? x.key ?? x.choice ?? x.level ?? x.name ?? i;
        const n = toNum(x.probability ?? x.p ?? x.prob ?? x.value);
        if (n !== null) out[String(k)] = n;
      } else {
        const n = toNum(x);
        if (n !== null) out[String(i)] = n;
      }
    });
    return Object.keys(out).length ? out : null;
  }
  return null;
}

function toLegend(v: unknown): Record<string, string> | null {
  if (Array.isArray(v)) {
    const out: Record<string, string> = {};
    v.forEach((x, i) => { if (typeof x === "string") out[String(i)] = x; });
    return Object.keys(out).length ? out : null;
  }
  if (isObj(v)) {
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
    if (Object.keys(out).length) return out;
    // {label: index} form: invert to {index: label} so level keys stay numeric
    for (const [k, x] of Object.entries(v)) if (typeof x === "number" && Number.isInteger(x) && x >= 0) out[String(x)] = k;
    return Object.keys(out).length ? out : null;
  }
  return null;
}

function parseAnswer(a: unknown): SnapAnswer | null {
  const ans: SnapAnswer = { type: null, number: null, noul: null, score: null, choice: null, legend: null, probabilities: null, confidence: null };
  if (toNum(a) !== null) {
    ans.number = toNum(a);
    return ans;
  }
  if (typeof a === "string") {
    ans.choice = a;
    return ans;
  }
  if (!isObj(a)) return null;
  // {answer: {...}} / {result: {...}}: read the inner object's fields too
  if (isObj(a.answer) || isObj(a.result)) a = { ...a, ...(isObj(a.result) ? a.result : {}), ...(isObj(a.answer) ? a.answer : {}) };
  if (!isObj(a)) return null;
  ans.type = typeof a.type === "string" ? a.type : null;
  ans.noul = toNum(a.noul) ?? toNum(a.p) ?? toNum(a.probability) ?? toNum(a.p_yes) ?? toNum(a.yes);
  ans.score = toNum(a.score) ?? toNum(a.level) ?? toNum(a.expected);
  const value = a.value ?? a.answer ?? a.result;
  ans.number = ans.noul ?? ans.score ?? toNum(value);
  const choice = a.choice ?? a.selected ?? a.option ?? a.label ?? (typeof value === "string" && toNum(value) === null ? value : undefined);
  if (typeof choice === "string") ans.choice = choice;
  ans.legend = toLegend(a.legend ?? a.levels ?? a.scale);
  ans.probabilities = toRecordOfNumbers(a.probabilities ?? a.probs ?? a.distribution);
  ans.confidence = toNum(a.confidence);
  return ans;
}

/** Response of POST /systemone. Accepts answers as an object keyed by question name or an array of {name, ...}. */
export function parseSnapResponse(json: unknown): SnapResult {
  if (!isObj(json)) throw new SubqError("bad_response", "snap response is not a JSON object");
  const container = [json, json.result, json.data, json.output].find((c) => isObj(c) && (isObj(c.answers) || Array.isArray(c.answers))) as
    Record<string, unknown> | undefined;
  const raw = container?.answers ?? (Array.isArray(json.results) ? json.results : undefined);
  const answers: Record<string, SnapAnswer> = {};
  if (isObj(raw)) {
    for (const [name, a] of Object.entries(raw)) {
      const p = parseAnswer(a);
      if (p) answers[name] = p;
    }
  } else if (Array.isArray(raw)) {
    for (const a of raw) {
      if (!isObj(a)) continue;
      const name = a.name ?? a.question ?? a.id ?? a.key;
      if (typeof name !== "string") continue;
      const p = parseAnswer(isObj(a.answer) ? { ...a, ...a.answer } : a);
      if (p) answers[name] = p;
    }
  } else {
    throw new SubqError("bad_response", "snap response has no answers");
  }
  return { answers, usage: parseUsage(json.usage ?? container?.usage) };
}

/** Probability of yes (0..1), or null if the answer carries none. */
export function noulOf(a: SnapAnswer | undefined): number | null {
  if (!a) return null;
  let p = a.noul ?? a.number;
  if (p === null && a.probabilities) {
    const pr = a.probabilities;
    p = toNum(pr.true ?? pr.yes ?? pr.Yes ?? pr.TRUE ?? pr["1"]);
  }
  return p === null ? null : clamp01(p);
}

/** System One shows options to the model as codes A..Z, AA, AB, ...: code -> 0-based option index. */
export function optionCodeIndex(code: string): number | null {
  if (!/^[A-Z]{1,2}$/.test(code)) return null;
  return code.length === 1 ? code.charCodeAt(0) - 65 : 26 + (code.charCodeAt(0) - 65) * 26 + (code.charCodeAt(1) - 65);
}

/** The selected option key (must be one of `options`, in the order they were sent), via the answer's choice or the
 * argmax of its probabilities. An answer in option-code form ("B") maps to the option at that position. */
export function choiceOf(a: SnapAnswer | undefined, options: string[]): string | null {
  if (!a) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const find = (s: string) => {
    const k = norm(s);
    const hit = k ? (options.find((o) => norm(o) === k) ?? null) : null;
    if (hit) return hit;
    const i = optionCodeIndex(s.trim());
    return i !== null && i < options.length ? options[i] : null;
  };
  if (a.choice !== null) {
    const hit = find(a.choice);
    if (hit) return hit;
  }
  if (a.probabilities) {
    const best = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0];
    if (best) return find(best[0]);
  }
  return null;
}

/**
 * The 1-based level (1..levels.length) of a score answer. System One returns `score` as the probability-weighted
 * 0-based level index (it can land between levels) with a legend keyed "0".."n-1". A legend or probabilities keyed
 * from "1" are read as 1-based; a score above n-1 can only be 1-based.
 */
export function scoreLevelOf(a: SnapAnswer | undefined, levels: string[]): number | null {
  if (!a) return null;
  const n = levels.length;
  if (n < 1) return null;
  const keys = Object.keys(a.legend ?? a.probabilities ?? {}).filter((k) => /^\d+$/.test(k)).map(Number);
  let base = keys.length && !keys.includes(0) && Math.min(...keys) === 1 ? 1 : 0;
  let idx: number | null = null;
  const score = a.score ?? (a.type === "score" ? a.number : null) ?? (a.noul === null ? a.number : null);
  if (score !== null) {
    if (!keys.length && score > n - 1) base = 1;
    idx = score - base;
  } else if (a.probabilities) {
    // expected index over level keys (numeric keys, or keys equal to a level label)
    let sum = 0, w = 0;
    for (const [k, p] of Object.entries(a.probabilities)) {
      const i = /^\d+$/.test(k) ? Number(k) - base : levels.findIndex((l) => l === k || l.toLowerCase().startsWith(k.toLowerCase()));
      if (i < 0 || i >= n) continue;
      sum += i * p;
      w += p;
    }
    if (w > 0) idx = sum / w;
  }
  if (idx === null || !Number.isFinite(idx)) return null;
  return Math.min(n, Math.max(1, Math.round(idx) + 1));
}

// ---------- Chat (OpenAI-compatible) ----------
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** A strict JSON schema for chat JSON mode. `name` must match ^[a-zA-Z0-9_-]{1,64}$. */
export interface JsonSchemaFormat {
  name: string;
  schema: Record<string, unknown>;
}

/** OpenAI-style body. JSON mode is `response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}`
 * (SubQ docs, Muse M1). `store: false` (documented; default true) keeps task text, tool output and step errors out of
 * SubQ's storage. `max_tokens`, never `max_completion_tokens` (SubQ docs). `reasoning_effort` only when given. */
export function buildChatRequest(
  model: string,
  messages: ChatMessage[],
  opts: { schema?: JsonSchemaFormat | null; maxTokens?: number; reasoningEffort?: string | null } = {},
): Record<string, unknown> {
  return {
    model,
    messages,
    ...(opts.schema ? { response_format: { type: "json_schema", json_schema: { name: opts.schema.name, strict: true, schema: opts.schema.schema } } } : {}),
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
    store: false,
  };
}

const textOf = (c: unknown): string | null => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts = c.map((p) => (typeof p === "string" ? p : isObj(p) && typeof p.text === "string" ? p.text : "")).filter(Boolean);
    return parts.length ? parts.join("") : null;
  }
  return null;
};

/** Response of POST /chat/completions: first choice's text (string or content parts), usage, finish reason. */
export function parseChatResponse(json: unknown): { text: string; usage: Usage; finish_reason: string | null } {
  if (!isObj(json)) throw new SubqError("bad_response", "chat response is not a JSON object");
  const choice = Array.isArray(json.choices) && isObj(json.choices[0]) ? json.choices[0] : null;
  const msg = choice && isObj(choice.message) ? choice.message : null;
  const text = textOf(msg?.content) ?? textOf(choice?.text) ?? textOf(json.output_text) ?? textOf(json.content);
  const finish_reason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  if (text === null) throw new SubqError("bad_response", `chat response has no message content${finish_reason ? ` (finish_reason ${finish_reason})` : ""}`);
  return { text, usage: parseUsage(json.usage), finish_reason };
}

/** GET /models: ids from {data: [{id}]} (OpenAI shape), {models: [...]}, or a bare array. */
export function parseModels(json: unknown): string[] {
  const list = Array.isArray(json) ? json : isObj(json) ? (Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : []) : [];
  return list
    .map((m) => (typeof m === "string" ? m : isObj(m) ? (m.id ?? m.name ?? m.model) : null))
    .filter((x): x is string => typeof x === "string");
}
