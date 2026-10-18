// Workers AI as the chat backend for the arg filler, distiller and note writer (ARGS_BACKEND=workers-ai, the default
// while Ken's SubQ key has only subq-snap-preview). Same REST call, models, reasoning effort and redaction as the
// renderer (./workers-ai.ts); the primary model gets 2/3 of the caller's budget so the fallback still has time.
// No response_format is sent (not every Workers AI model honors it, and nothing here can check it live): the
// factories already ask for one JSON object, extract it robustly, validate it, and retry once.
// Cost stays null for these tiers unless a Workers AI price is configured (never invented).
import type { ChatBackend, ChatResult } from "../subq/chat.js";
import type { ChatMessage, JsonSchemaFormat } from "../subq/wire.js";
import type { Usage } from "../runtime/types.js";
import { WorkersAiError, cleanAnswer, runModel, workersAiConfig, type WorkersAiConfig } from "./workers-ai.js";

/** Same per-call budget as SubQ chat (src/subq/chat.ts CHAT_TIMEOUT_MS) unless the caller passes one. */
export const CHAT_BUDGET_MS = 30_000;
/** A fallback call is only worth starting with at least this much budget left. */
export const MIN_FALLBACK_MS = 3_000;

const ZERO: Usage = { input_tokens: 0, output_tokens: 0 };
const add = (a: Usage, b: Usage): Usage => ({ input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens });
const reasonOf = (e: unknown): string =>
  e instanceof WorkersAiError ? e.message : `error: ${String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 120)}`;

export class WorkersAiChat implements ChatBackend {
  readonly provider = "workers-ai";
  constructor(private readonly cfg: WorkersAiConfig) {}
  get model(): string {
    return this.cfg.model;
  }

  async complete(
    messages: ChatMessage[],
    opts: { schema?: JsonSchemaFormat | null; timeoutMs?: number; maxTokens?: number } = {},
  ): Promise<ChatResult> {
    const t0 = Date.now();
    const budget = opts.timeoutMs ?? CHAT_BUDGET_MS;
    const models = [this.cfg.model, ...(this.cfg.fallbackModel ? [this.cfg.fallbackModel] : [])];
    // Thinking models spend tokens before answering: never ask for fewer than the renderer's floor.
    const maxTokens = Math.max(opts.maxTokens ?? 0, this.cfg.maxTokens);
    const failures: string[] = [];
    let usage: Usage = { ...ZERO };
    for (let i = 0; i < models.length; i++) {
      const left = budget - (Date.now() - t0);
      if (i > 0 && left < MIN_FALLBACK_MS) {
        failures.push(`${models[i]} skipped (no time left)`);
        break;
      }
      const share = i + 1 < models.length ? Math.floor(left * 2 / 3) : left;
      try {
        const r = await runModel(this.cfg, models[i], messages, { timeoutMs: Math.max(1, share), maxTokens });
        usage = add(usage, r.usage); // tokens of an empty primary reply were still spent
        const text = cleanAnswer(r.text);
        if (text) {
          return {
            text, usage, ms: Date.now() - t0, raw: r.raw, finish_reason: r.finish_reason,
            schema: null, reasoning_effort: this.cfg.reasoningEffort, dropped: [],
          };
        }
        failures.push(`${models[i]} gave no answer text${r.finish_reason ? ` (finish ${r.finish_reason})` : ""}`);
      } catch (e) {
        failures.push(`${models[i]} ${reasonOf(e)}`);
      }
      if (i + 1 < models.length) console.warn(`[workers-ai] chat: ${failures[failures.length - 1]}; trying ${models[i + 1]}`);
    }
    const err = new WorkersAiError("all_failed", `workers-ai chat failed: ${failures.join("; ")}`);
    if (usage.input_tokens + usage.output_tokens > 0) err.usage = usage;
    throw err;
  }
}

/** The Workers AI chat backend, or null without CF credentials (or with malformed ones: the renderer's diag says why).
 * No diags of its own: the renderer's workers-ai diags check the same models with the same credentials. */
export function createWorkersAiChat(env: NodeJS.ProcessEnv): WorkersAiChat | null {
  const { cfg } = workersAiConfig(env);
  return cfg ? new WorkersAiChat(cfg) : null;
}

export type ArgsBackend = "workers-ai" | "subq";

/** ARGS_BACKEND: "subq" uses subq-preview chat (once the key has it); anything else, unset included, is Workers AI. */
export function argsBackendOf(v: string | undefined): ArgsBackend {
  return (v ?? "").trim().toLowerCase() === "subq" ? "subq" : "workers-ai";
}
