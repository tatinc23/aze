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
import { createWorkersAiSystemOne } from "../llm/workers-ai-systemone.js";
import { createRouter } from "../subq/snap.js";
import { createEnsembleRouter, type Voter } from "../subq/ensemble.js";

export function buildRuntime(env: NodeJS.ProcessEnv, store: Store): RuntimeDeps {
  const subq = createSubq(env);
  const render = createRenderer(env);
  const exec = createExecutors(env, store);
  const stripe = createStripeRail(env);
  // Two System One models route together: SubQ Snap and, with CF credentials, a fast Workers AI model answering the
  // same questions (SYSTEM_ONE_CF=off turns the second one off). Either alone still routes.
  const cfOne = createWorkersAiSystemOne(env);
  const voters: Voter[] = [
    ...(subq.router ? [{ label: "SubQ Snap", router: subq.router, priced: true }] : []),
    ...(cfOne ? [{ label: "Workers AI", router: createRouter(cfOne.decider), priced: false }] : []),
  ];
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
    router: createEnsembleRouter(voters),
    ...chat,
    auditor: subq.auditor,
    renderer: render.renderer,
    executors: exec.executors,
    diags: [...subq.diags, ...(cfOne?.diags ?? []), ...render.diags, ...exec.diags, ...stripe.diags],
    payments: stripe.plugin,
    chatBackend,
  };
}
