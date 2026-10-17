// Entry point (mcp-use convention: export the server; the mcp-use CLI / Manufact starts it).
import { createStore } from "./src/store/index.js";
import { createPaywall } from "./src/pay/index.js";
import { createServer, recordSettledUnlock } from "./src/server.js";
import { DEFAULT_SETTINGS } from "./src/types.js";

const env = process.env;
const store = createStore(env);

let paywall: Awaited<ReturnType<typeof createPaywall>> | null = null;
if (env.PLATFORM_ADDRESS) {
  try {
    const settings = await store.getSettings().catch(() => DEFAULT_SETTINGS);
    paywall = await createPaywall({
      facilitatorUrl: env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
      payTo: env.PLATFORM_ADDRESS,
      priceMicro: settings.price_micro,
      onSettled: (s) => recordSettledUnlock(store, s),
    });
    console.log(`paywall ready: payTo=${env.PLATFORM_ADDRESS} price_micro=${settings.price_micro}`);
  } catch (e) {
    console.error("paywall unavailable (notes_unlock will refuse without charging):", (e as Error).message);
  }
} else {
  console.warn("PLATFORM_ADDRESS not set: notes_unlock disabled");
}

const server = createServer({ store, paywall, baseUrl: env.MCP_URL, adminKey: env.ADMIN_KEY });

if (env.SELFTEST_ON_BOOT === "1" && env.MCP_URL && env.BUYER_PRIVATE_KEY) {
  // Lets us prove the live loop from Manufact's runtime logs when the dev container can't reach the server.
  setTimeout(async () => {
    const { runDemo } = await import("./demo/run.js");
    await runDemo({ url: env.MCP_URL!.replace(/\/$/, "") + (env.MCP_URL!.endsWith("/mcp") ? "" : "/mcp"), buyerKey: env.BUYER_PRIVATE_KEY!, filerAddress: env.DEMO_FILER_ADDRESS, log: (m) => console.log("SELFTEST", m) })
      .catch((e) => console.error("SELFTEST failed:", e));
  }, 8000);
}

export default server;
