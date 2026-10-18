// Stream D wire formats, isolated so they can be corrected from the live /admin/diag output (this container can't
// reach Stripe). Sources: docs/muse/m1-m2-provider-facts.md (M2, verified from docs.stripe.com/payments/machine/x402
// and stripe-samples/machine-payments), and mppx@0.8.19's own Stripe code
// (node_modules/mppx/dist/stripe/server/internal/record-payment.js). Nothing here does I/O.
import type { SettledUnlock } from "../runtime/types.js";

/** Stripe preview API version for crypto deposit addresses and crypto PaymentIntents (M2; same as mppx 0.8.19). */
export const PREVIEW_API_VERSION_DEFAULT = "2026-07-29.preview";
/**
 * Stripe `network` for both the deposit address and transaction_verification (M2, verified). In a Stripe sandbox
 * "base" means Base Sepolia; there is no "base_sepolia". STRIPE_X402_NETWORK overrides it.
 */
export const X402_NETWORK_DEFAULT = "base";
/**
 * x402 settlement networks D1 may record: Base Sepolia only (CAIP-2 as @x402 v2 reports it, and the v1 name), because a
 * Stripe sandbox's "base" is Base Sepolia. Anything else (e.g. Base mainnet eip155:8453) is skipped, never recorded.
 */
export const X402_SETTLED_NETWORKS: ReadonlySet<string> = new Set(["eip155:84532", "base-sepolia"]);
/** An EVM transaction hash (what Stripe's transaction_verification takes and what we use as the idempotency key). */
export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
/** An EVM address (STRIPE_DEPOSIT_ADDRESS). */
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const EXCERPT_CHARS = 500;
export const KEEP_RESULTS = 20;

/** The card (MPP / Shared Payment Token) unlock price. 0.50 USD is Stripe's card minimum for SPTs. */
export const CARD_PRICE = { amount: "0.50", currency: "usd", decimals: 2, micro: 500_000, display: "0.50 USD" } as const;
/** Ledger `network` for card unlocks. */
export const CARD_NETWORK = "stripe-spt-test";

// ---------- keys ----------
export type KeyCheck = { ok: true; key: string } | { ok: false; reason: "missing" | "live" | "not_test_secret" };

/** Test mode only: accept sk_test_ keys; refuse live (sk_live_/rk_live_) and anything else (restricted, publishable). */
export function checkStripeKey(raw: string | undefined): KeyCheck {
  const key = (raw ?? "").trim();
  if (!key) return { ok: false, reason: "missing" };
  if (/^(sk|rk)_live_/.test(key) || /_live_/.test(key)) return { ok: false, reason: "live" };
  if (!key.startsWith("sk_test_")) return { ok: false, reason: "not_test_secret" };
  return { ok: true, key };
}

// ---------- amounts ----------
/** Micro-USD(C) (6 decimals) to whole cents, as the sample does: round(atomic / 10000). Bad input → 0. */
export function microToCents(micro: number): number {
  if (typeof micro !== "number" || !Number.isFinite(micro) || micro <= 0) return 0;
  return Math.round(micro / 10_000);
}

// ---------- D1: x402 settlement → PaymentIntent (transaction_verification) ----------
/** PaymentIntent params exactly as the sample's onAfterSettle builds them, plus our network and reconciliation metadata. */
export function x402PaymentIntentParams(s: SettledUnlock, network: string, cents: number): Record<string, unknown> {
  return {
    amount: cents,
    currency: "usd",
    confirm: true,
    payment_method_data: { type: "crypto" },
    payment_method_types: ["crypto"],
    payment_method_options: {
      crypto: {
        mode: "transaction_verification",
        transaction_verification_options: { network, transaction_hash: s.tx_hash },
      },
    },
    metadata: { source: "aze-x402", note_id: String(s.note_id).slice(0, 64), x402_network: String(s.network).slice(0, 64) },
  };
}

export interface PiSummary { id: string | null; status: string | null; livemode: boolean | null }
export function piSummary(raw: unknown): PiSummary {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof o.id === "string" ? o.id : null,
    status: typeof o.status === "string" ? o.status : null,
    livemode: typeof o.livemode === "boolean" ? o.livemode : null,
  };
}
/** Statuses that mean Stripe accepted the transaction (or is still verifying it). */
export const PI_OK_STATUSES = new Set(["succeeded", "processing"]);

// ---------- diag summaries ----------
export function balanceSummary(raw: unknown): { livemode: boolean | null; currencies: string[] } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const cur = new Set<string>();
  for (const k of ["available", "pending"]) {
    const list = o[k];
    if (Array.isArray(list)) for (const b of list) if (b && typeof (b as any).currency === "string") cur.add((b as any).currency);
  }
  return { livemode: typeof o.livemode === "boolean" ? o.livemode : null, currencies: [...cur].sort() };
}

/** List existing deposit addresses on `network`, the way mppx's findOrCreateDepositAddress does (query in the path). */
export function depositAddressListPath(network: string, limit = 1): string {
  return `/v1/crypto/deposit_addresses?network=${encodeURIComponent(network)}&limit=${limit}`;
}
/** Objects of a Stripe list (`{ object: "list", data: [...] }`); [] for anything else. */
export function listed(raw: unknown): Array<Record<string, unknown>> {
  const data = (raw as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data.filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object") : [];
}
/** Does a Stripe deposit-address list contain `address` (EVM, case-insensitive)? The address itself is never echoed. */
export function listHasAddress(raw: unknown, address: string): boolean {
  const want = address.trim().toLowerCase();
  return Boolean(want) && listed(raw).some((d) => typeof d.address === "string" && d.address.trim().toLowerCase() === want);
}

export function depositAddressSummary(raw: unknown): { id: string | null; network: string | null; livemode: boolean | null; has_address: boolean } {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof o.id === "string" ? o.id : null,
    network: typeof o.network === "string" ? o.network : null,
    livemode: typeof o.livemode === "boolean" ? o.livemode : null,
    has_address: typeof o.address === "string" && o.address.length > 0,
  };
}

// ---------- redaction + excerpts ----------
/** Remove secrets, keys, deposit/wallet addresses and account ids from text that goes to logs or /admin/diag. */
export function redact(text: string, secrets: Array<string | undefined> = []): string {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  return out
    .replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, "$1_$2_[redacted]")
    .replace(/\bwhsec_[A-Za-z0-9]+/g, "whsec_[redacted]")
    .replace(/\bacct_[A-Za-z0-9]+/g, "acct_[redacted]")
    .replace(/("address"\s*:\s*")[^"]*(")/g, "$1[redacted]$2")
    .replace(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, "0x[address-redacted]");
}

/** JSON of a Stripe object or error body, without SDK/HTTP baggage. */
function plain(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, (k, v) => (k === "lastResponse" || k === "headers" ? undefined : v)) ?? String(value);
  } catch {
    return String(value);
  }
}
export function excerpt(value: unknown, secrets: Array<string | undefined> = [], chars = EXCERPT_CHARS): string {
  return redact(plain(value), secrets).slice(0, chars);
}

export interface StripeErrorInfo { status: number | null; type: string | null; code: string | null; param: string | null; message: string; raw: string; payment_intent: string | null }
/** Pull the useful parts out of a StripeError (or anything thrown), redacted. */
export function stripeErrorInfo(e: unknown, secrets: Array<string | undefined> = []): StripeErrorInfo {
  const err = (e ?? {}) as Record<string, any>;
  const raw = err.raw && typeof err.raw === "object" ? err.raw : null;
  const pi = err.payment_intent ?? raw?.payment_intent;
  // Connection errors carry the real cause (DNS, TLS, timeout) in `detail` (and its `cause`); JSON drops Errors.
  const why = (x: any) => (x && typeof x === "object" ? [x.code, x.message].filter((v) => typeof v === "string" && v).join(" ") : "");
  const cause = [why(err.detail), why(err.detail?.cause) || why(err.cause)].filter(Boolean).join(": ");
  const message = typeof err.message === "string" ? err.message : String(e);
  return {
    status: typeof err.statusCode === "number" ? err.statusCode : null,
    type: typeof err.type === "string" ? err.type : null,
    code: typeof err.code === "string" ? err.code : null,
    param: typeof err.param === "string" ? err.param : null,
    message: redact(cause && !message.includes(cause) ? `${message} (cause: ${cause})` : message, secrets).slice(0, 300),
    raw: raw ? excerpt(raw, secrets) : "",
    payment_intent: pi && typeof pi === "object" && typeof pi.id === "string" ? pi.id : null,
  };
}
export function describeStripeError(i: StripeErrorInfo): string {
  const head = [i.status, i.type, i.code, i.param ? `param=${i.param}` : null].filter((x) => x !== null && x !== "").join(" ");
  return `${head ? `${head}: ` : ""}${i.message}${i.payment_intent ? ` (pi=${i.payment_intent})` : ""}`;
}

// ---------- D2 ----------
/** Note ids are UUIDs in Supabase and the memory store; accept a conservative superset. */
export const NOTE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Public base URL from MCP_URL-style input: trims slashes and a trailing /mcp. "" when unknown. */
export function normalizeBaseUrl(u: string | undefined | null): string {
  const s = (u ?? "").trim().replace(/\/+$/, "").replace(/\/mcp$/, "").replace(/\/+$/, "");
  if (!s) return "";
  try {
    const url = new URL(s);
    return url.protocol === "https:" || url.protocol === "http:" ? s : "";
  } catch {
    return "";
  }
}

export function unlockCardLink(baseUrl: string, noteId: string): string {
  return `${baseUrl}/api/unlock-card?note_id=${encodeURIComponent(noteId)}`;
}

/** Mask the middle of an identifier for diag output (e.g. a Stripe profile id). */
export function mask(id: string): string {
  return id.length <= 10 ? `${id.slice(0, 3)}…` : `${id.slice(0, 8)}…${id.slice(-2)} (${id.length} chars)`;
}
