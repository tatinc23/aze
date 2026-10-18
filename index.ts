// Entry point (mcp-use convention: export the server; the mcp-use CLI / Manufact starts it).
import { createStore } from "./src/store/index.js";
import { createPaywall } from "./src/pay/index.js";
import { createServer, recordSettledUnlock } from "./src/app.js";
import { DEFAULT_SETTINGS } from "./src/types.js";
import { buildRuntime } from "./src/runtime/deps.js";
import { providersLine, scheduleBootDiag } from "./src/web/diag.js";

const env = process.env;
const building = env.MCP_USE_PHASE === "build"; // mcp-use build imports this file; skip network side effects then
const store = createStore(env);

let paywall: Awaited<ReturnType<typeof createPaywall>> | null = null;
const runtimeRef: { current: ReturnType<typeof buildRuntime> | null } = { current: null };
// payTo: a Stripe sandbox crypto deposit address (Base Sepolia) when set, so test payments land in the Stripe sandbox
// balance; otherwise our own platform test wallet. Test mode only.
const payTo = env.STRIPE_DEPOSIT_ADDRESS || env.PLATFORM_ADDRESS;
if (payTo && !building) {
  try {
    const settings = await store.getSettings().catch(() => DEFAULT_SETTINGS);
    paywall = await createPaywall({
      facilitatorUrl: env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
      payTo,
      priceMicro: settings.price_micro,
      onSettled: (s) => recordSettledUnlock(store, s, runtimeRef.current),
    });
    console.log(`paywall ready: payTo=${payTo} (${env.STRIPE_DEPOSIT_ADDRESS ? "stripe sandbox deposit address" : "platform wallet"}) price_micro=${settings.price_micro}`);
  } catch (e) {
    console.error("paywall unavailable (notes_unlock will refuse without charging):", (e as Error).message);
  }
} else {
  console.warn("PLATFORM_ADDRESS / STRIPE_DEPOSIT_ADDRESS not set: notes_unlock disabled");
}

if (!building && store.kind === "supabase") {
  // Fails loudly if the migration hasn't been applied (missing tables/functions).
  Promise.all([store.getSettings(), store.stats()])
    .then(([s]) => console.log(`[store] supabase ok: settings price_micro=${s.price_micro} filer_bps=${s.filer_bps}`))
    .catch((e) => console.error("[store] supabase NOT ready (apply supabase/migrations/0001_init.sql):", (e as Error).message));
}

const runtime = buildRuntime(env, store);
runtimeRef.current = runtime;
const server = createServer({ store, paywall, baseUrl: env.MCP_URL, adminKey: env.ADMIN_KEY, runtime });
if (!building) console.log(providersLine(runtime));
// DIAG_ON_BOOT=1: one DIAG line in the runtime logs 10 s after boot (every provider check from this machine, details
// redacted and cut to 300 chars), so a deploy can be verified from Manufact's logs without calling /admin/diag.
if (!building && env.DIAG_ON_BOOT === "1") scheduleBootDiag(runtime.diags, { env });

if (!building && env.SELFTEST_ON_BOOT === "1" && env.MCP_URL && env.BUYER_PRIVATE_KEY) {
  // Lets us prove the live loop from Manufact's runtime logs when the dev container can't reach the server.
  setTimeout(async () => {
    const { runDemo } = await import("./demo/run.js");
    // Call this container directly: the public URL may still route to the previous deployment during rollout.
    await runDemo({ url: `http://localhost:${env.PORT ?? 3000}/mcp`, buyerKey: env.BUYER_PRIVATE_KEY!, filerAddress: env.DEMO_FILER_ADDRESS, log: (m) => console.log("SELFTEST", m) })
      .catch((e) => console.error("SELFTEST failed:", e));
  }, 8000);
}

export default server;
