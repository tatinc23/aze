// Builds the runtime's dependencies once at boot. Side-effect free (no network): providers are checked lazily via
// /admin/diag. Each factory lives in its stream's module and returns null when its env vars are missing.
import type { Store } from "../types.js";
import type { RuntimeDeps } from "./types.js";
import { createRunStore } from "./store.js";
import { createExecutors } from "./executors.js";
import { createSubq } from "../subq/index.js";
import { createRenderer } from "../llm/workers-ai.js";
import { argsBackendOf, createWorkersAiChat } from "../llm/workers-ai-chat.js";
import { createArgFiller, createDistiller, createNoteWriter } from "../subq/chat.js";
import { createStripeRail } from "../pay/stripe.js";

export function buildRuntime(env: NodeJS.ProcessEnv, store: Store): RuntimeDeps {
  const subq = createSubq(env);
  const render = createRenderer(env);
  const exec = createExecutors(env, store);
  const stripe = createStripeRail(env);
  // ARGS_BACKEND (default workers-ai): the SubQ key has only subq-snap-preview, so subq-preview chat would 403 on every
  // args/distill/notes call. Snap (router + note audit) stays on SubQ either way. No CF credentials -> those tiers off.
  const chatBackend = argsBackendOf(env.ARGS_BACKEND);
  const wai = chatBackend === "workers-ai" ? createWorkersAiChat(env) : null;
  const chat = chatBackend === "subq"
    ? { args: subq.args, distiller: subq.distiller, noteWriter: subq.noteWriter }
    : wai
      ? { args: createArgFiller(wai), distiller: createDistiller(wai), noteWriter: createNoteWriter(wai) }
      : { args: null, distiller: null, noteWriter: null };
  return {
    runs: createRunStore(env),
    router: subq.router,
    ...chat,
    auditor: subq.auditor,
    renderer: render.renderer,
    executors: exec.executors,
    diags: [...subq.diags, ...render.diags, ...exec.diags, ...stripe.diags],
    payments: stripe.plugin,
    chatBackend,
  };
}
