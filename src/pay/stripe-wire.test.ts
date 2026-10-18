import { describe, expect, it } from "vitest";
import {
  PREVIEW_API_VERSION_DEFAULT, X402_NETWORK_DEFAULT, X402_SETTLED_NETWORKS, balanceSummary, checkStripeKey, depositAddressListPath,
  depositAddressSummary, describeStripeError, excerpt, listHasAddress, listed, mask, microToCents, normalizeBaseUrl, piSummary, redact,
  stripeErrorInfo, x402PaymentIntentParams,
} from "./stripe-wire.js";

const TX = "0x" + "ab".repeat(32);
const ADDR = "0x" + "12".repeat(20);

describe("checkStripeKey (test mode only)", () => {
  it("accepts only sk_test_ secret keys", () => {
    expect(checkStripeKey("sk_test_abc123")).toEqual({ ok: true, key: "sk_test_abc123" });
    expect(checkStripeKey("  sk_test_abc123\n")).toEqual({ ok: true, key: "sk_test_abc123" });
  });
  it("refuses live keys, restricted/publishable keys and empty values", () => {
    expect(checkStripeKey("sk_live_abc")).toEqual({ ok: false, reason: "live" });
    expect(checkStripeKey("rk_live_abc")).toEqual({ ok: false, reason: "live" });
    expect(checkStripeKey("rk_test_abc")).toEqual({ ok: false, reason: "not_test_secret" });
    expect(checkStripeKey("pk_test_abc")).toEqual({ ok: false, reason: "not_test_secret" });
    expect(checkStripeKey(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(checkStripeKey("  ")).toEqual({ ok: false, reason: "missing" });
  });
});

describe("microToCents", () => {
  it("rounds atomic 6-decimal units to cents like the sample (round(atomic / 10000))", () => {
    expect(microToCents(50_000)).toBe(5); // our default price, 0.05 USD
    expect(microToCents(500_000)).toBe(50);
    expect(microToCents(10_000)).toBe(1);
    expect(microToCents(5_000)).toBe(1);
    expect(microToCents(4_999)).toBe(0);
    expect(microToCents(0)).toBe(0);
    expect(microToCents(-50_000)).toBe(0);
    expect(microToCents(Number.NaN)).toBe(0);
  });
});

describe("M2 defaults (docs/muse/m1-m2-provider-facts.md)", () => {
  it("sandbox network is base (Base Sepolia in a sandbox; there is no base_sepolia) on preview 2026-07-29", () => {
    expect(X402_NETWORK_DEFAULT).toBe("base");
    expect(PREVIEW_API_VERSION_DEFAULT).toBe("2026-07-29.preview");
    expect([...X402_SETTLED_NETWORKS].sort()).toEqual(["base-sepolia", "eip155:84532"]);
  });
});

describe("deposit-address lists", () => {
  it("builds the list path, reads list data defensively, and matches an address case-insensitively", () => {
    expect(depositAddressListPath("base")).toBe("/v1/crypto/deposit_addresses?network=base&limit=1");
    expect(depositAddressListPath("a&b", 100)).toBe("/v1/crypto/deposit_addresses?network=a%26b&limit=100");
    const list = { object: "list", data: [{ id: "cda_1", address: ADDR.toUpperCase().replace("0X", "0x") }, null, "x"] };
    expect(listed(list)).toHaveLength(1);
    expect(listed(null)).toEqual([]);
    expect(listed({ data: "nope" })).toEqual([]);
    expect(listHasAddress(list, ` ${ADDR} `)).toBe(true);
    expect(listHasAddress(list, "0x" + "34".repeat(20))).toBe(false);
    expect(listHasAddress(list, "")).toBe(false);
  });
});

describe("x402PaymentIntentParams", () => {
  it("matches the sample's transaction_verification PaymentIntent, with our network", () => {
    const p = x402PaymentIntentParams({ note_id: "n1", tx_hash: TX, network: "eip155:84532", amount_micro: 50_000 }, "base", 5);
    expect(p).toMatchObject({
      amount: 5,
      currency: "usd",
      confirm: true,
      payment_method_data: { type: "crypto" },
      payment_method_types: ["crypto"],
      payment_method_options: { crypto: { mode: "transaction_verification", transaction_verification_options: { network: "base", transaction_hash: TX } } },
    });
    expect(p.metadata).toEqual({ source: "aze-x402", note_id: "n1", x402_network: "eip155:84532" });
  });
});

describe("parsers", () => {
  it("piSummary / balanceSummary / depositAddressSummary parse defensively", () => {
    expect(piSummary({ id: "pi_1", status: "succeeded", livemode: false })).toEqual({ id: "pi_1", status: "succeeded", livemode: false });
    expect(piSummary(null)).toEqual({ id: null, status: null, livemode: null });
    expect(balanceSummary({ livemode: false, available: [{ currency: "usd" }], pending: [{ currency: "eur" }, { currency: "usd" }] }))
      .toEqual({ livemode: false, currencies: ["eur", "usd"] });
    expect(balanceSummary("nope")).toEqual({ livemode: null, currencies: [] });
    expect(depositAddressSummary({ id: "cda_1", address: ADDR, network: "base", livemode: false }))
      .toEqual({ id: "cda_1", network: "base", livemode: false, has_address: true });
  });
});

describe("redact / excerpt", () => {
  it("removes keys, wallet/deposit addresses and account ids but keeps tx hashes", () => {
    const text = `key sk_test_51Abc sk_live_9 rk_live_x acct_1ABC addr ${ADDR} tx ${TX} {"address":"So1anaAddr"} whsec_abc`;
    const out = redact(text, ["sk_test_51Abc"]);
    expect(out).not.toContain("sk_test_51Abc");
    expect(out).not.toContain("sk_live_9");
    expect(out).not.toContain("rk_live_x");
    expect(out).not.toContain("acct_1ABC");
    expect(out).not.toContain(ADDR);
    expect(out).not.toContain("So1anaAddr");
    expect(out).not.toContain("whsec_abc");
    expect(out).toContain(TX);
  });
  it("excerpt is JSON without SDK baggage, capped at 500 chars", () => {
    const obj = Object.defineProperty({ id: "x", address: ADDR, big: "y".repeat(2000) }, "lastResponse", { value: { headers: { a: 1 } }, enumerable: true });
    const out = excerpt(obj);
    expect(out.length).toBe(500);
    expect(out).not.toContain("lastResponse");
    expect(out).not.toContain(ADDR);
  });
});

describe("stripeErrorInfo", () => {
  it("reads a StripeError's status/type/code/param/raw and the PaymentIntent it names", () => {
    const err = Object.assign(new Error("Invalid network: base_sepolia"), {
      statusCode: 400, type: "StripeInvalidRequestError", code: "parameter_invalid_empty", param: "network",
      raw: { message: "Invalid network: base_sepolia", type: "invalid_request_error", param: "network", headers: { "request-id": "req_1" }, payment_intent: { id: "pi_9" } },
    });
    const i = stripeErrorInfo(err, []);
    expect(i).toMatchObject({ status: 400, type: "StripeInvalidRequestError", code: "parameter_invalid_empty", param: "network", payment_intent: "pi_9" });
    expect(i.raw).toContain("invalid_request_error");
    expect(i.raw).not.toContain("request-id");
    expect(describeStripeError(i)).toBe("400 StripeInvalidRequestError parameter_invalid_empty param=network: Invalid network: base_sepolia (pi=pi_9)");
  });
  it("handles plain errors and non-errors", () => {
    expect(describeStripeError(stripeErrorInfo(new Error("fetch failed")))).toBe("fetch failed");
    expect(stripeErrorInfo("boom").message).toBe("boom");
  });
});

describe("normalizeBaseUrl / mask", () => {
  it("strips trailing slashes and /mcp; rejects non-http values", () => {
    expect(normalizeBaseUrl("https://calm-forge.run.mcp-use.com/mcp")).toBe("https://calm-forge.run.mcp-use.com");
    expect(normalizeBaseUrl("https://x.test/mcp/")).toBe("https://x.test");
    expect(normalizeBaseUrl("https://x.test/")).toBe("https://x.test");
    expect(normalizeBaseUrl(undefined)).toBe("");
    expect(normalizeBaseUrl("javascript:alert(1)")).toBe("");
    expect(normalizeBaseUrl("not a url")).toBe("");
  });
  it("masks ids", () => {
    expect(mask("profile_test_abcdef123")).toBe("profile_…23 (22 chars)");
    expect(mask("short")).toBe("sho…");
  });
});

describe("stripeErrorInfo: connection errors", () => {
  it("surfaces the underlying cause (DNS/TLS/timeout) that JSON would drop", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.stripe.com"), { code: "ENOTFOUND" });
    const detail = Object.assign(new TypeError("fetch failed"), { cause });
    const err = Object.assign(new Error("An error occurred with our connection to Stripe."), { type: "StripeConnectionError", detail, raw: { message: "An error occurred with our connection to Stripe.", detail } });
    const i = stripeErrorInfo(err);
    expect(i.status).toBeNull();
    expect(i.message).toBe("An error occurred with our connection to Stripe. (cause: fetch failed: ENOTFOUND getaddrinfo ENOTFOUND api.stripe.com)");
  });
});
