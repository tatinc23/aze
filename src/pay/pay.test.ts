import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPaywall, NETWORK } from "./index.js";
import { split } from "./split.js";

describe("split", () => {
  it("gives 70/30 of 50000 as 35000/15000", () => {
    expect(split(50000, 7000)).toEqual({ filer: 35000, platform: 15000 });
  });
  it("floors the filer share; the platform keeps the remainder", () => {
    expect(split(33333, 7000)).toEqual({ filer: 23333, platform: 10000 });
    expect(split(1, 7000)).toEqual({ filer: 0, platform: 1 });
    expect(split(50000, 0)).toEqual({ filer: 0, platform: 50000 });
    expect(split(50000, 10000)).toEqual({ filer: 50000, platform: 0 });
  });
  it("throws on bad input", () => {
    expect(() => split(1.5, 7000)).toThrow();
    expect(() => split(-1, 7000)).toThrow();
    expect(() => split(100, -1)).toThrow();
    expect(() => split(100, 10001)).toThrow();
    expect(() => split(100, 70.5)).toThrow();
  });
});

// In-process copy of spike/fake-facilitator.mjs: approves any payload and "settles" with a fake tx hash.
const PAYER = "0x0000000000000000000000000000000000000001";
let fac: http.Server;
let facUrl = "";
beforeAll(async () => {
  fac = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const send = (o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const url = req.url ?? "";
    if (url.endsWith("/supported")) return send({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} });
    const j = JSON.parse(body || "{}");
    const payer = j?.paymentPayload?.payload?.authorization?.from ?? PAYER;
    if (url.endsWith("/verify")) return send({ isValid: true, payer });
    if (url.endsWith("/settle")) return send({ success: true, transaction: "0xFAKE_LOCAL_TX", network: NETWORK, payer });
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => fac.listen(0, "127.0.0.1", r));
  facUrl = `http://127.0.0.1:${(fac.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => fac.close(() => r())));

const PAY_TO = "0x00000000000000000000000000000000000000AA";
const ok = async (args: { note_id: string }) => ({ content: [{ type: "text" as const, text: `workaround for ${args.note_id}` }] });

/** A payload shaped like a client's; the fake facilitator accepts it without checking the signature. */
function fakePayment(accepted: unknown) {
  return {
    x402Version: 2,
    resource: { url: "mcp://tool/notes_unlock", description: "Full workaround for a field note", mimeType: "application/json" },
    accepted,
    payload: { signature: "0x" + "00".repeat(65), authorization: { from: PAYER, to: PAY_TO, value: "50000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "11".repeat(32) } },
  };
}

async function setup(onSettled = vi.fn(async () => {})) {
  const pw = await createPaywall({ facilitatorUrl: facUrl, payTo: PAY_TO, priceMicro: 50000, onSettled });
  // An unpaid call returns the requirements; reuse them as `accepted` for paid calls.
  const unpaid = await pw.wrap(ok)({ note_id: "n1" }, { params: {} });
  return { pw, onSettled, unpaid, accepted: unpaid.structuredContent.accepts[0] };
}

describe("createPaywall", () => {
  it("returns payment required for an unpaid call, priced in USDC on Base Sepolia", async () => {
    const { unpaid, onSettled } = await setup();
    expect(unpaid.isError).toBe(true);
    expect(unpaid.content[0].text).toContain("Payment required");
    expect(unpaid.structuredContent.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, payTo: PAY_TO, amount: "50000" });
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("ignores a payment placed in ctx._meta (mcp-use puts it in ctx.params._meta)", async () => {
    const { pw, accepted, onSettled } = await setup();
    const res = await pw.wrap(ok)({ note_id: "n1" }, { _meta: { "x402/payment": fakePayment(accepted) } });
    expect(res.isError).toBe(true);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("settles a paid call from ctx.params._meta and reports note_id + tx hash", async () => {
    const { pw, accepted, onSettled } = await setup();
    const res = await pw.wrap(ok)({ note_id: "n1" }, { params: { _meta: { "x402/payment": fakePayment(accepted) } } });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe("workaround for n1");
    expect(onSettled).toHaveBeenCalledWith({ note_id: "n1", tx_hash: "0xFAKE_LOCAL_TX", network: NETWORK, amount_micro: 50000 });
  });

  it("does not settle when the handler returns isError", async () => {
    const { pw, accepted, onSettled } = await setup();
    const failing = async () => ({ content: [{ type: "text" as const, text: "note not found" }], isError: true });
    const res = await pw.wrap(failing)({ note_id: "nope" }, { params: { _meta: { "x402/payment": fakePayment(accepted) } } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("note not found");
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("still returns the paid result when the ledger write fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { pw, accepted } = await setup(vi.fn(async () => { throw new Error("db down"); }));
    const res = await pw.wrap(ok)({ note_id: "n1" }, { params: { _meta: { "x402/payment": fakePayment(accepted) } } });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe("workaround for n1");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
