import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, StepResult } from "../runtime/types.js";
import {
  ChatClient, DISTILL_FORMAT, MAX_RAW_CHARS, argsFormat, askJson, clampFacts, createArgFiller, createDistiller, createNoteWriter, extractJson, factsOf,
  noteFormat, noteFromReply, rejectedFeatures, validateArgs,
} from "./chat.js";
import { DEFAULT_CATEGORIES } from "./policy.js";
import { KINDS } from "../types.js";
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

const fetchAsset: Asset = {
  id: "web_fetch", kind: "fetch", executor: "http_fetch", description: "Fetch a public web page and return its text",
  input_schema: { type: "object", properties: { url: { type: "string" }, max_bytes: { type: "integer" }, method: { type: "string", enum: ["GET", "HEAD"] } }, required: ["url"] },
  endpoint: null, tool_name: null, active: true,
};
const step = (over: Partial<StepResult> = {}): StepResult => ({ asset_id: "web_fetch", ok: false, output: "", ms: 4100, error: "HTTP 429 Too Many Requests", friction: true, ...over });

const FETCH_STRICT = {
  type: "object",
  properties: {
    url: { type: "string" },
    max_bytes: { type: ["integer", "null"] },
    method: { type: ["string", "null"], enum: ["GET", "HEAD", null] },
  },
  required: ["url", "max_bytes", "method"],
  additionalProperties: false,
};

describe("ArgFiller", () => {
  it("sends a strict schema derived from the asset's input_schema (every key required, optional ones nullable)", async () => {
    const calls = replies('{"url": "https://status.example.com", "max_bytes": null, "method": null}');
    const r = await createArgFiller(new ChatClient(cfgLow)).fill("Fetch the status page", fetchAsset, []);
    expect(r.args).toEqual({ url: "https://status.example.com" }); // nulls on optional args stripped before execution
    expect(calls).toHaveLength(1);
    const { messages, ...rest } = calls[0].body;
    expect(rest).toEqual({
      model: "subq-preview",
      response_format: { type: "json_schema", json_schema: { name: "args_web_fetch", strict: true, schema: FETCH_STRICT } },
      max_tokens: 1000,
      reasoning_effort: "low",
      store: false,
    });
    expect(messages[0].content).toMatch(/use null for an optional argument/);
    expect(messages[1].content).toContain(JSON.stringify(fetchAsset.input_schema)); // the original schema (with its limits) stays in the prompt
    expect(argsFormat(fetchAsset)).toEqual({ name: "args_web_fetch", schema: FETCH_STRICT });
  });

  it("sends no response_format when the input_schema can't be made strict", async () => {
    const odd: Asset = { ...fetchAsset, id: "odd", input_schema: { type: "object", properties: { q: { anyOf: [{ type: "string" }, { type: "number" }] } }, required: ["q"] } };
    const calls = replies('{"q": "x"}');
    const r = await createArgFiller(new ChatClient(cfg)).fill("t", odd, []);
    expect(r.args).toEqual({ q: "x" });
    expect(calls[0].body).not.toHaveProperty("response_format");
    expect(argsFormat(odd)).toBeNull();
  });

  it("a refused args schema only turns JSON mode off for that tool; the distiller keeps its schema", async () => {
    const calls = stubFetch((body) => (body.response_format?.json_schema?.name === "args_web_fetch"
      ? subqError(422, "response_format/json_schema/schema/properties/method/enum: must be string")
      : reply(body.response_format?.json_schema?.name === "distill" ? '{"facts": "- ok"}' : '{"url": "https://a.example", "method": null}')));
    const chat = new ChatClient(cfg);
    const filler = createArgFiller(chat);
    expect((await filler.fill("t", fetchAsset, [])).args).toEqual({ url: "https://a.example" });
    await filler.fill("t", fetchAsset, []);
    await filler.fill("t", { ...fetchAsset, id: "web_fetch_2" }, []);
    expect((await createDistiller(chat).distill("t", "raw")).facts).toBe("- ok");
    expect(calls.map((c) => c.body.response_format?.json_schema?.name ?? null)).toEqual(["args_web_fetch", null, null, "args_web_fetch_2", "distill"]);
  });

  it("fills args that match the schema; retries when a required key is missing", async () => {
    const calls = replies('{"max_bytes": 1000}', '{"url": "https://status.example.com", "max_bytes": 1000}');
    const r = await createArgFiller(new ChatClient(cfg)).fill("Fetch the status page", fetchAsset, [step({ ok: true, asset_id: "notes_query", output: "no advisories", error: null })]);
    expect(r.args).toEqual({ url: "https://status.example.com", max_bytes: 1000 });
    expect(r.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
    expect(calls[1].body.messages[3].content).toContain("missing required key 'url'");
    const user = calls[0].body.messages[1].content;
    expect(user).toContain("TOOL: web_fetch");
    expect(user).toContain('"required":["url"]');
    expect(user).toContain("notes_query (ok)");
  });

  it("unwraps {\"arguments\": {...}} and checks types and enums", async () => {
    replies('{"arguments": {"url": "https://a.example", "method": "POST"}}', '{"arguments": {"url": "https://a.example", "method": "GET"}}');
    const r = await createArgFiller(new ChatClient(cfg)).fill("t", fetchAsset, []);
    expect(r.args).toEqual({ url: "https://a.example", method: "GET" });
  });

  it("makes no call for a tool without arguments", async () => {
    const calls = replies("{}");
    const r = await createArgFiller(new ChatClient(cfg)).fill("t", { ...fetchAsset, input_schema: { type: "object", properties: {} } }, []);
    expect(r).toEqual({ args: {}, ms: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    expect(calls).toHaveLength(0);
  });

  it("validateArgs: drops unknown keys only when additionalProperties is false", () => {
    const schema = { properties: { q: { type: "string" } }, required: ["q"] };
    expect(validateArgs({ q: "x", extra: 1 }, schema)).toEqual({ q: "x", extra: 1 });
    expect(validateArgs({ q: "x", extra: 1 }, { ...schema, additionalProperties: false })).toEqual({ q: "x" });
    expect(() => validateArgs({ q: 3 }, schema)).toThrow(/'q' must be string/);
    expect(() => validateArgs({ q: "" }, schema)).toThrow(/missing required key 'q'/);
  });

  it("validateArgs: strips nulls on optional keys (nested too), but a null required key is still missing", () => {
    const schema = {
      type: "object",
      properties: { q: { type: "string" }, n: { type: "integer" }, opts: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] } },
      required: ["q"],
    };
    expect(validateArgs({ q: "x", n: null, opts: { a: "y", b: null } }, schema)).toEqual({ q: "x", opts: { a: "y" } });
    expect(validateArgs({ args: { q: "x", n: null } }, schema)).toEqual({ q: "x" }); // after unwrapping
    expect(() => validateArgs({ q: null, n: null }, schema)).toThrow(/missing required key 'q'/);
  });
});

describe("Distiller", () => {
  it("asks for the fixed {facts: string} schema and returns its facts, usage mapped", async () => {
    const calls = replies(JSON.stringify({ facts: "- The public API allows 60 requests per minute (https://docs.example.com/limits)\n- Bursts of 10 are allowed" }));
    const r = await createDistiller(new ChatClient(cfgLow)).distill("What is the rate limit?", "<html>…60 requests per minute…</html>");
    expect(r.facts).toBe("- The public API allows 60 requests per minute (https://docs.example.com/limits)\n- Bursts of 10 are allowed");
    expect(r.usage).toEqual({ input_tokens: 50, output_tokens: 10 });
    const { messages, ...rest } = calls[0].body;
    expect(rest).toEqual({
      model: "subq-preview",
      response_format: {
        type: "json_schema",
        json_schema: { name: "distill", strict: true, schema: { type: "object", properties: { facts: { type: "string" } }, required: ["facts"], additionalProperties: false } },
      },
      max_tokens: 1000,
      reasoning_effort: "low",
      store: false,
    });
    expect(DISTILL_FORMAT.name).toBe("distill");
    expect(messages[0].content).toMatch(/never invent/);
    expect(messages[0].content).toMatch(/source URLs/);
    expect(messages[0].content).toContain('{"facts": "..."}');
  });

  it("still takes plain bullets (schema refused or ignored), fences stripped", async () => {
    replies("```\n- The public API allows 60 requests per minute (https://docs.example.com/limits)\n```");
    const r = await createDistiller(new ChatClient(cfg)).distill("What is the rate limit?", "raw");
    expect(r.facts).toBe("- The public API allows 60 requests per minute (https://docs.example.com/limits)");
  });

  it("factsOf: JSON facts, a facts array, a reply cut off mid-string, plain text", () => {
    expect(factsOf('{"facts": "- a\\n- b"}')).toBe("- a\n- b");
    expect(factsOf('<think>x</think>```json\n{"facts": "- a"}\n```')).toBe("- a");
    expect(factsOf('{"facts": ["- a", "- b"]}')).toBe("- a\n- b");
    expect(factsOf('{"facts": "- a\\n- b is cut off \\u00')).toBe("- a\n- b is cut off ");
    expect(factsOf('{"facts": "- quote \\"x\\" then cut \\')).toBe('- quote "x" then cut ');
    expect(factsOf("- plain bullet")).toBe("- plain bullet");
    expect(factsOf('- returns {"error": "x"} on bad input')).toBe('- returns {"error": "x"} on bad input'); // an object without facts is just text
  });

  it("keeps facts to 1500 chars, cut at a line boundary", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `- fact number ${i} with some detail to pad it out`).join("\n");
    replies(long);
    const r = await createDistiller(new ChatClient(cfg)).distill("t", "raw");
    expect(r.facts.length).toBeLessThanOrEqual(1500);
    expect(r.facts.endsWith("pad it out")).toBe(true);
  });

  it("makes no call for empty output and caps huge raw input", async () => {
    const calls = replies("- x");
    expect(await createDistiller(new ChatClient(cfg)).distill("t", "  ")).toEqual({ facts: "", ms: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    expect(calls).toHaveLength(0);
    await createDistiller(new ChatClient(cfg)).distill("t", "y".repeat(MAX_RAW_CHARS + 5000));
    expect(calls[0].body.messages[1].content.length).toBeLessThan(MAX_RAW_CHARS + 500);
    expect(calls[0].body.messages[1].content).toContain("[truncated 5000 chars]");
  });

  it("fails on an empty distillation instead of returning nothing", async () => {
    replies("   ");
    await expect(createDistiller(new ChatClient(cfg)).distill("t", "raw")).rejects.toMatchObject({ code: "bad_output" });
  });

  it("clampFacts hard-cuts when there is no usable line break", () => {
    expect(clampFacts("a".repeat(2000)).length).toBe(1500);
  });
});

const NOTE_SCHEMA = {
  type: "object",
  properties: {
    skip: { type: "boolean" },
    kind: { type: "string", enum: [...KINDS] },
    category: { type: "string", enum: Object.keys(DEFAULT_CATEGORIES) },
    surface: { type: "string" },
    what: { type: "string" },
    tool: { type: ["string", "null"] },
    error: { type: ["string", "null"] },
    workaround: { type: ["string", "null"] },
  },
  required: ["skip", "kind", "category", "surface", "what", "tool", "error", "workaround"],
  additionalProperties: false,
};

describe("NoteWriter", () => {
  it("returns null for {skip: true}, bare or with the strict schema's other fields filled", async () => {
    replies('{"skip": true}');
    const r = await createNoteWriter(new ChatClient(cfg)).write("t", "Example API", step());
    expect(r.note).toBeNull();
    expect(r.usage).toEqual({ input_tokens: 50, output_tokens: 10 });
    replies(JSON.stringify({ skip: true, kind: "friction", category: "other", surface: "Example API", what: "nothing to learn", tool: null, error: null, workaround: null }));
    expect((await createNoteWriter(new ChatClient(cfg)).write("t", "Example API", step())).note).toBeNull();
  });

  it("sends the fixed strict note schema (skip first, optional fields nullable)", async () => {
    const calls = replies('{"skip": true}');
    await createNoteWriter(new ChatClient(cfgLow)).write("t", "Example API", step());
    const { messages, ...rest } = calls[0].body;
    expect(rest).toEqual({
      model: "subq-preview",
      response_format: { type: "json_schema", json_schema: { name: "note", strict: true, schema: NOTE_SCHEMA } },
      max_tokens: 800,
      reasoning_effort: "low",
      store: false,
    });
    expect(Object.keys(NOTE_SCHEMA.properties)[0]).toBe("skip");
    expect(noteFormat(Object.keys(DEFAULT_CATEGORIES))).toEqual({ name: "note", schema: NOTE_SCHEMA });
    expect(noteFormat([]).schema).toMatchObject({ properties: { category: { type: "string" } } });
  });

  it("returns a notes_file input in classes, with the known public surface", async () => {
    const calls = replies(JSON.stringify({
      skip: false, kind: "friction", category: "rate-limit", surface: "something else", what: "Public status endpoint answers 429 after a few quick requests with no Retry-After header",
      tool: "web_fetch", error: "HTTP 429 Too Many Requests", workaround: "Wait a few seconds between requests", extra: "dropped", payout_address: "0x0",
    }));
    const r = await createNoteWriter(new ChatClient(cfg)).write("Check the status page", "Example API", step());
    expect(r.note).toEqual({
      kind: "friction", category: "rate-limit", surface: "Example API", what: "Public status endpoint answers 429 after a few quick requests with no Retry-After header",
      tool: "web_fetch", error: "HTTP 429 Too Many Requests", workaround: "Wait a few seconds between requests",
    });
    const sys = calls[0].body.messages[0].content;
    expect(sys).toMatch(/never include URLs/);
    expect(sys).toContain('{"skip": true}');
    expect(sys).toMatch(/or null/);
  });

  it("maps the schema's nulls back to absent keys before the note goes to notes_file", async () => {
    replies(JSON.stringify({ skip: false, kind: "friction", category: "latency", surface: "Example API", what: "The public status endpoint took over four seconds", tool: null, error: null, workaround: null }));
    const r = await createNoteWriter(new ChatClient(cfg)).write("t", "Example API", step());
    expect(r.note).toEqual({ kind: "friction", category: "latency", surface: "Example API", what: "The public status endpoint took over four seconds" });
    expect(Object.values(r.note!)).not.toContain(null);
  });

  it("runs the privacy gate and retries with its hints; the error never carries the note", async () => {
    const dirty = JSON.stringify({ kind: "friction", category: "docs", what: "Docs at https://internal.corp.example/wiki are wrong for alice@example.com" });
    const calls = replies(dirty, JSON.stringify({ kind: "friction", category: "docs", what: "The docs page for the API is out of date" }));
    const r = await createNoteWriter(new ChatClient(cfg)).write("t", "Example API", step());
    expect(r.note).toMatchObject({ what: "The docs page for the API is out of date" });
    expect(calls[1].body.messages[3].content).toMatch(/privacy gate rejected it: what: (url|email)/);

    replies(dirty, dirty);
    const e = await createNoteWriter(new ChatClient(cfg)).write("t", "Example API", step()).catch((x) => x);
    expect(e).toBeInstanceOf(SubqError);
    expect(e.message).not.toContain("alice");
    expect(e.message).not.toContain("internal.corp");
  });

  it("noteFromReply clamps what to 240 chars at a word boundary", () => {
    const n = noteFromReply({ kind: "friction", category: "latency", what: "slow ".repeat(80) }, "Example API")!;
    expect((n.what as string).length).toBeLessThanOrEqual(240);
    expect((n.what as string).endsWith("slow")).toBe(true);
  });

  it("noteFromReply clamps every field to the gate's limits instead of burning the retry", () => {
    const n = noteFromReply({
      kind: "friction", category: "latency", what: "The status endpoint was slow",
      tool: "tool ".repeat(30), error: "timeout waiting ".repeat(60), workaround: "wait and retry later ".repeat(80),
    }, "Example API")!;
    expect((n.tool as string).length).toBeLessThanOrEqual(80);
    expect((n.error as string).length).toBeLessThanOrEqual(500);
    expect((n.workaround as string).length).toBeLessThanOrEqual(1000);
  });

  it("noteFromReply tolerates a missing surface (uses the model's) instead of crashing", () => {
    const n = noteFromReply({ kind: "friction", category: "docs", surface: "Example API", what: "The docs page is out of date" }, undefined as unknown as string);
    expect(n).toMatchObject({ surface: "Example API" });
  });
});
