// Stream B: the SubQ client. Snap (Decisions API) is the router (agent_run's tool decisions) and the note auditor.
// Side-effect free: nothing is fetched or read until a method or diag runs. No SUBQ_API_KEY -> everything null.
// The chat client (./chat.ts) is built by nothing here on purpose: no runtime job uses it. Its intended job is
// synthesizing filed notes into bottleneck reports once the key has SubQ 1.1 Small (set SUBQ_CHAT_MODEL); setting
// SUBQ_CHAT_MODEL also adds the "subq-chat" diag, so turning it on is a config change.
import type { NoteAuditor, ProviderDiag, Router } from "../runtime/types.js";
import {
  DEFAULT_BASE_URL, DEFAULT_CHAT_MODEL, DEFAULT_REASONING_EFFORT, DEFAULT_SNAP_MODEL, EXCERPT_CHARS, REASONING_EFFORTS, SubqError, noulOf,
  choiceOf, parseModels, redact, scoreLevelOf, subqRequest, type JsonSchemaFormat, type ReasoningEffort, type SubqConfig,
} from "./wire.js";
import { SnapClient, createAuditor, createRouter, type AuditMode } from "./snap.js";
import { ChatClient, extractJson } from "./chat.js";

const DIAG_CHAT_FORMAT: JsonSchemaFormat = {
  name: "diag_ok",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
};

export { SnapClient, ChatClient };

export interface Subq {
  router: Router | null;
  auditor: NoteAuditor | null;
  diags: ProviderDiag[];
}

/** SUBQ_AUDIT: "off" disables the note audit, "shadow" audits but never rejects; anything else enforces. */
export function auditModeOf(v: string | undefined): AuditMode | "off" {
  const m = (v ?? "").trim().toLowerCase();
  if (m === "off" || m === "0" || m === "false") return "off";
  return m === "shadow" ? "shadow" : "enforce";
}

/** SUBQ_BASE_URL override: https only (the bearer key rides on every call), plain http only for a local fake server.
 * Anything else falls back to the real API rather than sending the key somewhere unexpected. */
export function baseUrlOf(v: string | undefined): string {
  const raw = (v ?? "").trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_BASE_URL;
  try {
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.username || u.password || u.search || u.hash) return DEFAULT_BASE_URL;
    if (u.protocol === "https:" || (u.protocol === "http:" && local)) return raw;
  } catch { /* not a URL */ }
  return DEFAULT_BASE_URL;
}

/** SUBQ_REASONING_EFFORT: a documented value (none|minimal|low|medium|high|xhigh|max) is sent as chat
 * `reasoning_effort`; "off"/"omit"/"unset"/"false"/"0" sends none at all; unset or anything else = "low". */
export function reasoningEffortOf(v: string | undefined): ReasoningEffort | null {
  const m = (v ?? "").trim().toLowerCase();
  if (["off", "omit", "unset", "false", "0"].includes(m)) return null;
  return (REASONING_EFFORTS as readonly string[]).includes(m) ? (m as ReasoningEffort) : DEFAULT_REASONING_EFFORT;
}

export function subqConfig(env: NodeJS.ProcessEnv): SubqConfig | null {
  const apiKey = env.SUBQ_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: baseUrlOf(env.SUBQ_BASE_URL),
    snapModel: env.SUBQ_SNAP_MODEL?.trim() || DEFAULT_SNAP_MODEL,
    chatModel: env.SUBQ_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL,
    reasoningEffort: reasoningEffortOf(env.SUBQ_REASONING_EFFORT),
  };
}

export function createSubq(env: NodeJS.ProcessEnv): Subq {
  const cfg = subqConfig(env);
  if (!cfg) return { router: null, auditor: null, diags: [] };
  const snap = new SnapClient(cfg);
  const mode = auditModeOf(env.SUBQ_AUDIT);
  return {
    router: createRouter(snap),
    auditor: mode === "off" ? null : createAuditor(snap, { mode }),
    diags: createDiags(cfg, { chat: Boolean(env.SUBQ_CHAT_MODEL?.trim()) }),
  };
}

// ---------- /admin/diag ----------
const DIAG_TIMEOUT_MS = 12_000;

/** Run one tiny real call; report the parsed summary plus the RAW response excerpt so wire formats can be fixed live. */
function diag(name: string, cfg: SubqConfig, run: () => Promise<{ ok: boolean; summary: string; raw: string }>): ProviderDiag {
  return {
    name,
    async check() {
      const t0 = Date.now();
      try {
        const r = await run();
        return { ok: r.ok, detail: `${r.summary} | raw: ${redact(r.raw, cfg.apiKey, EXCERPT_CHARS)}`, ms: Date.now() - t0 };
      } catch (e) {
        const err = e as SubqError;
        const detail = err instanceof SubqError && err.excerpt !== null
          ? `${err.code}${err.status ? ` ${err.status}` : ""} | raw: ${err.excerpt}`
          : redact(err?.message ?? String(e), cfg.apiKey, EXCERPT_CHARS);
        return { ok: false, detail, ms: Date.now() - t0 };
      }
    },
  };
}

/** `chat`: also list the chat model in subq-models and probe it (only when SUBQ_CHAT_MODEL is set: the chat client is
 * unwired, and the key has no chat model yet, so probing it by default would only show a red diag). */
export function createDiags(cfg: SubqConfig, opts: { chat?: boolean } = {}): ProviderDiag[] {
  const snap = new SnapClient(cfg);
  const chat = new ChatClient(cfg);
  return [
    diag("subq-models", cfg, async () => {
      const res = await subqRequest(cfg, { method: "GET", path: "/models", timeoutMs: DIAG_TIMEOUT_MS });
      const ids = parseModels(res.json);
      const missing = [cfg.snapModel, ...(opts.chat ? [cfg.chatModel] : [])].filter((m) => !ids.includes(m));
      // Model availability is per key (SubQ docs): a configured model missing from the list is a red flag, not ok.
      return {
        ok: ids.length > 0 && missing.length === 0,
        summary: `${new URL(cfg.baseUrl).host}: ${ids.length} models: ${ids.join(", ").slice(0, 300)}${missing.length ? ` (configured but not listed: ${missing.join(", ")})` : ""}`,
        raw: res.text,
      };
    }),
    diag("subq-snap", cfg, async () => {
      const r = await snap.decide("The sky is blue on a clear day.", {
        blue: { type: "noul", instructions: "The text says the sky is blue.", criteria: { true: "The text says the sky is blue", false: "The text does not say that" } },
      }, DIAG_TIMEOUT_MS);
      const p = noulOf(r.answers.blue);
      return { ok: p !== null, summary: `${cfg.snapModel} noul p=${p ?? "unparsed"} usage=${JSON.stringify(r.usage)}`, raw: r.raw };
    }),
    // The audit also needs choice + score; their request fields (criteria) are the least certain part of the wire.
    diag("subq-snap-typed", cfg, async () => {
      const levels = ["1 mild", "2 bad", "3 total outage"];
      const r = await snap.decide(
        "A tool returned HTTP 503 for every request for an hour, so the agent could not finish its task.",
        {
          kind: { type: "choice", instructions: "What kind of problem this is.", options: { outage: "The service was down", docs: "The docs were wrong" } },
          severity: { type: "score", instructions: "How severe the problem was.", levels },
        },
        DIAG_TIMEOUT_MS,
      );
      const choice = choiceOf(r.answers.kind, ["outage", "docs"]);
      const level = scoreLevelOf(r.answers.severity, levels);
      return { ok: choice !== null && level !== null, summary: `choice=${choice ?? "unparsed"} severity=${level ?? "unparsed"}/3`, raw: r.raw };
    }),
    // JSON mode as a job would use it: response_format json_schema (strict) + reasoning_effort. The summary says which
    // of them the server took; a refusal is dropped and its raw excerpt shown.
    ...(opts.chat ? [diag("subq-chat", cfg, async () => {
      const r = await chat.complete(
        [{ role: "user", content: 'Reply with exactly this JSON object and nothing else: {"ok": true}' }],
        { schema: DIAG_CHAT_FORMAT, timeoutMs: DIAG_TIMEOUT_MS, maxTokens: 200 },
      );
      let parsed = "unparsed";
      try {
        parsed = JSON.stringify(extractJson(r.text)).slice(0, 40);
      } catch { /* reported as unparsed */ }
      const dropped = r.dropped.map((d) => ` | dropped ${d.feature} (http ${d.status}): ${d.excerpt.slice(0, 200)}`).join("");
      return {
        ok: r.text.trim().length > 0,
        summary: `${cfg.chatModel} said ${JSON.stringify(r.text.slice(0, 80))} json=${parsed} finish=${r.finish_reason ?? "?"} ` +
          `response_format=${r.schema ? "json_schema" : "none"} reasoning_effort=${r.reasoning_effort ?? "none"} usage=${JSON.stringify(r.usage)}${dropped}`,
        raw: r.raw,
      };
    })] : []),
  ];
}
