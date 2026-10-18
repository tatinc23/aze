// D2 card unlock: real mppx (server AND client, no network) against a fake Stripe client, so the 402 → credential →
// paid flow, the challenge binding, and our ledger split are exercised exactly as in production.
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Mppx as MppxClient, stripe as stripeClientMethods } from "mppx/client";
import { MemoryStore } from "../store/memory.js";
import type { CleanNote, Store } from "../types.js";
import {
  createCardUnlock, CARD_ATTEMPTS_PER_MINUTE, credentialReach, MAX_BODY_BYTES, mppSecretFrom, readJsonLimited, UNLOCK_CARD_PATH,
} from "./stripe-mpp.js";
import type { Logger, StripeLike } from "./stripe-record.js";

const KEY = "sk_test_51FakeFakeFakeFakeFakeFake";
const PROFILE = "profile_test_abc123";
const BASE = "https://aze.example.test";

const note = (over: Partial<CleanNote> = {}): CleanNote => ({
  kind: "friction", category: "auth", surface: "inkbox", surface_display: "Inkbox", what: "OAuth device flow times out",
  tool: "inbox_create", error_class: "timeout waiting for device code", tokens_spent: null, dollars_spent: null,
  workaround: "Poll every 5s instead of 1s; faster polling is rate-limited.", teaser: "Poll every 5s instead of 1s", wish: null,
  ...over,
});

function quietLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

function fakeStripe(over: Partial<{ create: (...a: any[]) => Promise<any> }> = {}) {
  let n = 0;
  const create = vi.fn(over.create ?? (async () => ({ id: `pi_test_card_${++n}`, status: "succeeded", lastResponse: { headers: {} } })));
  const stripe: StripeLike = {
    paymentIntents: { create },
    balance: { retrieve: vi.fn(async () => ({})) },
    rawRequest: vi.fn(async () => ({})),
  };
  return { stripe, create };
}

/**
 * Stripe's idempotency, as the real API does it: the same Idempotency-Key returns the first PaymentIntent again with an
 * `idempotent-replayed: true` header (which mppx reads to refuse a replayed credential). Counts real charges.
 */
function idempotentStripe(opts: { flagReplays?: boolean } = {}) {
  const byKey = new Map<string, { id: string; status: string }>();
  let charges = 0;
  const create = async (_params: any, options: any) => {
    const key = String(options?.idempotencyKey);
    const prior = byKey.get(key);
    if (prior) return { ...prior, lastResponse: { headers: opts.flagReplays === false ? {} : { "idempotent-replayed": "true" } } };
    const pi = { id: `pi_test_card_${++charges}`, status: "succeeded" };
    byKey.set(key, pi);
    return { ...pi, lastResponse: { headers: {} } };
  };
  return { create, charges: () => charges };
}

async function setup(opts: { create?: (...a: any[]) => Promise<any>; store?: Store; baseUrl?: string; now?: () => number } = {}) {
  const store = opts.store ?? new MemoryStore();
  const { stripe, create } = fakeStripe(opts.create ? { create: opts.create } : {});
  const log = quietLog();
  const card = createCardUnlock({ stripe, stripeKey: KEY, profileId: PROFILE, baseUrl: opts.baseUrl ?? BASE, realm: "aze.example.test", log, now: opts.now });
  const app = new Hono();
  card.registerRoutes(app, store, undefined);
  const withWork = await store.insertNote(note(), { attestation: "unverified", payout_address: null });
  const noWork = await store.insertNote(note({ workaround: null, teaser: null, what: "Docs are out of date" }), { attestation: "unverified", payout_address: null });
  return { store, stripe, create, log, card, app, withWork, noWork };
}

/** An agent's wallet: answers the stripe/charge challenge with a (fake) test-mode Shared Payment Token. */
function agentWallet(spt = "spt_test_fake_123") {
  const createToken = vi.fn(async () => spt);
  const client = MppxClient.create({ methods: [stripeClientMethods.charge({ createToken, paymentMethod: "pm_card_visa" })], polyfill: false });
  return { client, createToken };
}

const post = (app: Hono, path: string, headers: Record<string, string> = {}) =>
  app.request(`${BASE}${path}`, { method: "POST", headers });

describe("POST /api/unlock-card: checks before any charge", () => {
  it("404 for a missing note, and Stripe is never called", async () => {
    const { app, create, store } = await setup();
    const res = await post(app, `${UNLOCK_CARD_PATH}?note_id=00000000-0000-4000-8000-000000000000`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "not_found" });
    expect(create).not.toHaveBeenCalled();
    expect((await store.stats()).unlocks).toBe(0);
  });

  it("409 for a note without a workaround; 404 for a hidden note; 400 for a bad id; 503 when paused", async () => {
    const { app, create, store, noWork, withWork } = await setup();
    expect((await post(app, `${UNLOCK_CARD_PATH}?note_id=${noWork.id}`)).status).toBe(409);
    expect((await post(app, `${UNLOCK_CARD_PATH}?note_id=${encodeURIComponent("../admin/switch")}`)).status).toBe(400);
    expect((await post(app, UNLOCK_CARD_PATH)).status).toBe(400);
    await store.setSettings({ unlock_enabled: false });
    const paused = await post(app, `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`);
    expect(paused.status).toBe(503);
    expect(await paused.json()).toMatchObject({ code: "paused" });
    await store.setSettings({ unlock_enabled: true });
    await store.hideNote(withWork.id);
    expect((await post(app, `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`)).status).toBe(404);
    expect(create).not.toHaveBeenCalled();
    expect((await store.stats()).unlocks).toBe(0);
  });

  it("503 (nobody charged) when the store is down", async () => {
    const store = new MemoryStore();
    const broken = Object.assign(Object.create(store), { getNote: async () => { throw new Error("db down"); } }) as Store;
    const { app, create } = await setup({ store: broken });
    const res = await post(app, `${UNLOCK_CARD_PATH}?note_id=00000000-0000-4000-8000-000000000000`);
    expect(res.status).toBe(503);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("POST /api/unlock-card: MPP 402 challenge", () => {
  it("answers an unpaid request with a 402 stripe/charge challenge for 0.50 USD on our profile, charging nobody", async () => {
    const { app, create, withWork, store } = await setup();
    const res = await post(app, `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`);
    expect(res.status).toBe(402);
    const www = res.headers.get("www-authenticate") ?? "";
    expect(www).toMatch(/^Payment /);
    expect(www).toContain('method="stripe"');
    expect(www).toContain('intent="charge"');
    // Agents that only read bodies still learn what to do (the challenge itself stays in the header).
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.clone().json()).toMatchObject({
      ok: false, code: "payment_required", price: "0.50 USD",
      problem: { type: "https://paymentauth.org/problems/payment-required", status: 402 },
    });
    expect((await res.clone().json()).hint).toContain(`${BASE}/api/unlock-card?note_id=${withWork.id}`);
    expect((await res.clone().json()).hint).toContain("Nobody was charged");
    const { client, createToken } = agentWallet();
    await client.createCredential(res);
    expect(createToken).toHaveBeenCalledTimes(1);
    const asked = (createToken.mock.calls[0] as unknown as [any])[0];
    expect(asked).toMatchObject({ amount: "50", currency: "usd", networkId: PROFILE });
    expect(create).not.toHaveBeenCalled();
    expect((await store.stats()).unlocks).toBe(0);
  });

  it("GET works the same way (the sample accepts GET or POST)", async () => {
    const { app, withWork } = await setup();
    const res = await app.request(`${BASE}${UNLOCK_CARD_PATH}?note_id=${withWork.id}`);
    expect(res.status).toBe(402);
  });

  it("accepts note_id in a JSON body", async () => {
    const { app, withWork } = await setup();
    const res = await app.request(`${BASE}${UNLOCK_CARD_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note_id: withWork.id }) });
    expect(res.status).toBe(402);
  });
});

describe("POST /api/unlock-card: paid", () => {
  it("charges via the SPT, returns the workaround + receipt, and writes the 70/30 ledger", async () => {
    const { app, create, withWork, store } = await setup();
    const url = `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`;
    const challenge = await post(app, url);
    const { client } = agentWallet("spt_test_fake_123");
    const credential = await client.createCredential(challenge);
    const res = await post(app, url, { authorization: credential });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, note_id: withWork.id, workaround: withWork.workaround, receipt: { method: "stripe", status: "success", reference: "pi_test_card_1" } });
    expect(res.headers.get("payment-receipt")).toBeTruthy();

    // Stripe saw exactly one PaymentIntent: 50 cents, usd, confirmed with the agent's SPT.
    expect(create).toHaveBeenCalledTimes(1);
    const [params, options] = create.mock.calls[0] as unknown as [any, any];
    expect(params).toMatchObject({ amount: 50, currency: "usd", confirm: true, shared_payment_granted_token: "spt_test_fake_123" });
    expect(String(options.idempotencyKey)).toContain("spt_test_fake_123");

    const stats = await store.stats();
    expect(stats.unlocks).toBe(1);
    expect(stats.filer_earned_micro).toBe(350_000);
  });

  it("records amount 500000, the 70/30 split, the Stripe payment id and network stripe-spt-test", async () => {
    const store = new MemoryStore();
    const spy = vi.spyOn(store, "recordUnlock");
    const { app, withWork } = await setup({ store });
    const url = `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`;
    const credential = await agentWallet().client.createCredential(await post(app, url));
    expect((await post(app, url, { authorization: credential })).status).toBe(200);
    expect(spy).toHaveBeenCalledWith({
      note_id: withWork.id, amount_micro: 500_000, filer_micro: 350_000, platform_micro: 150_000,
      tx_hash: "pi_test_card_1", network: "stripe-spt-test",
    });
  });

  it("uses the store's filer_bps for the split", async () => {
    const store = new MemoryStore();
    await store.setSettings({ filer_bps: 6500 });
    const spy = vi.spyOn(store, "recordUnlock");
    const { app, withWork } = await setup({ store });
    const url = `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`;
    const credential = await agentWallet().client.createCredential(await post(app, url));
    await post(app, url, { authorization: credential });
    expect(spy.mock.calls[0][0]).toMatchObject({ filer_micro: 325_000, platform_micro: 175_000 });
  });

  it("a credential issued for one note can't buy another note's workaround", async () => {
    const { app, create, withWork, store } = await setup();
    const other = await store.insertNote(note({ what: "Another wall", workaround: "Another fix", teaser: "Another fix" }), { attestation: "unverified", payout_address: null });
    const credential = await agentWallet().client.createCredential(await post(app, `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`));
    const res = await post(app, `${UNLOCK_CARD_PATH}?note_id=${other.id}`, { authorization: credential });
    expect(res.status).toBe(402);
    expect(create).not.toHaveBeenCalled();
    expect((await store.stats()).unlocks).toBe(0);
  });

  it("a declined SPT gets a fresh 402 and no ledger row", async () => {
    const { app, withWork, store } = await setup({ create: async () => { throw Object.assign(new Error("Your card was declined."), { type: "StripeCardError", statusCode: 402 }); } });
    const url = `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`;
    const credential = await agentWallet().client.createCredential(await post(app, url));
    const res = await post(app, url, { authorization: credential });
    expect(res.status).toBe(402);
    expect(res.headers.get("www-authenticate")).toMatch(/^Payment /); // a fresh challenge to retry with
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, code: "payment_failed" });
    expect(body.problem.detail).toContain("Your card was declined.");
    expect(body.workaround).toBeUndefined();
    expect((await store.stats()).unlocks).toBe(0);
  });

  it("a ledger failure after the payment still delivers the workaround (and logs loudly)", async () => {
    const store = new MemoryStore();
    vi.spyOn(store, "recordUnlock").mockRejectedValue(new Error("db down"));
    const { app, withWork, log } = await setup({ store });
    const url = `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`;
    const credential = await agentWallet().client.createCredential(await post(app, url));
    const res = await post(app, url, { authorization: credential });
    expect(res.status).toBe(200);
    expect((await res.json()).workaround).toBe(withWork.workaround);
    expect(log.lines.some((l) => l.includes("LEDGER WRITE FAILED"))).toBe(true);
  });

  it("garbage or forged credentials never reach Stripe and never use up the attempt budget", async () => {
    let t = Date.now();
    const { app, withWork, create, store } = await setup({ now: () => t });
    const url = `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`;
    for (let i = 0; i < CARD_ATTEMPTS_PER_MINUTE + 5; i++) {
      expect((await post(app, url, { authorization: "Payment not-a-credential" })).status).toBe(402);
      expect((await post(app, url, { authorization: "Bearer x, Payment not-a-credential" })).status).toBe(402);
    }
    // A credential signed by another server (wrong HMAC secret) is rejected locally too.
    const other = createCardUnlock({ stripe: fakeStripe().stripe, stripeKey: "sk_test_other_server_key_000000", profileId: PROFILE, baseUrl: BASE, realm: "aze.example.test", log: quietLog() });
    const otherApp = new Hono();
    other.registerRoutes(otherApp, store, undefined);
    const forged = await agentWallet().client.createCredential(await post(otherApp, url));
    for (let i = 0; i < CARD_ATTEMPTS_PER_MINUTE + 1; i++) expect((await post(app, url, { authorization: forged })).status).toBe(402);
    expect(create).not.toHaveBeenCalled();
    // ...so a real payer still gets through.
    const credential = await agentWallet().client.createCredential(await post(app, url));
    t += 1_000;
    expect((await post(app, url, { authorization: credential })).status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("credentials that would reach Stripe are capped per minute (429, no Stripe call), then allowed again", async () => {
    let t = Date.now();
    const declined = async () => { throw Object.assign(new Error("Your card was declined."), { type: "StripeCardError", statusCode: 402 }); };
    const { app, withWork, create } = await setup({ create: declined, now: () => t });
    const url = `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`;
    const wallet = agentWallet();
    for (let i = 0; i < CARD_ATTEMPTS_PER_MINUTE; i++) {
      const credential = await wallet.client.createCredential(await post(app, url));
      // Also counted when Payment isn't the first Authorization scheme (mppx still reads it).
      expect((await post(app, url, { authorization: i % 2 ? `Bearer x, ${credential}` : credential })).status).toBe(402);
    }
    expect(create).toHaveBeenCalledTimes(CARD_ATTEMPTS_PER_MINUTE);
    const extra = await wallet.client.createCredential(await post(app, url));
    const limited = await post(app, url, { authorization: extra });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    expect(create).toHaveBeenCalledTimes(CARD_ATTEMPTS_PER_MINUTE);
    // A request without a Payment credential is a free challenge and is never limited.
    expect((await post(app, url, { authorization: "Bearer only" })).status).toBe(402);
    t += 60_000;
    expect((await post(app, url, { authorization: extra })).status).toBe(402); // reaches Stripe again (declined)
    expect(create).toHaveBeenCalledTimes(CARD_ATTEMPTS_PER_MINUTE + 1);
  });

  it("a non-first-scheme credential (Bearer x, Payment <cred>) still pays: the limiter and mppx agree on what a credential is", async () => {
    const { app, withWork, create } = await setup();
    const url = `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`;
    const credential = await agentWallet().client.createCredential(await post(app, url));
    const res = await post(app, url, { authorization: `Bearer x, ${credential}` });
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/unlock-card: replay and double-charge", () => {
  it("the same credential twice: Stripe charges once (idempotency), the replay gets a 402 and no second ledger row", async () => {
    const fake = idempotentStripe();
    const store = new MemoryStore();
    const spy = vi.spyOn(store, "recordUnlock");
    const { app, withWork } = await setup({ create: fake.create, store });
    const url = `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`;
    const credential = await agentWallet().client.createCredential(await post(app, url));
    expect((await post(app, url, { authorization: credential })).status).toBe(200);
    const replay = await post(app, url, { authorization: credential });
    expect(replay.status).toBe(402);
    const body = await replay.json();
    expect(body.code).toBe("payment_failed");
    expect(body.problem.detail).toContain("already been processed");
    expect(body.workaround).toBeUndefined();
    expect(fake.charges()).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await store.stats()).filer_earned_micro).toBe(350_000);
  });

  it("if a replay ever got past mppx (no replay flag), the workaround is re-delivered but the filer is not paid twice", async () => {
    const fake = idempotentStripe({ flagReplays: false });
    const store = new MemoryStore();
    const spy = vi.spyOn(store, "recordUnlock");
    const { app, withWork, log } = await setup({ create: fake.create, store });
    const url = `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`;
    const credential = await agentWallet().client.createCredential(await post(app, url));
    expect((await post(app, url, { authorization: credential })).status).toBe(200);
    const again = await post(app, url, { authorization: credential });
    expect(again.status).toBe(200);
    expect((await again.json()).workaround).toBe(withWork.workaround);
    expect(fake.charges()).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await store.stats()).unlocks).toBe(1);
    expect(log.lines.some((l) => l.includes("pi_test_card_1 was already recorded"))).toBe(true);
  });

  it("two different payments for the same note are two charges and two ledger rows", async () => {
    const fake = idempotentStripe();
    const { app, withWork, store } = await setup({ create: fake.create });
    const url = `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`;
    for (const spt of ["spt_test_a", "spt_test_b"]) {
      const credential = await agentWallet(spt).client.createCredential(await post(app, url));
      expect((await post(app, url, { authorization: credential })).status).toBe(200);
    }
    expect(fake.charges()).toBe(2);
    expect((await store.stats()).unlocks).toBe(2);
  });

  it("an expired challenge is refused before Stripe is called", async () => {
    let t = Date.now();
    const { app, withWork, create } = await setup({ now: () => t });
    const url = `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`;
    const credential = await agentWallet().client.createCredential(await post(app, url));
    vi.useFakeTimers({ now: Date.now() + 6 * 60_000 }); // mppx challenges expire after 5 minutes
    try {
      t = Date.now();
      const res = await post(app, url, { authorization: credential });
      expect(res.status).toBe(402);
    } finally {
      vi.useRealTimers();
    }
    expect(create).not.toHaveBeenCalled();
  });
});

describe("POST /api/unlock-card: never throws", () => {
  it("an oversized JSON body is not read (400, nobody charged)", async () => {
    const { app, create, withWork } = await setup();
    const res = await app.request(`${BASE}${UNLOCK_CARD_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note_id: withWork.id, pad: "x".repeat(MAX_BODY_BYTES) }),
    });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("an oversized streamed body without content-length is refused promptly (no hang), nobody charged", async () => {
    const { app, create } = await setup();
    const chunk = new TextEncoder().encode("x".repeat(1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent++ < 64) ctrl.enqueue(chunk);
        else ctrl.close();
      },
    });
    const req = new Request(`${BASE}${UNLOCK_CARD_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await Promise.race([app.request(req), new Promise<"hung">((r) => setTimeout(() => r("hung"), 2_000))]);
    expect(res).not.toBe("hung");
    expect((res as Response).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("an unexpected error before payment is a 500 JSON answer that charges nobody", async () => {
    const store = new MemoryStore();
    const broken = Object.assign(Object.create(store), {
      getNote: async () => ({ get hidden(): boolean { throw new Error("corrupt row"); } }),
    }) as Store;
    const { app, create, card, log } = await setup({ store: broken });
    const res = await post(app, `${UNLOCK_CARD_PATH}?note_id=00000000-0000-4000-8000-000000000000`);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, code: "internal_error" });
    expect(create).not.toHaveBeenCalled();
    expect(log.lines.some((l) => l.includes("unlock-card internal error: corrupt row"))).toBe(true);

    const tools: Record<string, (a: any) => Promise<any>> = {};
    card.registerTool({ tool: (def: any, cb: any) => { tools[def.name] = cb; } }, broken);
    const out = await tools.notes_unlock_card({ note_id: "00000000-0000-4000-8000-000000000000" });
    expect(out.isError).toBe(true);
    expect(out.structuredContent.code).toBe("internal_error");
  });
});

describe("credentialReach / readJsonLimited", () => {
  const req = (headers: Record<string, string>, body?: string) => new Request("https://x.test/", { method: "POST", headers, body });
  it("is 'stripe' only for an unexpired challenge signed with our secret, found anywhere in Authorization like mppx", async () => {
    const { app, withWork } = await setup();
    const credential = await agentWallet().client.createCredential(await post(app, `${UNLOCK_CARD_PATH}?note_id=${withWork.id}`));
    const secret = mppSecretFrom(KEY);
    expect(credentialReach(req({}), secret)).toBe("none");
    expect(credentialReach(req({ authorization: "Bearer abc" }), secret)).toBe("none");
    expect(credentialReach(req({ authorization: "Payment abc" }), secret)).toBe("local");
    expect(credentialReach(req({ authorization: "payment abc" }), secret)).toBe("local");
    expect(credentialReach(req({ authorization: credential }), secret)).toBe("stripe");
    expect(credentialReach(req({ authorization: `Bearer abc, ${credential}` }), secret)).toBe("stripe");
    expect(credentialReach(req({ authorization: credential }), mppSecretFrom("sk_test_some_other_key"))).toBe("local");
    expect(credentialReach(req({ authorization: credential }), secret, Date.now() + 6 * 60_000)).toBe("local");
  });
  it("reads small JSON, refuses big or malformed bodies", async () => {
    expect(await readJsonLimited(req({ "content-type": "application/json" }, '{"note_id":"a"}'))).toEqual({ note_id: "a" });
    expect(await readJsonLimited(req({ "content-type": "application/json" }, "{bad"))).toBeNull();
    expect(await readJsonLimited(req({ "content-type": "application/json" }, JSON.stringify({ p: "x".repeat(100) })), 50)).toBeNull();
    expect(await readJsonLimited(req({ "content-type": "application/json", "content-length": "999999" }, "{}"))).toBeNull();
  });
});

describe("notes_unlock_card tool", () => {
  function fakeServer() {
    const tools: Record<string, { def: any; cb: (args: any) => Promise<any> }> = {};
    return { tools, tool: (def: any, cb: any) => { tools[def.name] = { def, cb }; } };
  }

  it("returns the payment link, price and instructions for a note with a workaround", async () => {
    const { card, store, withWork, create } = await setup();
    const server = fakeServer();
    card.registerTool(server, store);
    const t = server.tools.notes_unlock_card;
    expect(t.def.inputSchema.parse({ note_id: "x" })).toEqual({ note_id: "x" });
    const out = await t.cb({ note_id: withWork.id });
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toMatchObject({
      ok: true,
      payment_link: `${BASE}/api/unlock-card?note_id=${withWork.id}`,
      price: "0.50 USD",
      method: "POST",
    });
    expect(out.structuredContent.instructions).toContain("402");
    expect(out.structuredContent.instructions).toContain("Shared Payment Token");
    expect(out.structuredContent.instructions).toContain("70%");
    expect(create).not.toHaveBeenCalled();
  });

  it("errors (free) for unknown notes and notes without a workaround", async () => {
    const { card, store, noWork } = await setup();
    const server = fakeServer();
    card.registerTool(server, store);
    const missing = await server.tools.notes_unlock_card.cb({ note_id: "00000000-0000-4000-8000-000000000000" });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.code).toBe("not_found");
    const none = await server.tools.notes_unlock_card.cb({ note_id: noWork.id });
    expect(none.structuredContent.code).toBe("no_workaround");
  });

  it("uses the base URL handed to registerRoutes when the factory had none", async () => {
    const { card, store, withWork } = await setup({ baseUrl: "" });
    card.registerRoutes({ get() {}, post() {} }, store, "https://live.example.test/mcp");
    const server = fakeServer();
    card.registerTool(server, store);
    const out = await server.tools.notes_unlock_card.cb({ note_id: withWork.id });
    expect(out.structuredContent.payment_link).toBe(`https://live.example.test/api/unlock-card?note_id=${withWork.id}`);
  });
});

describe("mppSecretFrom", () => {
  it("derives a stable >=32-byte secret from the Stripe key like the sample, or takes MPP_SECRET_KEY", () => {
    const a = mppSecretFrom(KEY);
    expect(a).toBe(mppSecretFrom(KEY));
    expect(Buffer.from(a, "base64").length).toBe(32);
    expect(a).not.toContain(KEY);
    const override = "x".repeat(40);
    expect(mppSecretFrom(KEY, override)).toBe(override);
    expect(mppSecretFrom(KEY, "short")).toBe(a);
  });

  it("warns (without echoing it) when MPP_SECRET_KEY is too short to use", () => {
    const { stripe } = fakeStripe();
    const log = quietLog();
    createCardUnlock({ stripe, stripeKey: KEY, profileId: PROFILE, mppSecretKey: "short-secret", log });
    expect(log.lines.some((l) => l.includes("MPP_SECRET_KEY is shorter than 32 bytes"))).toBe(true);
    expect(log.lines.join("\n")).not.toContain("short-secret");
  });
});
