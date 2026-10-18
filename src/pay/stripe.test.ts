// Stream D factory, D1 (x402 → Stripe PaymentIntent) and the diags, through the REAL Stripe SDK on a stubbed fetch, so
// the HTTP wire (paths, form fields, Idempotency-Key, Stripe-Version) is what these tests assert.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStripeRail } from "./stripe.js";
import type { Logger, StripeLike } from "./stripe-record.js";

const KEY = "sk_test_51FakeFakeFakeFakeFakeFake";
const TX = "0x" + "ab".repeat(32);
const ADDR = "0x" + "12".repeat(20);

function quietLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

interface Call { method: string; url: URL; headers: Headers; form: URLSearchParams }
type Reply = { status: number; body: unknown } | Error;

/** Stub fetch with a router of Stripe replies; records every call. */
function stubStripe(route: (c: Call) => Reply) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: any, init: any = {}) => {
    const c: Call = {
      method: String(init.method ?? "GET").toUpperCase(),
      url: new URL(String(input)),
      headers: new Headers(init.headers),
      form: new URLSearchParams(typeof init.body === "string" ? init.body : ""),
    };
    calls.push(c);
    const r = route(c);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", "request-id": "req_test_1" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const settled = (over: Record<string, unknown> = {}) => ({ note_id: "11111111-1111-4111-8111-111111111111", tx_hash: TX, network: "eip155:84532", amount_micro: 50_000, ...over });
/** The live setup: payTo is a Stripe sandbox deposit address (index.ts prefers STRIPE_DEPOSIT_ADDRESS). */
const D1_ENV = { STRIPE_SECRET_KEY: KEY, STRIPE_DEPOSIT_ADDRESS: ADDR };

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("createStripeRail: test mode only", () => {
  it("is off (no plugin, no diags) without STRIPE_SECRET_KEY", () => {
    const log = quietLog();
    expect(createStripeRail({}, { log })).toEqual({ plugin: null, diags: [] });
    expect(log.lines).toEqual([]);
  });

  it("refuses live keys loudly and stays off", () => {
    for (const k of ["sk_live_abc", "rk_live_abc"]) {
      const log = quietLog();
      expect(createStripeRail({ STRIPE_SECRET_KEY: k }, { log })).toEqual({ plugin: null, diags: [] });
      expect(log.lines.join("\n")).toMatch(/LIVE key: refused/);
      expect(log.lines.join("\n")).not.toContain(k);
    }
  });

  it("refuses restricted/publishable test keys (needs sk_test_)", () => {
    const log = quietLog();
    expect(createStripeRail({ STRIPE_SECRET_KEY: "rk_test_abc" }, { log })).toEqual({ plugin: null, diags: [] });
    expect(log.lines.join("\n")).toContain("not an sk_test_");
  });

  it("with sk_test_: D1 on, D2 off without STRIPE_PROFILE_ID; three diags; no network at boot", () => {
    const { fetchMock } = stubStripe(() => ({ status: 500, body: {} }));
    const rail = createStripeRail({ STRIPE_SECRET_KEY: KEY }, { log: quietLog() });
    expect(typeof rail.plugin?.onSettled).toBe("function");
    expect(rail.plugin?.registerTools).toBeUndefined();
    expect(rail.plugin?.registerRoutes).toBeUndefined();
    expect(rail.diags.map((d) => d.name)).toEqual(["stripe", "stripe-x402-network", "stripe-mpp"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with STRIPE_PROFILE_ID: D2 tool + routes are registered", () => {
    const rail = createStripeRail({ STRIPE_SECRET_KEY: KEY, STRIPE_PROFILE_ID: "profile_test_1" }, { log: quietLog() });
    expect(typeof rail.plugin?.registerTools).toBe("function");
    expect(typeof rail.plugin?.registerRoutes).toBe("function");
    const tools: string[] = [];
    rail.plugin!.registerTools!({ tool: (def: any) => tools.push(def.name) }, { store: {} as any });
    expect(tools).toEqual(["notes_unlock_card"]);
    const routes: string[] = [];
    rail.plugin!.registerRoutes!({ get: (p: string) => routes.push(`GET ${p}`), post: (p: string) => routes.push(`POST ${p}`) }, { store: {} as any });
    expect(routes).toEqual(["GET /api/unlock-card", "POST /api/unlock-card"]);
  });

  it("STRIPE_RECORD_X402=0 turns D1 off", () => {
    const rail = createStripeRail({ STRIPE_SECRET_KEY: KEY, STRIPE_RECORD_X402: "0" }, { log: quietLog() });
    expect(rail.plugin?.onSettled).toBeUndefined();
  });
});

describe("D1 onSettled: x402 settlement → Stripe PaymentIntent (transaction_verification)", () => {
  it("POSTs /v1/payment_intents with the sample's params, cents, network base (M2), tx hash as Idempotency-Key, 2026-07-29.preview", async () => {
    const { calls } = stubStripe(() => ({ status: 200, body: { id: "pi_test_x402_1", object: "payment_intent", status: "succeeded", livemode: false } }));
    const log = quietLog();
    const rail = createStripeRail(D1_ENV, { log });
    await rail.plugin!.onSettled!(settled());
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.method).toBe("POST");
    expect(c.url.host).toBe("api.stripe.com");
    expect(c.url.pathname).toBe("/v1/payment_intents");
    expect(c.headers.get("idempotency-key")).toBe(TX);
    expect(c.headers.get("stripe-version")).toBe("2026-07-29.preview");
    expect(c.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(Object.fromEntries(c.form)).toMatchObject({
      amount: "5",
      currency: "usd",
      confirm: "true",
      "payment_method_data[type]": "crypto",
      "payment_method_types[0]": "crypto",
      "payment_method_options[crypto][mode]": "transaction_verification",
      "payment_method_options[crypto][transaction_verification_options][network]": "base",
      "payment_method_options[crypto][transaction_verification_options][transaction_hash]": TX,
      "metadata[source]": "aze-x402",
      "metadata[x402_network]": "eip155:84532",
    });
    expect(log.lines).toContain(`STRIPE recorded pi=pi_test_x402_1 tx=${TX} status=succeeded cents=5 network=base`);
    expect(log.lines.join("\n")).not.toContain(ADDR);
    expect(rail.recorder!.recent()[0]).toMatchObject({ ok: true, pi_id: "pi_test_x402_1", cents: 5, tx_hash: TX, network: "base" });
  });

  it("STRIPE_X402_NETWORK and STRIPE_PREVIEW_API_VERSION still override the defaults", async () => {
    const { calls } = stubStripe(() => ({ status: 200, body: { id: "pi_2", status: "processing" } }));
    const rail = createStripeRail({ ...D1_ENV, STRIPE_X402_NETWORK: " base_sepolia ", STRIPE_PREVIEW_API_VERSION: "2026-05-27.preview" }, { log: quietLog() });
    await rail.plugin!.onSettled!(settled({ amount_micro: 500_000 }));
    expect(calls[0].form.get("payment_method_options[crypto][transaction_verification_options][network]")).toBe("base_sepolia");
    expect(calls[0].form.get("amount")).toBe("50");
    expect(calls[0].headers.get("stripe-version")).toBe("2026-05-27.preview");
    expect(rail.recorder!.recent()[0].ok).toBe(true);
  });

  it("skips every settlement (no Stripe call) when payTo is the platform wallet; STRIPE_RECORD_X402=1 forces recording", async () => {
    const { fetchMock } = stubStripe(() => ({ status: 200, body: { id: "pi_forced", status: "succeeded" } }));
    const log = quietLog();
    const rail = createStripeRail({ STRIPE_SECRET_KEY: KEY }, { log });
    expect(typeof rail.plugin?.onSettled).toBe("function");
    await rail.plugin!.onSettled!(settled());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.lines.some((l) => l.startsWith("STRIPE record skipped: payTo is the platform wallet") && l.includes(TX))).toBe(true);
    expect(log.lines.some((l) => l.includes("D1 x402 recording skipped"))).toBe(true);
    expect(rail.recorder!.recent()[0]).toMatchObject({ ok: false, skipped: true, pi_id: null });

    const forced = createStripeRail({ STRIPE_SECRET_KEY: KEY, STRIPE_RECORD_X402: "1" }, { log: quietLog() });
    await forced.plugin!.onSettled!(settled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(forced.recorder!.recent()[0]).toMatchObject({ ok: true, pi_id: "pi_forced" });
  });

  it("records only Base Sepolia settlements and real tx hashes; anything else is skipped without a Stripe call", async () => {
    const { fetchMock } = stubStripe(() => ({ status: 200, body: { id: "pi_x", status: "succeeded" } }));
    const log = quietLog();
    const rail = createStripeRail(D1_ENV, { log });
    await rail.plugin!.onSettled!(settled({ network: "eip155:8453" })); // Base mainnet: never into a sandbox
    await rail.plugin!.onSettled!(settled({ network: undefined }));
    await rail.plugin!.onSettled!(settled({ tx_hash: "not-a-hash" }));
    await rail.plugin!.onSettled!(settled({ tx_hash: `0x${"ab".repeat(31)}` }));
    expect(fetchMock).not.toHaveBeenCalled();
    const recent = rail.recorder!.recent();
    expect(recent.map((r) => [r.ok, r.skipped])).toEqual([[false, true], [false, true], [false, true], [false, true]]);
    expect(recent[3].reason).toContain("eip155:8453");
    expect(recent[0].reason).toContain("not an EVM tx hash");
    await rail.plugin!.onSettled!(settled({ network: "base-sepolia" })); // x402 v1 name for the same chain
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a live-mode PaymentIntent as a loud failure (test mode only)", async () => {
    stubStripe(() => ({ status: 200, body: { id: "pi_live", status: "succeeded", livemode: true } }));
    const log = quietLog();
    const rail = createStripeRail(D1_ENV, { log });
    await rail.plugin!.onSettled!(settled());
    expect(log.lines.some((l) => l.includes("LIVE MODE") && l.includes("pi_live"))).toBe(true);
    expect(rail.recorder!.recent()[0]).toMatchObject({ ok: false, pi_id: "pi_live" });
  });

  it("skips (no Stripe call) when the amount rounds below 1 cent", async () => {
    const { fetchMock } = stubStripe(() => ({ status: 200, body: { id: "pi_x", status: "succeeded" } }));
    const log = quietLog();
    const rail = createStripeRail(D1_ENV, { log });
    await rail.plugin!.onSettled!(settled({ amount_micro: 4_000 }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.lines.join("\n")).toContain("STRIPE record skipped");
    expect(rail.recorder!.recent()[0]).toMatchObject({ ok: false, skipped: true, cents: 0 });
  });

  it("logs Stripe's rejection (e.g. an unknown network) and never throws", async () => {
    stubStripe(() => ({ status: 400, body: { error: { type: "invalid_request_error", code: "parameter_invalid_string", param: "payment_method_options[crypto][transaction_verification_options][network]", message: "Invalid network." } } }));
    const log = quietLog();
    const rail = createStripeRail(D1_ENV, { log });
    await expect(rail.plugin!.onSettled!(settled())).resolves.toBeUndefined();
    const line = log.lines.find((l) => l.startsWith("STRIPE record failed:"));
    expect(line).toContain("400");
    expect(line).toContain("Invalid network.");
    expect(line).toContain(TX);
    expect(line).not.toContain(KEY);
    expect(rail.recorder!.recent()[0]).toMatchObject({ ok: false, skipped: false });
  });

  it("never throws when the network is down", async () => {
    stubStripe(() => new TypeError("fetch failed"));
    const log = quietLog();
    const rail = createStripeRail(D1_ENV, { log });
    await expect(rail.plugin!.onSettled!(settled())).resolves.toBeUndefined();
    expect(log.lines.some((l) => l.startsWith("STRIPE record failed:"))).toBe(true);
  });

  it("never throws even if the Stripe client throws synchronously, and on a missing tx hash", async () => {
    const stripe: StripeLike = {
      paymentIntents: { create: () => { throw new Error("boom"); } },
      balance: { retrieve: async () => ({}) },
      rawRequest: async () => ({}),
    };
    const log = quietLog();
    const rail = createStripeRail(D1_ENV, { stripe, log });
    await expect(rail.plugin!.onSettled!(settled())).resolves.toBeUndefined();
    await expect(rail.plugin!.onSettled!(settled({ tx_hash: "" }))).resolves.toBeUndefined();
    await expect(rail.plugin!.onSettled!(null as any)).resolves.toBeUndefined();
    expect(log.lines.filter((l) => l.startsWith("STRIPE record failed:"))).toHaveLength(3);
  });

  it("doesn't hold the paid response longer than the wait budget; the recording finishes in the background", async () => {
    let release!: (v: unknown) => void;
    const stripe: StripeLike = {
      paymentIntents: { create: () => new Promise((r) => { release = r; }) },
      balance: { retrieve: async () => ({}) },
      rawRequest: async () => ({}),
    };
    const log = quietLog();
    const rail = createStripeRail(D1_ENV, { stripe, log, recordWaitMs: 20 });
    const t0 = Date.now();
    await rail.plugin!.onSettled!(settled());
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(log.lines.some((l) => l.startsWith("STRIPE recorded"))).toBe(false);
    release({ id: "pi_late", status: "succeeded" });
    await new Promise((r) => setTimeout(r, 0));
    expect(log.lines.some((l) => l.startsWith("STRIPE recorded pi=pi_late"))).toBe(true);
  });

  it("treats a PaymentIntent Stripe did not accept as a failure", async () => {
    stubStripe(() => ({ status: 200, body: { id: "pi_bad", status: "requires_payment_method" } }));
    const log = quietLog();
    const rail = createStripeRail(D1_ENV, { log });
    await rail.plugin!.onSettled!(settled());
    expect(log.lines).toContain(`STRIPE record failed: PaymentIntent pi_bad status=requires_payment_method tx=${TX}`);
  });

  it("keeps only the last 20 results, newest first", async () => {
    let n = 0;
    stubStripe(() => ({ status: 200, body: { id: `pi_${++n}`, status: "succeeded" } }));
    const rail = createStripeRail(D1_ENV, { log: quietLog() });
    for (let i = 0; i < 25; i++) await rail.plugin!.onSettled!(settled({ tx_hash: `0x${String(i).padStart(64, "0")}` }));
    const recent = rail.recorder!.recent();
    expect(recent).toHaveLength(20);
    expect(recent[0].pi_id).toBe("pi_25");
    expect(recent[19].pi_id).toBe("pi_6");
  });
});

describe("diags", () => {
  const diag = (rail: ReturnType<typeof createStripeRail>, name: string) => rail.diags.find((d) => d.name === name)!;

  it("stripe: GET /v1/balance, ok only in test mode, raw excerpt without the key", async () => {
    const { calls } = stubStripe(() => ({ status: 200, body: { object: "balance", livemode: false, available: [{ amount: 0, currency: "usd" }], pending: [] } }));
    const r = await diag(createStripeRail({ STRIPE_SECRET_KEY: KEY }, { log: quietLog() }), "stripe").check();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.pathname).toBe("/v1/balance");
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("livemode=false currencies=usd");
    expect(r.detail).toContain('"object":"balance"');
    expect(r.detail).not.toContain(KEY);

    stubStripe(() => ({ status: 200, body: { object: "balance", livemode: true, available: [] } }));
    const live = await diag(createStripeRail({ STRIPE_SECRET_KEY: KEY }, { log: quietLog() }), "stripe").check();
    expect(live.ok).toBe(false);
  });

  it("stripe: reports Stripe's error (e.g. a bad key) with its raw body", async () => {
    stubStripe(() => ({ status: 401, body: { error: { type: "invalid_request_error", message: "Invalid API Key provided: sk_test_****Fake" } } }));
    const r = await diag(createStripeRail({ STRIPE_SECRET_KEY: KEY }, { log: quietLog() }), "stripe").check();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("401");
    expect(r.detail).toContain("Invalid API Key");
  });

  const OTHER = "0x" + "34".repeat(20);
  const addrList = (...addresses: string[]) => ({
    object: "list",
    url: "/v1/crypto/deposit_addresses",
    has_more: false,
    data: addresses.map((a, i) => ({ id: `cda_test_${i + 1}`, object: "crypto.deposit_address", address: a, network: "base", livemode: false })),
  });
  const wireOf = (calls: Call[]) => calls.map((c) => [c.method, c.url.pathname, c.url.searchParams.get("network") ?? c.form.get("network"), c.url.searchParams.get("limit") ?? "", c.headers.get("stripe-version")].join(" "));

  it("stripe-x402-network: read-only by default (one GET list, never a POST), green when payTo is a listed Stripe deposit address", async () => {
    const { calls } = stubStripe((c) => (c.method === "GET" ? { status: 200, body: addrList(OTHER, ADDR.toUpperCase().replace("0X", "0x")) } : { status: 500, body: { error: { message: "must not be called" } } }));
    const r = await diag(createStripeRail(D1_ENV, { log: quietLog() }), "stripe-x402-network").check();
    expect(wireOf(calls)).toEqual(["GET /v1/crypto/deposit_addresses base 100 2026-07-29.preview"]);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("configured=base api=2026-07-29.preview D1=on payTo=stripe-deposit-address create=off");
    expect(r.detail).toContain("network=base: ACCEPTED (list ok: 2 address(es), first id=cda_test_1 network=base livemode=false) payTo=LISTED; nothing created");
    expect(r.detail).toContain("D1: no x402 settlements recorded since boot");
    expect(r.detail).not.toContain(ADDR);
    expect(r.detail.toLowerCase()).not.toContain(ADDR.slice(2).toLowerCase());
    expect(r.detail).not.toContain(OTHER);
    expect(r.detail).not.toContain(KEY);
  });

  it("stripe-x402-network: red when payTo is not one of the account's deposit addresses, or is the platform wallet", async () => {
    stubStripe(() => ({ status: 200, body: addrList(OTHER) }));
    const notListed = await diag(createStripeRail(D1_ENV, { log: quietLog() }), "stripe-x402-network").check();
    expect(notListed.ok).toBe(false);
    expect(notListed.detail).toContain("payTo=NOT LISTED");
    expect(notListed.detail).not.toContain(ADDR);

    const wallet = await diag(createStripeRail({ STRIPE_SECRET_KEY: KEY }, { log: quietLog() }), "stripe-x402-network").check();
    expect(wallet.ok).toBe(false);
    expect(wallet.detail).toContain("D1=skipped payTo=platform-wallet");

    const bad = await diag(createStripeRail({ ...D1_ENV, STRIPE_DEPOSIT_ADDRESS: "not-an-address" }, { log: quietLog() }), "stripe-x402-network").check();
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("STRIPE_DEPOSIT_ADDRESS is not an EVM address");
    expect(bad.detail).not.toContain("not-an-address");

    // With D1 off, only the network answer matters.
    const off = await diag(createStripeRail({ STRIPE_SECRET_KEY: KEY, STRIPE_RECORD_X402: "0" }, { log: quietLog() }), "stripe-x402-network").check();
    expect(off.ok).toBe(true);
    expect(off.detail).toContain("D1=off");
  });

  it("stripe-x402-network: an empty list creates nothing unless STRIPE_DIAG_CREATE_ADDRESS=1, which creates exactly one", async () => {
    const created = { id: "cda_new", object: "crypto.deposit_address", address: ADDR, network: "base", livemode: false };
    const { calls } = stubStripe((c) => (c.method === "GET" ? { status: 200, body: addrList() } : { status: 200, body: created }));
    const ro = await diag(createStripeRail(D1_ENV, { log: quietLog() }), "stripe-x402-network").check();
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(ro.ok).toBe(false); // payTo isn't listed
    expect(ro.detail).toContain("none exists and nothing was created (set STRIPE_DIAG_CREATE_ADDRESS=1");

    calls.length = 0;
    const rw = await diag(createStripeRail({ ...D1_ENV, STRIPE_DIAG_CREATE_ADDRESS: "1" }, { log: quietLog() }), "stripe-x402-network").check();
    expect(wireOf(calls)).toEqual([
      "GET /v1/crypto/deposit_addresses base 100 2026-07-29.preview",
      "POST /v1/crypto/deposit_addresses base  2026-07-29.preview",
    ]);
    expect(rw.detail).toContain("create=opt-in on");
    expect(rw.detail).toContain("CREATED (STRIPE_DIAG_CREATE_ADDRESS=1) id=cda_new network=base livemode=false has_address=true");
    expect(rw.detail).not.toContain(ADDR);
  });

  it("stripe-x402-network: a network Stripe rejects is red with its raw answer, and base (listed read-only) is suggested", async () => {
    const { calls } = stubStripe((c) =>
      c.method !== "GET"
        ? { status: 500, body: { error: { message: "must not be called" } } }
        : c.url.searchParams.get("network") === "base"
          ? { status: 200, body: addrList(ADDR) }
          : { status: 400, body: { error: { type: "invalid_request_error", param: "network", message: "Invalid network: must be one of base, solana, tempo" } } });
    const r = await diag(createStripeRail({ ...D1_ENV, STRIPE_X402_NETWORK: "base_sepolia", STRIPE_DIAG_CREATE_ADDRESS: "1" }, { log: quietLog() }), "stripe-x402-network").check();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("network=base_sepolia: list REJECTED 400");
    expect(r.detail).toContain("Invalid network");
    expect(r.detail).toContain("network=base: ACCEPTED");
    expect(r.detail).toContain("-> try STRIPE_X402_NETWORK=base");
    expect(r.detail).not.toContain(ADDR);
  });

  it("stripe-x402-network: no answer from Stripe is red, not a crash", async () => {
    stubStripe(() => new TypeError("fetch failed"));
    const r = await diag(createStripeRail(D1_ENV, { log: quietLog() }), "stripe-x402-network").check();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("network=base: list NO ANSWER");
  });

  it("stripe-x402-network: includes recent D1 results", async () => {
    stubStripe((c) => (c.url.pathname === "/v1/payment_intents"
      ? { status: 200, body: { id: "pi_ok", status: "succeeded" } }
      : { status: 200, body: addrList(ADDR) }));
    const rail = createStripeRail(D1_ENV, { log: quietLog() });
    await rail.plugin!.onSettled!(settled());
    const r = await diag(rail, "stripe-x402-network").check();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("D1: 1/1 recorded");
    expect(r.detail).toContain("pi=pi_ok");
    expect(r.detail).not.toContain(ADDR);
  });

  it("stripe-mpp: off (green, optional) without a profile; with one, builds a challenge locally (no network) and masks the profile", async () => {
    const { fetchMock } = stubStripe(() => ({ status: 500, body: {} }));
    const off = await diag(createStripeRail({ STRIPE_SECRET_KEY: KEY }, { log: quietLog() }), "stripe-mpp").check();
    expect(off.ok).toBe(true); // optional: off is not a failure
    expect(off.detail).toContain("OFF (optional): STRIPE_PROFILE_ID not set");

    const profile = "profile_test_abcdef123456";
    const on = await diag(createStripeRail({ STRIPE_SECRET_KEY: KEY, STRIPE_PROFILE_ID: profile, MCP_URL: "https://aze.example.test/mcp" }, { log: quietLog() }), "stripe-mpp").check();
    expect(on.ok).toBe(true);
    expect(on.detail).toContain("livemode=false");
    expect(on.detail).toContain("https://aze.example.test/api/unlock-card?note_id=NOTE_ID");
    expect(on.detail).toContain('"amount":"50"');
    expect(on.detail).not.toContain(profile);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
