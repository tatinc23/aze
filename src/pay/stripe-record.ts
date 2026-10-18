// D1: record each settled x402 unlock (Base Sepolia test USDC, settled by the x402 facilitator) in Stripe test mode
// as a crypto PaymentIntent in transaction_verification mode, the way stripe-samples/machine-payments' x402 server
// does in onAfterSettle. Never throws: the payment already settled on-chain and our ledger rows are written.
import type { SettledUnlock } from "../runtime/types.js";
import {
  KEEP_RESULTS, PI_OK_STATUSES, TX_HASH_RE, X402_SETTLED_NETWORKS, describeStripeError, excerpt, microToCents, piSummary,
  redact, stripeErrorInfo, x402PaymentIntentParams,
} from "./stripe-wire.js";

/** The subset of the Stripe SDK client stream D uses (the real `Stripe` instance satisfies it). */
export interface StripeLike {
  paymentIntents: { create(params: any, options?: any): Promise<any> };
  balance: { retrieve(params?: any, options?: any): Promise<any> };
  rawRequest(method: string, path: string, params?: any, options?: any): Promise<any>;
}

export interface Logger { log(msg: string): void; warn(msg: string): void; error(msg: string): void }
export const consoleLogger: Logger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

export interface RecordResult {
  at: string;
  tx_hash: string;
  note_id: string;
  cents: number;
  network: string; // the Stripe network we asked to verify on
  ok: boolean;
  skipped: boolean;
  pi_id: string | null;
  status: string | null;
  reason: string | null;
}

export interface X402Recorder {
  onSettled(s: SettledUnlock): Promise<void>;
  /** Newest first, at most 20. */
  recent(): RecordResult[];
}

export function createX402Recorder(opts: {
  stripe: StripeLike;
  network: string;
  apiVersion: string;
  secrets?: string[];
  log?: Logger;
  timeoutMs?: number;
  /** Longest the paid x402 response waits for Stripe; after that the recording finishes in the background. */
  waitMs?: number;
  now?: () => Date;
  /**
   * When set, every settlement is skipped (no Stripe call) with this reason. Used when payTo is not a Stripe deposit
   * address: Stripe can only verify money that reached its own deposit address, and recording money that never
   * reached Stripe would put a false row in the Stripe sandbox.
   */
  skipReason?: string | null;
  /** x402 settlement networks to record (default: Base Sepolia only; a Stripe sandbox's "base" is Base Sepolia). */
  acceptNetworks?: ReadonlySet<string>;
}): X402Recorder {
  const log = opts.log ?? consoleLogger;
  const secrets = opts.secrets ?? [];
  const now = opts.now ?? (() => new Date());
  const acceptNetworks = opts.acceptNetworks ?? X402_SETTLED_NETWORKS;
  const results: RecordResult[] = [];
  const keep = (r: RecordResult) => {
    results.unshift(r);
    results.length = Math.min(results.length, KEEP_RESULTS);
  };

  async function record(s: SettledUnlock): Promise<void> {
    const tx = typeof s?.tx_hash === "string" ? s.tx_hash.trim() : "";
    const base = {
      at: now().toISOString(),
      tx_hash: tx,
      note_id: typeof s?.note_id === "string" ? s.note_id : String(s?.note_id ?? ""),
      network: opts.network,
      pi_id: null as string | null,
      status: null as string | null,
    };
    try {
      const cents = microToCents(Number(s?.amount_micro));
      if (!tx) {
        const reason = "settlement has no transaction hash";
        log.error(`STRIPE record failed: ${reason}`);
        keep({ ...base, cents, ok: false, skipped: true, reason });
        return;
      }
      if (!TX_HASH_RE.test(tx)) {
        const reason = "settlement transaction is not an EVM tx hash (0x + 64 hex)";
        log.error(`STRIPE record failed: ${reason} tx=${redact(tx, secrets).slice(0, 80)}`);
        keep({ ...base, tx_hash: redact(tx, secrets).slice(0, 80), cents, ok: false, skipped: true, reason });
        return;
      }
      if (opts.skipReason) {
        log.warn(`STRIPE record skipped: ${opts.skipReason} tx=${tx}`);
        keep({ ...base, cents, ok: false, skipped: true, reason: opts.skipReason });
        return;
      }
      const settledOn = typeof s?.network === "string" ? s.network : "";
      if (!acceptNetworks.has(settledOn)) {
        const reason = `x402 settled on ${redact(settledOn, secrets).slice(0, 40) || "an unknown network"}, not Base Sepolia (a Stripe sandbox only verifies Base Sepolia as "base")`;
        log.warn(`STRIPE record skipped: ${reason} tx=${tx}`);
        keep({ ...base, cents, ok: false, skipped: true, reason });
        return;
      }
      if (cents < 1) {
        const reason = `amount_micro=${s?.amount_micro} rounds to ${cents} cents (Stripe minimum is 1 cent)`;
        log.warn(`STRIPE record skipped: ${reason} tx=${tx}`);
        keep({ ...base, cents, ok: false, skipped: true, reason });
        return;
      }
      const pi = await opts.stripe.paymentIntents.create(x402PaymentIntentParams({ ...s, tx_hash: tx }, opts.network, cents), {
        idempotencyKey: tx,
        apiVersion: opts.apiVersion,
        timeout: opts.timeoutMs ?? 8_000,
        maxNetworkRetries: 1, // safe: the tx hash is the idempotency key
      });
      const sum = piSummary(pi);
      if (!sum.id) {
        const reason = `no PaymentIntent id in Stripe's answer: ${excerpt(pi, secrets, 200)}`;
        log.error(`STRIPE record failed: ${reason} tx=${tx}`);
        keep({ ...base, cents, ok: false, skipped: false, reason });
        return;
      }
      if (sum.livemode === true) {
        // Can't happen with an sk_test_ key; if it ever does, shout instead of counting it as a test recording.
        const reason = `PaymentIntent ${sum.id} is LIVE MODE (livemode=true): test mode only`;
        log.error(`!!! STRIPE record failed: ${reason} tx=${tx}`);
        keep({ ...base, cents, ok: false, skipped: false, pi_id: sum.id, status: sum.status, reason });
        return;
      }
      if (sum.status !== null && !PI_OK_STATUSES.has(sum.status)) {
        const reason = `PaymentIntent ${sum.id} status=${sum.status}`;
        log.error(`STRIPE record failed: ${reason} tx=${tx}`);
        keep({ ...base, cents, ok: false, skipped: false, pi_id: sum.id, status: sum.status, reason });
        return;
      }
      log.log(`STRIPE recorded pi=${sum.id} tx=${tx} status=${sum.status ?? "unknown"} cents=${cents} network=${opts.network}`);
      keep({ ...base, cents, ok: true, skipped: false, pi_id: sum.id, status: sum.status, reason: null });
    } catch (e) {
      let reason: string;
      let pi: string | null = null;
      try {
        const info = stripeErrorInfo(e, secrets);
        reason = describeStripeError(info);
        pi = info.payment_intent;
      } catch {
        reason = "unknown error";
      }
      try {
        log.error(`STRIPE record failed: ${reason} tx=${tx}`);
        keep({ ...base, cents: microToCents(Number(s?.amount_micro)), ok: false, skipped: false, pi_id: pi, reason });
      } catch {
        // a broken logger must not break the paid response either
      }
    }
  }

  // @x402/mcp awaits onAfterSettlement before answering the paying agent, so bound how long Stripe can hold it.
  async function onSettled(s: SettledUnlock): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = record(s).catch(() => {}); // record() already catches; belt and braces
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, opts.waitMs ?? 3_000);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([work, waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    onSettled,
    recent: () => results.map((r) => ({ ...r })),
  };
}

/** One line for /admin/diag about recent D1 results. */
export function summarizeRecent(results: RecordResult[], secrets: string[] = []): string {
  if (!results.length) return "D1: no x402 settlements recorded since boot";
  const ok = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const last = results[0];
  const lastText = last.ok
    ? `last ok pi=${last.pi_id} status=${last.status} tx=${last.tx_hash.slice(0, 12)}…`
    : `last ${last.skipped ? "skipped" : "failed"}: ${redact(last.reason ?? "", secrets).slice(0, 160)}`;
  return `D1: ${ok}/${results.length} recorded (${skipped} skipped), ${lastText}`;
}
