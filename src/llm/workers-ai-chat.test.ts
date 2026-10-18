import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkersAiChat, argsBackendOf, createWorkersAiChat } from "./workers-ai-chat.js";
import { WorkersAiError, workersAiConfig, type WorkersAiConfig } from "./workers-ai.js";
import { createArgFiller, createDistiller } from "../subq/chat.js";
import { buildRuntime } from "../runtime/deps.js";
import { providersLine } from "../web/diag.js";
import { MemoryStore } from "../store/memory.js";
import type { Asset } from "../runtime/types.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-test-token-abcdefghijklmnop";
const ENV = { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: TOKEN };
const cfg = (over: Partial<WorkersAiConfig> = {}): WorkersAiConfig => ({ ...workersAiConfig(ENV).cfg!, ...over });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const reply = (response: string, usage = { prompt_tokens: 100, completion_tokens: 20 }) => json({ success: true, errors: [], result: { response, usage } });

type Call = { url: string; init: RequestInit; body: any };
function stubFetch(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const call = { url: String(url), init, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return handler(call, calls.length);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}
const hang = (call: Call) =>
  new Promise<Response>((_, reject) => {
    (call.init.signal as AbortSignal).addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); warn.mockRestore(); });

describe("argsBackendOf", () => {
  it("defaults to workers-ai; only 'subq' picks SubQ chat", () => {
    for (const v of [undefined, "", "workers-ai", "WORKERS-AI", "nonsense"]) expect(argsBackendOf(v)).toBe("workers-ai");
    expect(argsBackendOf(" SubQ ")).toBe("subq");
  });
});

describe("WorkersAiChat.complete", () => {
  it("POSTs the messages to the primary model with at least the renderer's max_tokens; strips think blocks", async () => {
    const { calls } = stubFetch(() => reply('<think>hmm</think>{"ok": true}'));
    const r = await new WorkersAiChat(cfg()).complete([{ role: "user", content: "hi" }], { maxTokens: 200 });
    expect(r.text).toBe('{"ok": true}');
    expect(r.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
    expect(r.schema).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/accounts/${ACCOUNT}/ai/run/@cf/zai-org/glm-5.3-flash`);
    expect(calls[0].body.max_tokens).toBe(1500);
    expect(calls[0].body.response_format).toBeUndefined();
  });

  it("falls back on a primary error and sums the tokens of both calls", async () => {
    const { calls } = stubFetch((_c, n) => (n === 1 ? reply("") : reply('{"a":1}')));
    const r = await new WorkersAiChat(cfg()).complete([{ role: "user", content: "x" }]);
    expect(calls[1].url).toContain("@cf/openai/gpt-oss-120b");
    expect(r.text).toBe('{"a":1}');
    expect(r.usage).toEqual({ input_tokens: 200, output_tokens: 40 });
  });

  it("a hung primary gets 2/3 of the budget, leaving the fallback time to answer", async () => {
    vi.useFakeTimers();
    const { calls } = stubFetch((c, n) => (n === 1 ? hang(c) : reply('{"a":1}')));
    const p = new WorkersAiChat(cfg()).complete([{ role: "user", content: "x" }], { timeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(20_001);
    await expect(p).resolves.toMatchObject({ text: '{"a":1}' });
    expect(calls).toHaveLength(2);
  });

  it("both failing throws one WorkersAiError naming each model, never the token, with spent tokens as usage", async () => {
    stubFetch((_c, n) => (n === 1 ? reply("") : json({ success: false, errors: [{ code: 5007, message: "No such model" }], result: null }, 400)));
    const err = await new WorkersAiChat(cfg()).complete([{ role: "user", content: "x" }]).catch((e) => e);
    expect(err).toBeInstanceOf(WorkersAiError);
    expect(err.message).toMatch(/glm-5\.3-flash gave no answer text.*gpt-oss-120b http 400/);
    expect(err.message).not.toContain(TOKEN);
    expect(err.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
  });
});

describe("factories over Workers AI", () => {
  const asset: Asset = {
    id: "web_fetch", kind: "fetch", executor: "http_fetch", tool_name: null, endpoint: null, active: true, description: "Fetch a public URL",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  };

  it("the arg filler reads fenced JSON from a Workers AI reply", async () => {
    stubFetch(() => reply('```json\n{"url": "https://example.com"}\n```'));
    const r = await createArgFiller(new WorkersAiChat(cfg())).fill("read https://example.com", asset, []);
    expect(r.args).toEqual({ url: "https://example.com" });
  });

  it("a bad reply is retried once, then fails with the workers-ai prefix and the tokens of both tries", async () => {
    stubFetch(() => reply("no json here"));
    const err = await createArgFiller(new WorkersAiChat(cfg({ fallbackModel: null }))).fill("t", asset, []).catch((e) => e);
    expect(err.message).toMatch(/^workers-ai @cf\/zai-org\/glm-5\.3-flash gave no valid JSON after a retry/);
    expect(err.usage).toEqual({ input_tokens: 200, output_tokens: 40 });
  });

  it("the distiller returns bullet facts", async () => {
    stubFetch(() => reply('{"facts": "- the page says hello (https://example.com)"}'));
    const r = await createDistiller(new WorkersAiChat(cfg())).distill("what does it say", "hello");
    expect(r.facts).toContain("hello");
  });
});

describe("buildRuntime chat backend", () => {
  const store = new MemoryStore();
  it("default: args/distiller/notes on Workers AI even without a SubQ key; router stays off without one", () => {
    const fetchSpy = stubFetch(() => reply("x")).fn;
    const rt = buildRuntime({ ...ENV }, store);
    expect(rt.chatBackend).toBe("workers-ai");
    expect(rt.args && rt.distiller && rt.noteWriter).toBeTruthy();
    expect(rt.router).toBeNull();
    expect(providersLine(rt)).toMatch(/^RUNTIME providers: router=off chat=workers-ai args=on distiller=on notes=on renderer=on/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("workers-ai without CF credentials turns the chat tiers off instead of falling back to SubQ chat", () => {
    const rt = buildRuntime({ SUBQ_API_KEY: "sk-test" }, store);
    expect(rt.router).not.toBeNull();
    expect([rt.args, rt.distiller, rt.noteWriter]).toEqual([null, null, null]);
  });

  it("ARGS_BACKEND=subq uses SubQ chat", () => {
    const rt = buildRuntime({ ...ENV, SUBQ_API_KEY: "sk-test", ARGS_BACKEND: "subq" }, store);
    expect(rt.chatBackend).toBe("subq");
    expect(rt.args).not.toBeNull();
  });

  it("createWorkersAiChat is null without credentials", () => {
    expect(createWorkersAiChat({})).toBeNull();
  });
});
