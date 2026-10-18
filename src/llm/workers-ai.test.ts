import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageOf as pipelineUsageOf } from "../runtime/pipeline.js";
import {
  CALL_TIMEOUT_MS, DEFAULT_FALLBACK_MODEL, DEFAULT_MAX_TOKENS, DEFAULT_RENDER_MODEL, MAX_FACTS_CHARS, SYSTEM_PROMPT, WorkersAiError,
  buildMessages, cfBaseUrlOf, cleanAnswer, createRenderer, createWorkersAiRenderer, parseRunResponse, usageOf, workersAiConfig, type WorkersAiConfig,
} from "./workers-ai.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-test-token-abcdefghijklmnop";
const ENV = { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: TOKEN };
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/`;
const cfg = (over: Partial<WorkersAiConfig> = {}): WorkersAiConfig => ({ ...workersAiConfig(ENV).cfg!, ...over });

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const legacy = (response: string, usage: unknown = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }) =>
  json({ success: true, errors: [], messages: [], result: { response, usage } });
const openai = (content: string | null, usage: unknown = { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 }, finish = "stop") =>
  json({ success: true, errors: [], messages: [], result: { id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], usage } });
const cfError = (code: number, message: string, status = 400) => json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);

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
/** A fetch that only ends when its signal aborts (a hung Workers AI call). */
const hang = (call: Call) =>
  new Promise<Response>((_, reject) => {
    const s = call.init.signal as AbortSignal;
    s.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
  });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); warn.mockRestore(); });

describe("createRenderer", () => {
  it("returns no renderer and no diags when CF_ACCOUNT_ID or CF_API_TOKEN is missing, and fetches nothing", () => {
    const { fn } = stubFetch(() => legacy("x"));
    for (const env of [{}, { CF_ACCOUNT_ID: ACCOUNT }, { CF_API_TOKEN: TOKEN }, { CF_ACCOUNT_ID: " ", CF_API_TOKEN: TOKEN }, { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: "\n" }]) {
      expect(createRenderer(env)).toEqual({ renderer: null, diags: [] });
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("builds a renderer plus a primary and a fallback diag with credentials, without any network call", () => {
    const { fn } = stubFetch(() => legacy("x"));
    const r = createRenderer({ CF_ACCOUNT_ID: ` ${ACCOUNT}\n`, CF_API_TOKEN: `${TOKEN}\n` });
    expect(r.renderer).not.toBeNull();
    expect(r.diags.map((d) => d.name)).toEqual(["workers-ai", "workers-ai-fallback"]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("defaults: GLM-5.3 Flash, gpt-oss-120b fallback, 45 s per call, low reasoning effort (Forkyard's proven body)", () => {
    expect(workersAiConfig(ENV).cfg).toEqual({
      accountId: ACCOUNT, apiToken: TOKEN, model: "@cf/zai-org/glm-5.3-flash", fallbackModel: "@cf/openai/gpt-oss-120b",
      timeoutMs: 45_000, maxTokens: DEFAULT_MAX_TOKENS, reasoningEffort: "low",
    });
    expect(CALL_TIMEOUT_MS).toBe(45_000);
  });

  it("reads overrides; ignores malformed model ids; 'off' or a duplicate disables the fallback", () => {
    const c = (extra: Record<string, string>) => workersAiConfig({ ...ENV, ...extra }).cfg!;
    expect(c({ RENDER_MODEL: "@cf/meta/llama-4-scout-17b-16e-instruct", RENDER_FALLBACK_MODEL: "@hf/x/y" })).toMatchObject({
      model: "@cf/meta/llama-4-scout-17b-16e-instruct", fallbackModel: "@hf/x/y",
    });
    expect(c({ RENDER_MODEL: "../../accounts/other", RENDER_FALLBACK_MODEL: "gpt-4o" })).toMatchObject({ model: DEFAULT_RENDER_MODEL, fallbackModel: DEFAULT_FALLBACK_MODEL });
    // Dot segments would be resolved by URL parsing and move the request off /ai/run/.
    expect(c({ RENDER_MODEL: "@cf/../..", RENDER_FALLBACK_MODEL: "@cf/x/.." })).toMatchObject({ model: DEFAULT_RENDER_MODEL, fallbackModel: DEFAULT_FALLBACK_MODEL });
    expect(c({ RENDER_MODEL: "@cf/./x" }).model).toBe(DEFAULT_RENDER_MODEL);
    expect(c({ RENDER_FALLBACK_MODEL: "off" }).fallbackModel).toBeNull();
    expect(c({ RENDER_FALLBACK_MODEL: DEFAULT_RENDER_MODEL }).fallbackModel).toBeNull();
    expect(createRenderer({ ...ENV, RENDER_FALLBACK_MODEL: "none" }).diags.map((d) => d.name)).toEqual(["workers-ai"]);
    expect(c({ RENDER_TIMEOUT_MS: "5", RENDER_MAX_TOKENS: "999999", RENDER_REASONING_EFFORT: "LOW" })).toMatchObject({ timeoutMs: 1_000, maxTokens: 8_000, reasoningEffort: "low" });
    expect(c({ RENDER_TIMEOUT_MS: "abc", RENDER_REASONING_EFFORT: "max" })).toMatchObject({ timeoutMs: 45_000, reasoningEffort: "low" });
    expect(c({ RENDER_REASONING_EFFORT: "off" }).reasoningEffort).toBeNull();
    expect(c({ RENDER_REASONING_EFFORT: "high" }).reasoningEffort).toBe("high");
  });

  it("CF_API_BASE_URL: https anywhere; http only for localhost in test mode; credentials/query/other schemes ignored", async () => {
    const prod = { NODE_ENV: "production" };
    const test = { NODE_ENV: "test" };
    expect(cfBaseUrlOf("https://cf-proxy.example.com/client/v4/", prod)).toBe("https://cf-proxy.example.com/client/v4");
    expect(cfBaseUrlOf("http://127.0.0.1:3790/client/v4", test)).toBe("http://127.0.0.1:3790/client/v4");
    expect(cfBaseUrlOf("http://localhost:3790/client/v4", { VITEST: "true" })).toBe("http://localhost:3790/client/v4");
    // Plain http outside test mode, or to a non-local host, never carries the token.
    expect(cfBaseUrlOf("http://127.0.0.1:3790/client/v4", prod)).toBeUndefined();
    expect(cfBaseUrlOf("http://127.0.0.1:3790/client/v4", {})).toBeUndefined();
    expect(cfBaseUrlOf("http://cf-proxy.example.com/client/v4", test)).toBeUndefined();
    for (const bad of ["https://u:p@cf-proxy.example.com", "https://cf-proxy.example.com/?x=1", "https://cf-proxy.example.com/#f", "ftp://x.example.com", "not a url", ""]) {
      expect(cfBaseUrlOf(bad, test)).toBeUndefined();
    }
    expect(workersAiConfig({ ...ENV, NODE_ENV: "production", CF_API_BASE_URL: "http://127.0.0.1:1/client/v4" }).cfg).not.toHaveProperty("baseUrl");
    const local = workersAiConfig({ ...ENV, NODE_ENV: "test", CF_API_BASE_URL: "http://127.0.0.1:3790/client/v4/" }).cfg!;
    expect(local.baseUrl).toBe("http://127.0.0.1:3790/client/v4");
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => legacy("OK"));
    vi.stubGlobal("fetch", fn);
    try {
      const r = await createWorkersAiRenderer({ ...local, fallbackModel: null }).render("t", "- f");
      expect(r.text).toBe("OK");
      expect(String(fn.mock.calls[0][0])).toBe(`http://127.0.0.1:3790/client/v4/accounts/${ACCOUNT}/ai/run/${DEFAULT_RENDER_MODEL}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a malformed account id gives no renderer and a diag that says why, with no network call", async () => {
    const { fn } = stubFetch(() => legacy("x"));
    const r = createRenderer({ CF_ACCOUNT_ID: "../../zones", CF_API_TOKEN: TOKEN });
    expect(r.renderer).toBeNull();
    expect(r.diags.map((d) => d.name)).toEqual(["workers-ai"]);
    const d = await r.diags[0].check();
    expect(d.ok).toBe(false);
    expect(d.detail).toMatch(/CF_ACCOUNT_ID is malformed/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("a token with spaces or control characters gives no renderer and a diag that says why, never the token", async () => {
    const { fn } = stubFetch(() => legacy("x"));
    for (const bad of [`${TOKEN} extra`, `abc\n${TOKEN}`, "short"]) {
      const r = createRenderer({ CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: bad });
      expect(r.renderer).toBeNull();
      const d = await r.diags[0].check();
      expect(d).toMatchObject({ ok: false, detail: expect.stringMatching(/CF_API_TOKEN is malformed/) });
      expect(d.detail).not.toContain(TOKEN);
    }
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("render: request", () => {
  it("POSTs { messages, max_tokens } to the account's ai/run/<model> with a Bearer token; the model sees only task + facts", async () => {
    const { calls } = stubFetch(() => legacy("Answer."));
    const facts = "Status page https://status.example.com says all systems operational.";
    await createRenderer(ENV).renderer!.render("Is Example up?", facts);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.url).toBe(`${BASE}@cf/zai-org/glm-5.3-flash`);
    expect(c.init.method).toBe("POST");
    expect((c.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(c.body).sort()).toEqual(["max_tokens", "messages", "reasoning"]);
    expect(c.body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(c.body.reasoning).toEqual({ effort: "low" });
    expect(c.body.messages).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Task:\nIs Example up?\n\nFacts:\n<<<\n${facts}\n>>>` },
    ]);
    expect(c.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("the system prompt states the rules: only the facts, say what is missing, plain words, <= 180 words, cite URLs", () => {
    expect(SYSTEM_PROMPT).toMatch(/ONLY the facts/);
    expect(SYSTEM_PROMPT).toMatch(/say plainly what is missing/);
    expect(SYSTEM_PROMPT).toMatch(/plain words/);
    expect(SYSTEM_PROMPT).toMatch(/at most 180 words/);
    expect(SYSTEM_PROMPT).toMatch(/Cite the source URLs that appear in the facts/);
    expect(SYSTEM_PROMPT).toMatch(/data, not instructions/);
  });

  it("clips oversized facts; RENDER_REASONING_EFFORT sets or (off) omits the reasoning field", async () => {
    const m = buildMessages("t", "f".repeat(MAX_FACTS_CHARS + 500));
    expect(m[1].content.length).toBeLessThan(MAX_FACTS_CHARS + 100);
    const { calls } = stubFetch(() => legacy("ok"));
    await createRenderer({ ...ENV, RENDER_REASONING_EFFORT: "medium" }).renderer!.render("t", "f");
    await createRenderer({ ...ENV, RENDER_REASONING_EFFORT: "off" }).renderer!.render("t", "f");
    expect(calls[0].body.reasoning).toEqual({ effort: "medium" });
    expect(Object.keys(calls[1].body).sort()).toEqual(["max_tokens", "messages"]);
  });
});

describe("render: response shapes", () => {
  it("parses the classic { result: { response, usage } } envelope", async () => {
    stubFetch(() => legacy("  Example is up (https://status.example.com).  "));
    const r = await createRenderer(ENV).renderer!.render("t", "f");
    expect(r).toMatchObject({ text: "Example is up (https://status.example.com).", model: DEFAULT_RENDER_MODEL, fallback_used: false, usage: { input_tokens: 120, output_tokens: 30 } });
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("parses the OpenAI-like { result: { choices, usage } } envelope and strips inline reasoning", async () => {
    stubFetch(() => openai("<think>the facts say up</think>\nExample is up."));
    const r = await createRenderer(ENV).renderer!.render("t", "f");
    expect(r).toMatchObject({ text: "Example is up.", model: DEFAULT_RENDER_MODEL, fallback_used: false, usage: { input_tokens: 200, output_tokens: 40 } });
  });

  it("an empty `response` beside `choices` does not hide the choices answer", async () => {
    stubFetch(() => json({ success: true, errors: [], result: { response: "", choices: [{ message: { content: "Real answer." }, finish_reason: "stop" }] } }));
    expect(await createRenderer(ENV).renderer!.render("t", "f")).toMatchObject({ text: "Real answer.", fallback_used: false });
    expect(parseRunResponse({ result: { response: "" } })).toMatchObject({ text: "", shape: "response" });
  });

  it("missing usage maps to zeros; Responses-style usage names map too", async () => {
    stubFetch(() => json({ success: true, errors: [], result: { response: "hi" } }));
    expect((await createRenderer(ENV).renderer!.render("t", "f")).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(usageOf({ input_tokens: 7, output_tokens: 3 })).toEqual({ input_tokens: 7, output_tokens: 3 });
    expect(usageOf({ total_tokens: 99 })).toEqual({ input_tokens: 0, output_tokens: 0 }); // never split a total we can't split
    expect(usageOf({ prompt_tokens: -1, completion_tokens: "5" })).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("render: timeout and fallback", () => {
  it("a hung primary is aborted after 45 s and the fallback answers", async () => {
    vi.useFakeTimers();
    const { calls } = stubFetch((c) => (c.url.endsWith(DEFAULT_RENDER_MODEL) ? hang(c) : openai("From the fallback.")));
    const p = createRenderer(ENV).renderer!.render("t", "f");
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(calls.map((c) => c.url)).toEqual([`${BASE}${DEFAULT_RENDER_MODEL}`, `${BASE}${DEFAULT_FALLBACK_MODEL}`]);
    expect((calls[0].init.signal as AbortSignal).aborted).toBe(true);
    expect(r).toMatchObject({ text: "From the fallback.", model: DEFAULT_FALLBACK_MODEL, fallback_used: true, usage: { input_tokens: 200, output_tokens: 40 } });
    expect(r.ms).toBeGreaterThanOrEqual(CALL_TIMEOUT_MS);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/glm-5\.3-flash timed out after 45 s; trying @cf\/openai\/gpt-oss-120b/));
  });

  it("times out even when fetch ignores the abort signal", async () => {
    stubFetch((c) => (c.url.endsWith(DEFAULT_RENDER_MODEL) ? new Promise<Response>(() => {}) : legacy("fallback")));
    const r = await createWorkersAiRenderer(cfg({ timeoutMs: 20 })).render("t", "f");
    expect(r).toMatchObject({ text: "fallback", fallback_used: true });
  });

  it("a slow body read counts against the same timeout", async () => {
    stubFetch((c) => {
      if (!c.url.endsWith(DEFAULT_RENDER_MODEL)) return legacy("fallback");
      return { ok: true, status: 200, text: () => new Promise<string>(() => {}) } as unknown as Response;
    });
    expect(await createWorkersAiRenderer(cfg({ timeoutMs: 20 })).render("t", "f")).toMatchObject({ fallback_used: true });
  });

  it("falls back on HTTP 5xx, a CF error envelope (even with HTTP 200), a network error, or an empty answer", async () => {
    const primaries: Array<() => Response | Promise<Response>> = [
      () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      () => cfError(3040, "Capacity temporarily exceeded", 429),
      () => cfError(5006, "Error: required properties at '/' are 'prompt'", 200),
      () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })),
      () => openai(null, { prompt_tokens: 50, completion_tokens: 1500 }, "length"), // reasoning used every token
      () => json({ success: true, errors: [], result: {} }),
    ];
    for (const primary of primaries) {
      stubFetch((c) => (c.url.endsWith(DEFAULT_RENDER_MODEL) ? primary() : legacy("fb", { prompt_tokens: 10, completion_tokens: 2 })));
      const r = await createWorkersAiRenderer(cfg()).render("t", "f");
      expect(r).toMatchObject({ text: "fb", model: DEFAULT_FALLBACK_MODEL, fallback_used: true });
    }
    // Tokens the empty primary reply spent are still counted.
    stubFetch((c) => (c.url.endsWith(DEFAULT_RENDER_MODEL) ? openai("<think>still thinking", { prompt_tokens: 50, completion_tokens: 1500 }, "length") : legacy("fb", { prompt_tokens: 10, completion_tokens: 2 })));
    expect((await createWorkersAiRenderer(cfg()).render("t", "f")).usage).toEqual({ input_tokens: 60, output_tokens: 1502 });
  });

  it("both models failing throws one clear WorkersAiError naming each model and reason, without secrets", async () => {
    stubFetch((c) => (c.url.endsWith(DEFAULT_RENDER_MODEL) ? new Promise<Response>(() => {}) : cfError(10000, `Authentication error for ${TOKEN} on ${ACCOUNT}`, 401)));
    const err = await createWorkersAiRenderer(cfg({ timeoutMs: 20 })).render("t", "f").catch((e) => e);
    expect(err).toBeInstanceOf(WorkersAiError);
    expect(err.code).toBe("all_failed");
    expect(err.message).toBe(
      "workers-ai render failed: @cf/zai-org/glm-5.3-flash timed out after 20 ms; @cf/openai/gpt-oss-120b http 401 (10000: Authentication error for [redacted] on [redacted])",
    );
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(ACCOUNT);
  });

  it("never echoes the model's answer text into an error", async () => {
    stubFetch(() => openai("<think>secret-ish reasoning about the facts"));
    const err = await createWorkersAiRenderer(cfg()).render("t", "f").catch((e) => e);
    expect(err.message).toMatch(/gave no answer text \(finish stop\)/);
    expect(err.message).not.toContain("secret-ish");
    // A 2xx body cut off mid-answer is not JSON: its text stays out of the message (run timings are public).
    stubFetch(() => new Response('{"result":{"response":"partial private-ish answer', { status: 200 }));
    const cut = await createWorkersAiRenderer(cfg()).render("t", "f").catch((e) => e);
    expect(cut.message).toMatch(/http 200 non-JSON reply \(\d+ chars\)/);
    expect(cut.message).not.toContain("private-ish");
  });

  it("a failed render carries the tokens already spent as err.usage, which the pipeline bills", async () => {
    stubFetch((c) => (c.url.endsWith(DEFAULT_RENDER_MODEL) ? openai(null, { prompt_tokens: 50, completion_tokens: 1500 }, "length") : new Response("oops", { status: 500 })));
    const err = await createWorkersAiRenderer(cfg()).render("t", "f").catch((e) => e);
    expect(err).toBeInstanceOf(WorkersAiError);
    expect(err.usage).toEqual({ input_tokens: 50, output_tokens: 1500 });
    expect(pipelineUsageOf(err)).toEqual({ input_tokens: 50, output_tokens: 1500 });
    // Nothing reported spent: no usage on the error (so the pipeline doesn't record a zero-token bill).
    stubFetch(() => new Response("oops", { status: 500 }));
    const none = await createWorkersAiRenderer(cfg()).render("t", "f").catch((e) => e);
    expect(none.usage).toBeUndefined();
    expect(pipelineUsageOf(none)).toBeUndefined();
  });

  it("with the fallback off, a primary failure throws after one call", async () => {
    const { calls } = stubFetch(() => new Response("oops", { status: 500 }));
    const err = await createWorkersAiRenderer(cfg({ fallbackModel: null })).render("t", "f").catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(err.message).toBe("workers-ai render failed: @cf/zai-org/glm-5.3-flash http 500: oops");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("parseRunResponse", () => {
  it("accepts unwrapped results, string results, content-part arrays and a Responses-API output list", () => {
    expect(parseRunResponse({ response: "a" })).toMatchObject({ text: "a", shape: "response" });
    expect(parseRunResponse({ choices: [{ message: { content: "b" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } })).toMatchObject({ text: "b", shape: "choices", usage: { input_tokens: 1, output_tokens: 2 } });
    expect(parseRunResponse({ success: true, result: "c" })).toMatchObject({ text: "c", shape: "string" });
    expect(parseRunResponse({ result: { choices: [{ message: { content: [{ type: "text", text: "d1" }, { type: "text", text: "d2" }] } }] } }).text).toBe("d1d2");
    expect(parseRunResponse({ result: { choices: [{ text: "e" }] } }).text).toBe("e");
    expect(parseRunResponse({ result: { response: { answer: 1 } } }).text).toBe('{"answer":1}');
    expect(parseRunResponse({
      result: {
        output: [
          { type: "reasoning", content: [{ type: "reasoning_text", text: "hmm" }] },
          { type: "message", content: [{ type: "output_text", text: "f" }] },
        ],
        usage: { input_tokens: 3, output_tokens: 4 },
        status: "completed",
      },
    })).toMatchObject({ text: "f", shape: "output", usage: { input_tokens: 3, output_tokens: 4 }, finish_reason: "completed" });
  });

  it("success:false and error-only envelopes are cf_error; unknown shapes are no_text; non-objects bad_json", () => {
    const code = (v: unknown) => { try { parseRunResponse(v); return "parsed"; } catch (e) { return (e as WorkersAiError).code; } };
    expect(code({ success: false, errors: [{ code: 7000, message: "No route for that URI" }], result: null })).toBe("cf_error");
    expect(code({ success: false, errors: [] })).toBe("cf_error");
    expect(code({ errors: ["boom"], result: null })).toBe("cf_error");
    expect(code({ success: true, result: { foo: 1 } })).toBe("no_text");
    expect(code({ success: true, result: null })).toBe("no_text");
    expect(code([1, 2])).toBe("bad_json");
    expect(() => parseRunResponse({ success: false, errors: [{ code: 7000, message: "No route for that URI" }] })).toThrow("cloudflare error: 7000: No route for that URI");
  });
});

describe("cleanAnswer", () => {
  it("strips think blocks, a lone closing tag, and an unclosed think", () => {
    expect(cleanAnswer("<think>a</think> B <think>c</think>")).toBe("B");
    expect(cleanAnswer("reasoning here</think>\n\nThe answer.")).toBe("The answer.");
    expect(cleanAnswer("<think>never finished")).toBe("");
    expect(cleanAnswer("Plain.")).toBe("Plain.");
  });
});

describe("diag", () => {
  const diag = (env: Record<string, string> = ENV, i = 0) => createRenderer(env).diags[i];

  it("workers-ai: one tiny call on the primary model; detail has model, shape, usage and the raw excerpt", async () => {
    const { calls } = stubFetch(() => openai("OK", { prompt_tokens: 12, completion_tokens: 2 }));
    const r = await diag().check();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}${DEFAULT_RENDER_MODEL}`);
    // Same body shape as render(), so a rejected field (e.g. reasoning) shows up in the diag.
    expect(calls[0].body).toEqual({ messages: [{ role: "user", content: "Reply with the word OK" }], max_tokens: 400, reasoning: { effort: "low" } });
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/^model=@cf\/zai-org\/glm-5\.3-flash reasoning=low shape=choices said "OK" finish=stop usage=\{"input_tokens":12,"output_tokens":2\} \| raw: \{"success":true/);
  });

  it("workers-ai-fallback checks the fallback model", async () => {
    const { calls } = stubFetch(() => legacy("OK"));
    expect((await diag(ENV, 1).check()).detail).toMatch(/^model=@cf\/openai\/gpt-oss-120b reasoning=low shape=response said "OK"/);
    expect((await diag({ ...ENV, RENDER_REASONING_EFFORT: "off" }, 1).check()).detail).toMatch(/^model=@cf\/openai\/gpt-oss-120b reasoning=off /);
    expect(calls[0].url).toBe(`${BASE}${DEFAULT_FALLBACK_MODEL}`);
  });

  it("caps the raw excerpt at 500 chars and redacts the token and account id", async () => {
    stubFetch(() => legacy(`OK ${TOKEN} ${ACCOUNT} ${"x".repeat(2000)}`));
    const r = await diag().check();
    const raw = r.detail.split(" | raw: ")[1];
    expect(raw.length).toBe(500);
    expect(r.detail).not.toContain(TOKEN);
    expect(r.detail).not.toContain(ACCOUNT);
  });

  it("reports a CF error envelope with model, status and raw body, never the token", async () => {
    stubFetch(() => cfError(10000, "Authentication error", 401));
    const r = await diag().check();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/^model=@cf\/zai-org\/glm-5\.3-flash reasoning=low http 401 \(10000: Authentication error\) \| raw: \{"success":false/);
    expect(r.detail).not.toContain(TOKEN);
  });

  it("an empty answer, a non-JSON body or a network error is not ok", async () => {
    stubFetch(() => openai(null, { prompt_tokens: 5, completion_tokens: 200 }, "length"));
    expect(await diag().check()).toMatchObject({ ok: false, detail: expect.stringMatching(/said "" finish=length/) });
    stubFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect((await diag().check()).detail).toMatch(/http 502: <html>Bad gateway<\/html> \| raw: <html>/);
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(await diag().check()).toMatchObject({ ok: false, detail: "model=@cf/zai-org/glm-5.3-flash reasoning=low network error: fetch failed" });
    // A 2xx non-JSON body: the message omits it, the diag still shows the raw excerpt.
    stubFetch(() => new Response("upstream says hi", { status: 200 }));
    expect((await diag().check()).detail).toMatch(/http 200 non-JSON reply \(16 chars\) \| raw: upstream says hi$/);
  });
});
