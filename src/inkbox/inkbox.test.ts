import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../types.js";
import { MemoryStore } from "../store/memory.js";
import {
  MAX_SKEW_MS, createSeen, handleDelivery, inkboxConfig, parseCommand, registerInkbox, signatureOk, textOf, timestampOk,
  type InkboxConfig,
} from "./index.js";

const SECRET = "whsec_test-signing-key-123";
const TOKEN = "hook-token-abc";
const ENV = { INKBOX_SIGNING_KEY: SECRET, INKBOX_WEBHOOK_TOKEN: TOKEN, INKBOX_API_KEY: "ik_aze_key", INKBOX_HANDLE: "aze" };
const NOW = Date.parse("2026-10-18T08:00:00Z");
const NOTE = { kind: "barrier", category: "signup", surface: "Inkbox", what: "Signup waits on a code sent to a human inbox", workaround: "Ask the human for the code once, then reuse the session" };

const sign = (body: string, requestId: string, timestamp: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret.replace(/^whsec_/, "")).update(`${requestId}.${timestamp}.${body}`).digest("hex")}`;

const a2a = (text: string, over: Record<string, unknown> = {}) => ({
  id: `evt_${Math.random().toString(36).slice(2)}`,
  event_type: "a2a.task.created",
  timestamp: new Date(NOW).toISOString(),
  data: {
    task_id: "task-123", context_id: "ctx-1", state: "submitted",
    caller: { identity_id: "id-sam", organization_id: "org-1", handle: "samantha", affiliation: { domain: "example.com" } },
    parts: [{ kind: "text", text }],
    ...over,
  },
});

function setup(env: Record<string, string> = ENV) {
  const app = new Hono();
  const store = new MemoryStore();
  const replies: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    replies.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const registered = registerInkbox(app, env, {
    store, runtime: null, settingsOf: async () => DEFAULT_SETTINGS, mcpUrl: "https://aze.example/mcp", fetchImpl, now: () => NOW,
    log: (l) => logs.push(l),
  });
  const post = (payload: unknown, o: { token?: string; ts?: string; rid?: string; sig?: string } = {}) => {
    const body = JSON.stringify(payload);
    const ts = o.ts ?? String(Math.floor(NOW / 1000));
    const rid = o.rid ?? `req-${Math.random().toString(36).slice(2)}`;
    return app.request("/inkbox/webhook", {
      method: "POST",
      headers: {
        authorization: `Bearer ${o.token ?? TOKEN}`, "content-type": "application/json",
        "x-inkbox-request-id": rid, "x-inkbox-timestamp": ts, "x-inkbox-signature": o.sig ?? sign(body, rid, ts),
      },
      body,
    });
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { app, store, replies, logs, registered, post, settle };
}

describe("inkboxConfig", () => {
  it("needs both the signing key and the webhook token; defaults the handle to aze; https-only base URL", () => {
    expect(inkboxConfig({})).toBeNull();
    expect(inkboxConfig({ INKBOX_SIGNING_KEY: "k" })).toBeNull();
    expect(inkboxConfig({ INKBOX_WEBHOOK_TOKEN: "t" })).toBeNull();
    expect(inkboxConfig({ ...ENV, INKBOX_HANDLE: "../evil" })).toBeNull();
    const c = inkboxConfig({ INKBOX_SIGNING_KEY: "k", INKBOX_WEBHOOK_TOKEN: "t" })!;
    expect([c.handle, c.apiKey, c.baseUrl]).toEqual(["aze", null, "https://inkbox.ai"]);
    expect(inkboxConfig({ ...ENV, INKBOX_BASE_URL: "http://evil.example" })!.baseUrl).toBe("https://inkbox.ai");
    expect(inkboxConfig({ ...ENV, INKBOX_BASE_URL: "http://localhost:9999/" })!.baseUrl).toBe("http://localhost:9999");
  });

  it("registers no route without config", async () => {
    const { app, registered } = setup({});
    expect(registered).toBe(false);
    expect((await app.request("/inkbox/webhook", { method: "POST", body: "{}" })).status).toBe(404);
  });
});

describe("delivery checks", () => {
  it("signatureOk matches the SDK's HMAC and never throws on junk", () => {
    const h = { requestId: "r1", timestamp: "1760774400", signature: sign("{}", "r1", "1760774400") };
    expect(signatureOk("{}", h, SECRET)).toBe(true);
    expect(signatureOk("{}", h, SECRET.replace("whsec_", ""))).toBe(true);
    expect(signatureOk("{ }", h, SECRET)).toBe(false);
    for (const signature of ["", "sha256=", "sha256=abc", "md5=" + "0".repeat(64), "sha256=" + "z".repeat(500)]) {
      expect(signatureOk("{}", { ...h, signature }, SECRET)).toBe(false);
    }
  });

  it("timestampOk accepts seconds, milliseconds and ISO within 300 s", () => {
    expect(timestampOk(String(Math.floor(NOW / 1000)), NOW)).toBe(true);
    expect(timestampOk(String(NOW - 200_000), NOW)).toBe(true);
    expect(timestampOk(new Date(NOW + 299_000).toISOString(), NOW)).toBe(true);
    expect(timestampOk(String(Math.floor((NOW - MAX_SKEW_MS - 1000) / 1000)), NOW)).toBe(false);
    expect(timestampOk("yesterday", NOW)).toBe(false);
    expect(timestampOk("", NOW)).toBe(false);
  });

  it("createSeen flags a repeat inside the window and forgets it after", () => {
    let t = 0;
    const seen = createSeen(() => t);
    expect(seen("a")).toBe(false);
    expect(seen("a")).toBe(true);
    t = 2 * MAX_SKEW_MS + 1;
    expect(seen("a")).toBe(false);
  });

  it("the route refuses a wrong token, a bad signature, a stale timestamp and a replay; acks a valid delivery", async () => {
    const { post, replies, settle } = setup();
    const p = a2a("check GitHub");
    expect((await post(p, { token: "nope" })).status).toBe(401);
    expect((await post(p, { sig: "sha256=" + "0".repeat(64) })).status).toBe(401);
    expect((await post(p, { ts: String(Math.floor((NOW - 10 * 60_000) / 1000)) })).status).toBe(401);
    const ok = await post(p, { rid: "req-1" });
    expect(ok.status).toBe(200);
    expect(await (await post(p, { rid: "req-1" })).json()).toEqual({ ok: true, duplicate: true });
    expect(await (await post(p, { rid: "req-2" })).json()).toEqual({ ok: true, duplicate: true }); // same event id
    await settle();
    expect(replies).toHaveLength(1);
  });
});

describe("commands", () => {
  it("parseCommand: check with an optional tool, file with JSON, a bare note object, else help", () => {
    expect(parseCommand("check GitHub")).toEqual({ kind: "check", surface: "GitHub", tool: null });
    expect(parseCommand("Check: Stripe / PaymentIntents?")).toEqual({ kind: "check", surface: "Stripe", tool: "PaymentIntents" });
    expect(parseCommand(`file ${JSON.stringify(NOTE)}`)).toEqual({ kind: "file", note: NOTE });
    expect(parseCommand("```json\n" + JSON.stringify(NOTE) + "\n```")).toEqual({ kind: "file", note: NOTE });
    expect(parseCommand("hello there")).toEqual({ kind: "help" });
    expect(parseCommand("file not json")).toEqual({ kind: "help" });
  });

  it("textOf joins text parts and ignores the rest", () => {
    expect(textOf([{ kind: "text", text: "a" }, { kind: "file" }, { text: "b" }])).toBe("a\nb");
    expect(textOf("nope")).toBe("");
  });
});

describe("handling", () => {
  const cfg: InkboxConfig = inkboxConfig(ENV)!;

  it("file: stores a VERIFIED note without the caller's handle and replies complete on the task", async () => {
    const { post, store, replies, logs, settle } = setup();
    expect((await post(a2a(`file ${JSON.stringify(NOTE)}`))).status).toBe(200);
    await settle();
    expect(replies).toHaveLength(1);
    const r = replies[0];
    expect(r.url).toBe("https://inkbox.ai/api/v1/identities/aze/a2a/tasks/task-123/reply");
    expect(r.headers["X-API-Key"]).toBe("ik_aze_key");
    expect(r.body.intent).toBe("complete");
    expect(r.body.parts[0].text).toMatch(/^Filed\. note_id=.+status VERIFIED/);
    const stats = await store.stats();
    expect([stats.notes, stats.verified]).toEqual([1, 1]);
    const id = /note_id=([\w-]+)/.exec(r.body.parts[0].text)![1];
    expect(JSON.stringify(await store.getNote(id))).not.toMatch(/samantha|id-sam|org-1/);
    expect(logs.join("\n")).toMatch(/a2a\.task\.created task=task-123 filed replied/);
  });

  it("file: a gate rejection names the rule, never echoes the text, stores nothing", async () => {
    const { post, store, replies, logs, settle } = setup();
    const bad = { ...NOTE, what: "Signup broke for jane.doe@corp.example on our repo" };
    await post(a2a(`file ${JSON.stringify(bad)}`));
    await settle();
    expect(replies[0].body.intent).toBe("ask_caller");
    expect(replies[0].body.parts[0].text).toMatch(/what: email/);
    expect(replies[0].body.parts[0].text).not.toContain("jane.doe");
    expect(logs.join("\n")).not.toContain("jane.doe");
    expect((await store.stats()).notes).toBe(0);
  });

  it("check: replies with the advisory; help for anything else", async () => {
    const { post, replies, settle } = setup();
    await post(a2a(`file ${JSON.stringify(NOTE)}`));
    await settle();
    await post(a2a("check Inkbox", { task_id: "task-2" }));
    await post(a2a("what is this?", { task_id: "task-3" }));
    await settle();
    expect(replies[1].body.parts[0].text).toMatch(/^Aze: 1 known issue for Inkbox\.\n1\. \[VERIFIED\] Signup waits/);
    expect(replies[1].body.parts[0].text).toMatch(/notes_unlock note_id=/);
    expect(replies[2].body.intent).toBe("ask_caller");
    expect(replies[2].body.parts[0].text).toMatch(/check <service>/);
  });

  it("ignores email, self-calls, missing caller and bad task ids; never throws", async () => {
    const deps = { store: new MemoryStore(), runtime: null, settingsOf: async () => DEFAULT_SETTINGS, fetchImpl: vi.fn() as unknown as typeof fetch };
    expect(await handleDelivery({ event_type: "message.received", data: {} }, cfg, deps)).toBe("ignored:message.received");
    expect(await handleDelivery(a2a("check X", { caller: { identity_id: "x", handle: "AZE" } }), cfg, deps)).toBe("ignored:self");
    expect(await handleDelivery(a2a("check X", { caller: null }), cfg, deps)).toBe("ignored:caller");
    expect(await handleDelivery(a2a("check X", { task_id: "../x" }), cfg, deps)).toBe("ignored:task_id");
    expect(await handleDelivery("junk", cfg, deps)).toBe("ignored:shape");
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("paused filing and a missing API key are reported, not thrown", async () => {
    const noKey = inkboxConfig({ ...ENV, INKBOX_API_KEY: "" })!;
    const deps = { store: new MemoryStore(), runtime: null, settingsOf: async () => ({ ...DEFAULT_SETTINGS, filing_enabled: false }) };
    expect(await handleDelivery(a2a(`file ${JSON.stringify(NOTE)}`), noKey, deps)).toBe("paused no_api_key");
  });
});
