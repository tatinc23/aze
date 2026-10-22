// Builds the runtime's dependencies once at boot. Side-effect free (no network): providers are checked lazily via
// /admin/diag. Each factory lives in its stream's module and returns null when its env vars are missing.
// Decide-only (Ken, 2026-10-20): SubQ Snap is the one model. It routes agent_run and audits notes; the caller's own LLM
// does everything else, so there is no args, distill, render or note-writer tier.
import type { RuntimeDeps } from "./types.js";
import { createRunStore } from "./store.js";
import { createSubq } from "../subq/index.js";
import { createStripeRail } from "../pay/stripe.js";

export function buildRuntime(env: NodeJS.ProcessEnv): RuntimeDeps {
  const subq = createSubq(env);
  const stripe = createStripeRail(env);
  return {
    runs: createRunStore(env),
    router: subq.router,
    auditor: subq.auditor,
    diags: [...subq.diags, ...stripe.diags],
    payments: stripe.plugin,
  };
}
