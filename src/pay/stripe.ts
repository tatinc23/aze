// Stream D: Stripe machine payments. D1: record x402 settlements as Stripe PaymentIntents (transaction_verification).
// D2: MPP (Shared Payment Tokens) card path for unlocks, test mode. Never live mode.
//
// Env: STRIPE_SECRET_KEY (sk_test_ only; anything else turns the rail off), STRIPE_PROFILE_ID (enables D2),
// STRIPE_X402_NETWORK (default "base": Base Sepolia in a Stripe sandbox, per Muse M2), STRIPE_PREVIEW_API_VERSION
// (default "2026-07-29.preview"), STRIPE_DEPOSIT_ADDRESS (the x402 payTo index.ts uses; D1 records only when it is set,
// because Stripe can only verify money sent to its own deposit address), STRIPE_RECORD_X402=0 (D1 off) or =1 (record
// even without STRIPE_DEPOSIT_ADDRESS), STRIPE_DIAG_CREATE_ADDRESS=1 (lets /admin/diag create a deposit address, which
// is permanent; default read-only), MPP_SECRET_KEY (optional; else derived from the Stripe key like the sample),
// MPP_REALM (optional; else the MCP_URL host). Side-effect free: no network until a payment or /admin/diag.
import Stripe from "stripe";
import type { PaymentsPlugin, ProviderDiag } from "../runtime/types.js";
import { createStripeDiags } from "./stripe-diag.js";
import { createCardUnlock, type CardUnlock } from "./stripe-mpp.js";
import { consoleLogger, createX402Recorder, type Logger, type StripeLike, type X402Recorder } from "./stripe-record.js";
import { PREVIEW_API_VERSION_DEFAULT, X402_NETWORK_DEFAULT, checkStripeKey, normalizeBaseUrl } from "./stripe-wire.js";

export interface StripeRail {
  plugin: PaymentsPlugin | null;
  diags: ProviderDiag[];
  /** Exposed for tests and the diag. */
  recorder?: X402Recorder;
  card?: CardUnlock | null;
}

/** The real Stripe SDK client, on fetch (so tests can stub it) with tight timeouts. */
export function createStripeClient(key: string): StripeLike {
  return new Stripe(key, {
    appInfo: { name: "aze", version: "0.1.0" },
    httpClient: Stripe.createFetchHttpClient(((input: any, init: any) => globalThis.fetch(input, init)) as typeof fetch),
    maxNetworkRetries: 1,
    timeout: 15_000,
    telemetry: false,
  }) as unknown as StripeLike;
}

function hostOf(url: string): string | undefined {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}

export function createStripeRail(
  env: NodeJS.ProcessEnv,
  overrides: { stripe?: StripeLike; log?: Logger; recordWaitMs?: number } = {},
): StripeRail {
  const log = overrides.log ?? consoleLogger;
  const key = checkStripeKey(env.STRIPE_SECRET_KEY);
  if (!key.ok) {
    if (key.reason === "live") log.warn("[stripe] STRIPE_SECRET_KEY is a LIVE key: refused. Stripe rail is TEST MODE ONLY (use sk_test_). Stripe payments off.");
    else if (key.reason === "not_test_secret") log.warn("[stripe] STRIPE_SECRET_KEY is not an sk_test_ secret key: Stripe payments off.");
    return { plugin: null, diags: [] };
  }

  const stripe = overrides.stripe ?? createStripeClient(key.key);
  const network = (env.STRIPE_X402_NETWORK ?? "").trim() || X402_NETWORK_DEFAULT;
  const apiVersion = (env.STRIPE_PREVIEW_API_VERSION ?? "").trim() || PREVIEW_API_VERSION_DEFAULT;
  const mppSecretKey = (env.MPP_SECRET_KEY ?? "").trim() || undefined;
  const secrets = [key.key, mppSecretKey ?? ""].filter(Boolean);
  const recordX402 = env.STRIPE_RECORD_X402 !== "0";
  const depositAddress = (env.STRIPE_DEPOSIT_ADDRESS ?? "").trim() || null;
  // payTo is our own wallet when STRIPE_DEPOSIT_ADDRESS is unset (index.ts): that money never reaches Stripe, so don't
  // ask Stripe to verify it (it would fail, or worse, record money Stripe never received). =1 forces recording.
  const skipReason = depositAddress || env.STRIPE_RECORD_X402 === "1"
    ? null
    : "payTo is the platform wallet, not a Stripe deposit address (set STRIPE_DEPOSIT_ADDRESS, or STRIPE_RECORD_X402=1 to record anyway)";
  const d1 = !recordX402 ? "off" : skipReason ? "skipped" : "on";

  const recorder = createX402Recorder({ stripe, network, apiVersion, secrets, log, waitMs: overrides.recordWaitMs, skipReason });

  const profileId = (env.STRIPE_PROFILE_ID ?? "").trim() || null;
  const baseUrl = normalizeBaseUrl(env.MCP_URL);
  const card = profileId
    ? createCardUnlock({
        stripe,
        stripeKey: key.key,
        profileId,
        mppSecretKey,
        realm: (env.MPP_REALM ?? "").trim() || hostOf(baseUrl),
        baseUrl,
        log,
      })
    : null;

  const plugin: PaymentsPlugin = {
    ...(recordX402 ? { onSettled: recorder.onSettled } : {}),
    ...(card
      ? {
          registerTools: (server: any, deps: { store: import("../types.js").Store }) => card.registerTool(server, deps.store),
          registerRoutes: (app: any, deps: { store: import("../types.js").Store; baseUrl?: string }) => card.registerRoutes(app, deps.store, deps.baseUrl),
        }
      : {}),
  };

  const diags = createStripeDiags({
    stripe,
    secrets,
    network,
    apiVersion,
    recorder,
    depositAddress,
    d1,
    createAddress: env.STRIPE_DIAG_CREATE_ADDRESS === "1",
    card,
    profileId,
  });

  const d1Text = d1 === "on" ? `on (network=${network} api=${apiVersion})` : d1 === "off" ? "off" : "skipped (payTo is not a Stripe deposit address)";
  log.log(`[stripe] test mode: D1 x402 recording ${d1Text}; D2 card unlock ${card ? "on" : "off (no STRIPE_PROFILE_ID)"}`);
  return { plugin, diags, recorder, card };
}
