// Builds the runtime's dependencies once at boot. Side-effect free (no network): providers are checked lazily via
// /admin/diag. Each factory lives in its stream's module and returns null when its env vars are missing.
import type { Store } from "../types.js";
import type { RuntimeDeps } from "./types.js";
import { createRunStore } from "./store.js";
import { createExecutors } from "./executors.js";
import { createSubq } from "../subq/index.js";
import { createRenderer } from "../llm/workers-ai.js";
import { createStripeRail } from "../pay/stripe.js";

export function buildRuntime(env: NodeJS.ProcessEnv, store: Store): RuntimeDeps {
  const subq = createSubq(env);
  const render = createRenderer(env);
  const exec = createExecutors(env, store);
  const stripe = createStripeRail(env);
  return {
    runs: createRunStore(env),
    router: subq.router,
    args: subq.args,
    distiller: subq.distiller,
    noteWriter: subq.noteWriter,
    auditor: subq.auditor,
    renderer: render.renderer,
    executors: exec.executors,
    diags: [...subq.diags, ...render.diags, ...exec.diags, ...stripe.diags],
    payments: stripe.plugin,
  };
}
