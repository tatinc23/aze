// /admin/diag checks for stream D. Each makes tiny read-only calls (from Manufact, which can reach Stripe) and reports
// the parsed summary plus the RAW response excerpt (redacted: no keys, no addresses) so wire formats can be fixed live.
// Nothing permanent is created unless STRIPE_DIAG_CREATE_ADDRESS=1.
import type { ProviderDiag } from "../runtime/types.js";
import type { CardUnlock } from "./stripe-mpp.js";
import type { StripeLike, X402Recorder } from "./stripe-record.js";
import { summarizeRecent } from "./stripe-record.js";
import {
  EVM_ADDRESS_RE, balanceSummary, depositAddressListPath, depositAddressSummary, describeStripeError, excerpt, listHasAddress, listed,
  mask, stripeErrorInfo,
} from "./stripe-wire.js";

const DIAG_TIMEOUT_MS = 6_000; // /admin/diag gives each check 15 s; no retries so one slow call can't eat it
const DIAG_REQ = { timeout: DIAG_TIMEOUT_MS, maxNetworkRetries: 0 };
// The network probe can make two calls in a row (list, then the opt-in create), so each gets less: 2 × 5 s < 15 s.
const PROBE_REQ = { timeout: 5_000, maxNetworkRetries: 0 };
/** Stripe's largest list page: enough to find STRIPE_DEPOSIT_ADDRESS among the account's deposit addresses. */
const LIST_LIMIT = 100;

function timed(name: string, run: () => Promise<{ ok: boolean; detail: string }>): ProviderDiag {
  return {
    name,
    async check() {
      const t0 = Date.now();
      try {
        const r = await run();
        return { ...r, ms: Date.now() - t0 };
      } catch (e) {
        return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 300), ms: Date.now() - t0 };
      }
    },
  };
}

interface Probe {
  /** Stripe answered the list call for this network (so it knows the network name). */
  accepted: boolean;
  /** STRIPE_DEPOSIT_ADDRESS is one of the listed deposit addresses (null: no address to look for, or no list). */
  payToListed: boolean | null;
  text: string;
}

/**
 * Does Stripe know `network` for crypto deposit addresses, and is our payTo one of them? Read-only by default: one GET
 * list call (Stripe has no dry-run for creating a deposit address). Only with `create` (STRIPE_DIAG_CREATE_ADDRESS=1)
 * and an empty list does it create one, which is permanent. Never reports an address (redacted; nothing is kept).
 */
async function probeNetwork(
  stripe: StripeLike, network: string, apiVersion: string, secrets: string[], chars: number,
  o: { payTo: string | null; create: boolean },
): Promise<Probe> {
  const opts = { ...PROBE_REQ, apiVersion };
  let list: unknown;
  try {
    list = await stripe.rawRequest("GET", depositAddressListPath(network, LIST_LIMIT), undefined, opts);
  } catch (e) {
    const i = stripeErrorInfo(e, secrets);
    const verdict = i.status === null ? "NO ANSWER" : "REJECTED";
    return { accepted: false, payToListed: null, text: `network=${network}: list ${verdict} ${describeStripeError(i)}${i.raw ? ` raw: ${i.raw.slice(0, chars)}` : ""}` };
  }
  const items = listed(list);
  const hasMore = (list as { has_more?: unknown } | null)?.has_more === true;
  const payToListed = o.payTo ? listHasAddress(list, o.payTo) : null;
  const first = items[0] ? depositAddressSummary(items[0]) : null;
  const payToText = payToListed === null ? "" : payToListed ? " payTo=LISTED" : ` payTo=NOT LISTED${hasMore ? ` (not in the first ${LIST_LIMIT})` : ""}`;
  const head = `network=${network}: ACCEPTED (list ok: ${items.length}${hasMore ? "+" : ""} address(es)${first ? `, first id=${first.id ?? "?"} network=${first.network ?? "?"} livemode=${first.livemode}` : ""})${payToText}`;
  if (items.length > 0 || !o.create) {
    const createNote = items.length === 0 ? "; none exists and nothing was created (set STRIPE_DIAG_CREATE_ADDRESS=1 to create one; permanent)" : "; nothing created";
    return { accepted: true, payToListed, text: `${head}${createNote} raw: ${excerpt(list, secrets, chars)}` };
  }
  // Opt-in: create one (permanent; like mppx's findOrCreateDepositAddress). Its address is redacted here: read it in the
  // Stripe dashboard (or with the Stripe CLI) and set STRIPE_DEPOSIT_ADDRESS to it.
  try {
    const res = await stripe.rawRequest("POST", "/v1/crypto/deposit_addresses", { network }, opts);
    const c = depositAddressSummary(res);
    return {
      accepted: true,
      payToListed,
      text: `${head}; CREATED (STRIPE_DIAG_CREATE_ADDRESS=1) id=${c.id ?? "?"} network=${c.network ?? "?"} livemode=${c.livemode} has_address=${c.has_address} raw: ${excerpt(res, secrets, chars)}`,
    };
  } catch (e) {
    const i = stripeErrorInfo(e, secrets);
    return { accepted: true, payToListed, text: `${head}; create FAILED ${describeStripeError(i)}${i.raw ? ` raw: ${i.raw.slice(0, chars)}` : ""}` };
  }
}

export function createStripeDiags(opts: {
  stripe: StripeLike;
  secrets: string[];
  network: string;
  apiVersion: string;
  recorder: X402Recorder;
  /** STRIPE_DEPOSIT_ADDRESS (index.ts uses it as the x402 payTo when set). Compared, never printed. */
  depositAddress: string | null;
  /** "on" records settlements; "skipped" means D1 is on but skips every settlement (payTo isn't a Stripe address). */
  d1: "on" | "off" | "skipped";
  /** STRIPE_DIAG_CREATE_ADDRESS=1: the network probe may create a deposit address (permanent) when none exists. */
  createAddress: boolean;
  card: CardUnlock | null;
  profileId: string | null;
}): ProviderDiag[] {
  const { stripe, secrets } = opts;
  return [
    timed("stripe", async () => {
      try {
        const bal = await stripe.balance.retrieve(undefined, DIAG_REQ);
        const s = balanceSummary(bal);
        return {
          ok: s.livemode === false,
          detail: `livemode=${s.livemode} currencies=${s.currencies.join(",") || "none"}${s.livemode === false ? "" : " (expected livemode=false: TEST MODE ONLY)"} | raw: ${excerpt(bal, secrets)}`,
        };
      } catch (e) {
        const i = stripeErrorInfo(e, secrets);
        return { ok: false, detail: `${describeStripeError(i)} | raw: ${i.raw}` };
      }
    }),

    // Read-only by default: does Stripe know our x402 network, and is payTo one of the account's deposit addresses
    // (D1 can only verify a transaction that paid one)? "base" is listed too when another network is configured.
    timed("stripe-x402-network", async () => {
      const payTo = opts.depositAddress;
      const payToValid = payTo !== null && EVM_ADDRESS_RE.test(payTo);
      const networks = opts.network === "base" ? ["base"] : [opts.network, "base"];
      const per = Math.floor(400 / networks.length);
      const probes = await Promise.all(networks.map((n, i) =>
        probeNetwork(stripe, n, opts.apiVersion, secrets, per, { payTo: payToValid ? payTo : null, create: opts.createAddress && i === 0 })));
      const configured = probes[0];
      const hint = !configured.accepted && probes[1]?.accepted ? " -> try STRIPE_X402_NETWORK=base" : "";
      const payToKind = payTo === null
        ? "platform-wallet (STRIPE_DEPOSIT_ADDRESS unset: Stripe can't verify a tx it didn't receive)"
        : payToValid ? "stripe-deposit-address" : "STRIPE_DEPOSIT_ADDRESS is not an EVM address (0x + 40 hex)";
      // Green only when D1 can actually record: Stripe knows the network and payTo is one of its deposit addresses.
      const ok = configured.accepted && (opts.d1 === "off" || (payToValid && configured.payToListed === true));
      return {
        ok,
        detail:
          `configured=${opts.network} api=${opts.apiVersion} D1=${opts.d1} payTo=${payToKind} create=${opts.createAddress ? "opt-in on" : "off"}${hint} | ` +
          `${summarizeRecent(opts.recorder.recent(), secrets)} | ${probes.map((p) => p.text).join(" || ")}`,
      };
    }),

    timed("stripe-mpp", async () => {
      if (!opts.profileId || !opts.card) {
        // D2 is optional: off is a configuration, not a failure, so it doesn't turn /admin/diag red.
        return { ok: true, detail: "D2 card unlock OFF (optional): STRIPE_PROFILE_ID not set; notes_unlock_card is not offered. D1 is unaffected. livemode=false" };
      }
      const ch = await opts.card.probeChallenge();
      return {
        ok: true,
        detail: `configured profile=${mask(opts.profileId)} livemode=false tool=notes_unlock_card route=/api/unlock-card link=${opts.card.link("NOTE_ID")} | challenge (local, no network): ${excerpt(ch, [...secrets, opts.profileId])}`,
      };
    }),
  ];
}
