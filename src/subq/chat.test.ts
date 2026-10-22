import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatClient, askJson, extractJson, rejectedFeatures } from "./chat.js";
import { RETRY, SubqError, type JsonSchemaFormat } from "./wire.js";

const savedRetry = { ...RETRY };
beforeAll(() => Object.assign(RETRY, { waitMs: 0, jitterMs: 0 }));
afterAll(() => Object.assign(RETRY, savedRetry));

const cfg = { baseUrl: "https://api.subq.test/v1", apiKey: "sq-test-key-1234567890", snapModel: "subq-snap-preview", chatModel: "subq-preview" };
const cfgLow = { ...cfg, reasoningEffort: "low" as const };
const OK_FORMAT: JsonSchemaFormat = { name: "ok_check", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };
/** The exact response_format the docs (Muse M1) give for JSON mode. */
const rf = (f: JsonSchemaFormat) => ({ type: "json_schema", json_schema: { name: f.name, strict: true, schema: f.schema } });
/** SubQ's documented error body. */
const subqError = (status: number, message: string, error_type = "validation_error") => json({ detail: { error_type, message } }, status);
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const reply = (content: string, usage = { prompt_tokens: 50, completion_tokens: 10 }) => json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage });

type Call = { url: string; body: any };
function stubFetch(handler: (body: any, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    return handler(body, calls.length);
  }));
  return calls;
}
const replies = (...contents: string[]) => stubFetch((_b, n) => reply(contents[Math.min(n, contents.length) - 1]));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); warn.mockRestore(); });

describe("extractJson", () => {
  it("parses plain JSON, fenced JSON, JSON inside prose, and ignores think blocks", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Sure! Here it is:\n```\n{"a":3}\n```\nAnything else?')).toEqual({ a: 3 });
    expect(extractJson('The args are {"a": {"b": [1, 2]}} as requested.')).toEqual({ a: { b: [1, 2] } });
    expect(extractJson('<think>maybe {"wrong": true}</think>{"a":4}')).toEqual({ a: 4 });
  });
  it("rejects arrays, scalars and garbage without echoing the reply", () => {
    expect(() => extractJson("[1,2]")).toThrow(/not one JSON object/);
    expect(() => extractJson("42")).toThrow();
    let msg = "";
    try { extractJson("secret-ish words { not json"); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toContain("secret-ish");
  });
});

describe("ChatClient", () => {
  it("POSTs the documented JSON-mode request: response_format json_schema strict, max_tokens, reasoning_effort, store false", async () => {
    const calls = replies('{"ok":true}');
    const r = await new ChatClient(cfgLow).complete([{ role: "user", content: "hi" }], { schema: OK_FORMAT, maxTokens: 20 });
    expect(calls[0].url).toBe("https://api.subq.test/v1/chat/completions");
    expect(calls[0].body).toEqual({
      model: "subq-preview",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "ok_check", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } },
      },
      max_tokens: 20,
      reasoning_effort: "low",
      store: false,
    });
    expect(calls[0].body).not.toHaveProperty("max_completion_tokens");
    expect(r).toMatchObject({ text: '{"ok":true}', usage: { input_tokens: 50, output_tokens: 10 }, schema: "ok_check", reasoning_effort: "low", dropped: [] });
  });

  it("sends neither response_format nor reasoning_effort when not asked/configured", async () => {
    const calls = replies("plain");
    await new ChatClient(cfg).complete([{ role: "user", content: "hi" }]);
    expect(calls[0].body).toEqual({ model: "subq-preview", messages: [{ role: "user", content: "hi" }], store: false });
  });

  it("drops a refused schema for good, per schema name: other schemas keep being sent", async () => {
    const other: JsonSchemaFormat = { ...OK_FORMAT, name: "other" };
    const calls = stubFetch((body) =>
      body.response_format?.json_schema?.name === "ok_check" ? json({ error: { message: "Unsupported parameter: response_format" } }, 400) : reply('{"ok":true}'));
    const chat = new ChatClient(cfg);
    const first = await chat.complete([{ role: "user", content: "a" }], { schema: OK_FORMAT });
    expect(first).toMatchObject({ text: '{"ok":true}', schema: null, dropped: [{ feature: "response_format", status: 400 }] });
    expect(first.dropped[0].excerpt).toContain("Unsupported parameter");
    await chat.complete([{ role: "user", content: "b" }], { schema: OK_FORMAT });
    await chat.complete([{ role: "user", content: "c" }], { schema: other });
    expect(calls.map((c) => c.body.response_format?.json_schema?.name ?? null)).toEqual(["ok_check", null, null, "other"]);
    expect([chat.schemaStatus("ok_check"), chat.schemaStatus("other"), chat.schemaStatus("never")]).toEqual(["rejected", "accepted", "unknown"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [422, "response_format/json_schema/schema: must NOT have additional properties"],
    [400, "json_schema is not supported for this model"],
    [400, "strict mode: additionalProperties must be false"],
  ])("treats a %i naming the json schema (documented detail body) as a refusal: %s", async (status, message) => {
    const calls = stubFetch((body) => (body.response_format ? subqError(status, message) : reply('{"ok":true}')));
    expect((await new ChatClient(cfg).complete([{ role: "user", content: "a" }], { schema: OK_FORMAT })).text).toBe('{"ok":true}');
    expect(calls.map((c) => "response_format" in c.body)).toEqual([true, false]);
  });

  it("drops reasoning_effort once when it is refused, then never sends it again", async () => {
    const calls = stubFetch((body) => (body.reasoning_effort ? subqError(400, "reasoning_effort: unsupported for this model") : reply('{"ok":true}')));
    const chat = new ChatClient(cfgLow);
    const r = await chat.complete([{ role: "user", content: "a" }], { schema: OK_FORMAT });
    expect(r).toMatchObject({ reasoning_effort: null, schema: "ok_check", dropped: [{ feature: "reasoning_effort", status: 400 }] });
    await chat.complete([{ role: "user", content: "b" }], { schema: OK_FORMAT });
    expect(calls.map((c) => [c.body.reasoning_effort ?? null, c.body.response_format?.type ?? null])).toEqual([["low", "json_schema"], [null, "json_schema"], [null, "json_schema"]]);
    expect(chat.reasoningEffort).toBeNull();
  });

  it("drops both, one after the other, inside one call (at most 3 sends)", async () => {
    const calls = stubFetch((body) =>
      body.reasoning_effort ? subqError(422, "reasoning_effort must be one of none, high")
        : body.response_format ? subqError(422, "response_format: json_schema not supported") : reply("plain"));
    const r = await new ChatClient(cfgLow).complete([{ role: "user", content: "a" }], { schema: OK_FORMAT });
    expect(r.text).toBe("plain");
    expect(r.dropped.map((d) => d.feature)).toEqual(["reasoning_effort", "response_format"]);
    expect(calls).toHaveLength(3);
  });

  it("does not hide other 400s/422s, even when the request text mentions reasoning or json_schema", async () => {
    stubFetch(() => json({ error: { message: "model not found" } }, 400));
    await expect(new ChatClient(cfgLow).complete([{ role: "user", content: "a" }], { schema: OK_FORMAT })).rejects.toMatchObject({ code: "http", status: 400 });
    const calls = stubFetch(() => subqError(422, "messages/0/role: must be equal to one of the allowed values"));
    await expect(new ChatClient(cfgLow).complete([{ role: "user", content: "explain reasoning and json_schema" }], { schema: OK_FORMAT }))
      .rejects.toMatchObject({ code: "http", status: 422, errorType: "validation_error" });
    expect(calls).toHaveLength(1);
    stubFetch(() => subqError(401, "invalid key for json_schema"));
    await expect(new ChatClient(cfg).complete([{ role: "user", content: "a" }], { schema: OK_FORMAT })).rejects.toMatchObject({ status: 401 });
  });

  it("rejectedFeatures reads the error's message/param, not echoed request text", () => {
    const err = (status: number, body: string) => new SubqError("http", "x", status, body);
    const both = { format: true, effort: true };
    expect(rejectedFeatures(err(400, '{"error":{"message":"Unsupported value","param":"reasoning_effort"}}'), both)).toEqual({ format: false, effort: true });
    expect(rejectedFeatures(err(400, '{"detail":{"error_type":"validation_error","message":"bad messages"},"echo":"response_format reasoning"}'), both)).toEqual({ format: false, effort: false });
    expect(rejectedFeatures(err(400, "response_format not supported"), both)).toEqual({ format: true, effort: false }); // raw text when unparseable
    expect(rejectedFeatures(err(400, "response_format not supported"), { format: false, effort: true })).toEqual({ format: false, effort: false }); // not sent
    expect(rejectedFeatures(new SubqError("timeout", "t"), both)).toEqual({ format: false, effort: false });
  });
});

describe("askJson", () => {
  const ask = (validate = (v: Record<string, unknown>) => v, timeoutMs?: number) =>
    askJson(new ChatClient(cfg), { system: "SYS", user: "USER", validate, timeoutMs, schema: OK_FORMAT });

  it("sends the schema on both attempts", async () => {
    const calls = replies("no json here", '{"ok":true}');
    await ask();
    expect(calls.map((c) => c.body.response_format)).toEqual([rf(OK_FORMAT), rf(OK_FORMAT)]);
  });

  it("retries once with a correction, then returns; usage is summed", async () => {
    const calls = replies("no json here", '{"a":1}');
    const r = await ask();
    expect(r.value).toEqual({ a: 1 });
    expect(r.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
    expect(calls).toHaveLength(2);
    const msgs = calls[1].body.messages;
    expect(msgs[0].content).toMatch(/^SYS\n\nReply with ONLY one JSON object/);
    expect(msgs[2]).toEqual({ role: "assistant", content: "no json here" });
    expect(msgs[3].content).toMatch(/^That was not valid: .*Reply again with ONLY the corrected JSON object\.$/);
  });

  it("retries on validation errors and reports them to the model", async () => {
    const calls = replies('{"a":1}', '{"b":2}');
    const r = await ask((v) => { if (!("b" in v)) throw new Error("missing required key 'b'"); return v; });
    expect(r.value).toEqual({ b: 2 });
    expect(calls[1].body.messages[3].content).toContain("missing required key 'b'");
  });

  it("gives up after one retry with a bad_output error that carries the usage", async () => {
    replies("nope", "still nope");
    const e = await ask().catch((x) => x);
    expect(e).toBeInstanceOf(SubqError);
    expect(e.code).toBe("bad_output");
    expect(e.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
  });

  it("does not retry a timeout", async () => {
    const calls = stubFetch(() => new Promise<Response>(() => {}));
    await expect(ask(undefined, 20)).rejects.toMatchObject({ code: "timeout" });
    expect(calls).toHaveLength(1);
  });

  it("both attempts share one budget: a slow bad first reply leaves the retry only what is left", async () => {
    const calls = stubFetch((_b, n) => (n === 1
      ? new Promise<Response>((r) => setTimeout(() => r(reply("not json")), 100))
      : new Promise<Response>(() => {})));
    const t0 = Date.now();
    await expect(ask(undefined, 400)).rejects.toMatchObject({ code: "timeout", usage: { input_tokens: 50, output_tokens: 10 } });
    expect(Date.now() - t0).toBeLessThan(700); // ~400 ms in all, not 100 + a fresh 400
    expect(calls).toHaveLength(2);
  });

  it("skips the corrective retry when almost no budget is left", async () => {
    const calls = stubFetch(() => new Promise<Response>((r) => setTimeout(() => r(reply("not json")), 80)));
    const e = await ask(undefined, 100).catch((x) => x);
    expect(e).toMatchObject({ code: "bad_output" });
    expect(e.message).toMatch(/no time left to retry/);
    expect(calls).toHaveLength(1);
  });
});
