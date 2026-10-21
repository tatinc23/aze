import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOT_DIAG_DELAY_MS, diagLogLine, providersLine, registerDiag, runDiags, scheduleBootDiag, scrubDetail, secretValues } from "./diag.js";
import { MemoryRunStore } from "../runtime/store.js";
import type { ProviderDiag, RuntimeDeps } from "../runtime/types.js";

const ADDR = "0x1234567890abcdef1234567890ABCDEF12345678";
const ENV = {
  SUBQ_API_KEY: "subq-secret-value-123",
  CF_API_TOKEN: "cf-token-value-abcdefghij",
  CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  STRIPE_SECRET_KEY: "sk_test_abcdefghijklmnop",
  SWARM_SEED: "test test test test test test test test test test test junk",
  ADMIN_KEY: "admin-key-long-enough",
  RENDER_MAX_TOKENS: "1500", // secret-looking name, but too short to be a secret
  SUBQ_CHAT_MODEL: "subq-preview", // not a secret name
};
const leaky = (name: string): ProviderDiag => ({
  name,
  check: async () => ({ ok: true, ms: 3, detail: `key=${ENV.SUBQ_API_KEY} token=${ENV.CF_API_TOKEN} acct=${ENV.CF_ACCOUNT_ID} payTo=${ADDR} sk=sk_test_zzzzzzzzzzzz seed=${ENV.SWARM_SEED}` }),
});
const noSecrets = (s: string) => {
  for (const v of [ENV.SUBQ_API_KEY, ENV.CF_API_TOKEN, ENV.CF_ACCOUNT_ID, ENV.STRIPE_SECRET_KEY, ENV.SWARM_SEED, ADDR, "sk_test_zzzzzzzzzzzz"]) expect(s).not.toContain(v);
};
const runtime = (over: Partial<RuntimeDeps> = {}): RuntimeDeps => ({
  runs: new MemoryRunStore(), router: null, auditor: null, diags: [], payments: null, ...over,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("diag redaction", () => {
  it("secretValues takes secret-named env values of 8+ chars (longest first) and the account ids/addresses", () => {
    const v = secretValues(ENV);
    expect(v).toEqual(expect.arrayContaining([ENV.SUBQ_API_KEY, ENV.CF_API_TOKEN, ENV.CF_ACCOUNT_ID, ENV.STRIPE_SECRET_KEY, ENV.SWARM_SEED, ENV.ADMIN_KEY]));
    expect(v).not.toContain("1500");
    expect(v).not.toContain("subq-preview");
    expect(v[0]).toBe(ENV.SWARM_SEED);
  });

  it("scrubDetail masks secret values, EVM addresses and key-shaped tokens", async () => {
    const d = await leaky("x").check();
    const s = scrubDetail(d.detail, secretValues(ENV));
    noSecrets(s);
    expect(s).toContain("[redacted]");
    expect(s).toContain("0x[address]");
  });

  it("runDiags scrubs every detail and turns a thrown check into ok:false", async () => {
    const r = await runDiags([leaky("a"), { name: "b", check: async () => { throw new Error(`boom ${ENV.SUBQ_API_KEY}`); } }], secretValues(ENV));
    expect(r.map((x) => [x.name, x.ok])).toEqual([["a", true], ["b", false]]);
    noSecrets(JSON.stringify(r));
    expect(r[1].detail).toContain("boom [redacted]");
  });

  it("diagLogLine is 'DIAG ' + JSON [{name, ok, ms, detail}] with details cut to 300 chars", () => {
    const line = diagLogLine([{ name: "p", ok: true, ms: 7, detail: `${"x".repeat(400)} ${ENV.SUBQ_API_KEY}` }, { name: "q", ok: false, ms: 1, detail: `t=${ENV.CF_API_TOKEN}` }], secretValues(ENV));
    expect(line.startsWith("DIAG [")).toBe(true);
    const rows = JSON.parse(line.slice(5));
    expect(rows).toEqual([{ name: "p", ok: true, ms: 7, detail: "x".repeat(300) }, { name: "q", ok: false, ms: 1, detail: "t=[redacted]" }]);
    noSecrets(line);
  });
});

describe("boot lines", () => {
  it("providersLine says which providers are wired, never any value", () => {
    expect(providersLine(runtime())).toBe("RUNTIME providers: router=off auditor=off payments=off diags=0");
    const fake = {} as never;
    const line = providersLine(runtime({
      router: fake, auditor: fake,
      payments: { onSettled: async () => {} }, diags: [leaky("a"), leaky("b")],
    }));
    expect(line).toBe("RUNTIME providers: router=on auditor=on payments=on(x402-record) diags=2");
    expect(providersLine(runtime({ payments: { onSettled: async () => {}, registerTools: () => {}, registerRoutes: () => {} } }))).toContain("payments=on(x402-record,card)");
  });

  it("scheduleBootDiag runs every diag once after 10 s and logs one scrubbed DIAG line; a failing diag never throws", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const calls = vi.fn();
    const diags: ProviderDiag[] = [
      { name: "a", check: async () => { calls(); return { ok: true, detail: `k=${ENV.SUBQ_API_KEY}`, ms: 1 }; } },
      { name: "b", check: async () => { throw new Error("down"); } },
    ];
    scheduleBootDiag(diags, { env: ENV, log: (l) => lines.push(l) });
    await vi.advanceTimersByTimeAsync(BOOT_DIAG_DELAY_MS - 1);
    expect(calls).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(calls).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lines[0].slice(5))).toEqual([
      { name: "a", ok: true, ms: 1, detail: "k=[redacted]" },
      { name: "b", ok: false, ms: expect.any(Number), detail: "down" },
    ]);
  });
});

describe("GET /admin/diag", () => {
  it("needs the admin key (constant-time compare) and returns scrubbed results", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const app = new Hono();
    registerDiag(app, { adminKey: ENV.ADMIN_KEY, diags: [leaky("a")], env: ENV });
    expect((await app.request("/admin/diag")).status).toBe(401);
    expect((await app.request("/admin/diag", { headers: { "x-admin-key": "wrong" } })).status).toBe(401);
    const res = await app.request("/admin/diag", { headers: { "x-admin-key": ENV.ADMIN_KEY } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, providers: [{ name: "a", ok: true, ms: 3 }] });
    noSecrets(JSON.stringify(body));
    const logged = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.startsWith("DIAG ["))).toBe(true);
    noSecrets(logged.join("\n"));
    const off = new Hono();
    registerDiag(off, { diags: [leaky("a")], env: ENV });
    expect((await off.request("/admin/diag", { headers: { "x-admin-key": "" } })).status).toBe(401);
  });
});
