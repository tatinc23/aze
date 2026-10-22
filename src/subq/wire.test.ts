import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOUL_CRITERIA, RETRY, SubqError, buildSnapRequest, choiceOf, errorDetail, noulOf, optionCodeIndex,
  parseModels, parseSnapResponse, parseUsage, redact, scoreLevelOf, subqRequest, subqRequestRetry,
} from "./wire.js";

const cfg = { baseUrl: "https://api.subq.test/v1", apiKey: "sq-test-key-1234567890" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("buildSnapRequest (System One request shape)", () => {
  it("reproduces the Decisions API example from the SubQ docs (Muse M1) exactly", () => {
    const body = buildSnapRequest("subq-snap-preview", "<text, object, or array to evaluate>", {
      escalate: {
        type: "noul", instructions: "Should a nurse see this chat before the patient books anything?",
        criteria: { true: "Breathing trouble, chest pain, or a flare of a known condition", false: "Stable symptoms the patient can book for themselves" },
      },
      queue: {
        type: "choice", instructions: "Which team should own this chat?",
        options: { nurse_line: "Needs a nurse to assess symptoms today", primary_care: "Book with the patient's own doctor", pharmacy: "Refill or medication question only", front_desk: null },
      },
      acuity: { type: "score", instructions: "How soon should someone respond?", levels: ["Within a week", "Within a day", "Within an hour"] },
    });
    // verbatim from docs/muse/m1-m2-provider-facts.md
    expect(body).toEqual(JSON.parse(`{
      "model": "subq-snap-preview",
      "state": "<text, object, or array to evaluate>",
      "questions": {
        "escalate": { "type": "noul", "instructions": "Should a nurse see this chat before the patient books anything?",
                      "criteria": { "true": "Breathing trouble, chest pain, or a flare of a known condition",
                                    "false": "Stable symptoms the patient can book for themselves" } },
        "queue": { "type": "choice", "instructions": "Which team should own this chat?",
                   "criteria": { "nurse_line": "Needs a nurse to assess symptoms today", "primary_care": "Book with the patient's own doctor",
                                 "pharmacy": "Refill or medication question only", "front_desk": null } },
        "acuity": { "type": "score", "instructions": "How soon should someone respond?",
                    "criteria": ["Within a week", "Within a day", "Within an hour"] }
      }
    }`));
    expect(Object.keys((body as { questions: Record<string, unknown> }).questions)).toEqual(["escalate", "queue", "acuity"]);
  });

  it("puts every question's options in criteria: noul {true,false} (SubQ requires it), choice map, score array", () => {
    const body = buildSnapRequest("subq-snap-preview", "STATE", {
      a: { type: "noul", instructions: "yes?" },
      b: { type: "noul", instructions: "sure?", criteria: { true: "It is sure", false: "It is not" } },
      c: { type: "choice", instructions: "which?", options: { auth: "logins", docs: "documentation" } },
      s: { type: "score", instructions: "how bad?", levels: ["low", "mid", "high"] },
    });
    expect(body).toEqual({
      model: "subq-snap-preview",
      state: "STATE",
      questions: {
        a: { type: "noul", instructions: "yes?", criteria: { ...DEFAULT_NOUL_CRITERIA } },
        b: { type: "noul", instructions: "sure?", criteria: { true: "It is sure", false: "It is not" } },
        c: { type: "choice", instructions: "which?", criteria: { auth: "logins", docs: "documentation" } },
        s: { type: "score", instructions: "how bad?", criteria: ["low", "mid", "high"] },
      },
    });
  });

  it("never sends an empty description: blank choice descriptions become null, blank noul criteria the default", () => {
    const body = buildSnapRequest("m", "s", {
      n: { type: "noul", instructions: "x", criteria: { true: "  ", false: "No" } },
      c: { type: "choice", instructions: "x", options: { english: null, french: "", german: " German " } },
    }) as { questions: Record<string, { criteria: unknown }> };
    expect(body.questions.n.criteria).toEqual({ true: DEFAULT_NOUL_CRITERIA.true, false: "No" });
    expect(body.questions.c.criteria).toEqual({ english: null, french: null, german: "German" });
    expect(() => buildSnapRequest("m", "s", { s: { type: "score", instructions: "x", levels: ["low", " "] } })).toThrow(/empty level/);
    expect(() => buildSnapRequest("m", "s", { ["q".repeat(101)]: { type: "noul", instructions: "x" } })).toThrow(/100 chars/);
  });

  it("enforces the documented limits: 1-16 questions, 2-255 options, 2-10 levels", () => {
    const q = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, { type: "noul" as const, instructions: "x" }]));
    expect(() => buildSnapRequest("m", "s", {})).toThrow(SubqError);
    expect(() => buildSnapRequest("m", "s", q(17))).toThrow(/1-16/);
    expect(() => buildSnapRequest("m", "s", q(16))).not.toThrow();
    expect(() => buildSnapRequest("m", "s", { c: { type: "choice", instructions: "x", options: { a: "a" } } })).toThrow(/2-255/);
    expect(() => buildSnapRequest("m", "s", { s: { type: "score", instructions: "x", levels: Array(11).fill("l") } })).toThrow(/2-10/);
  });
});

describe("parseSnapResponse variants", () => {
  it("reads the documented answers for the docs example (noul, choice + probabilities + confidence, score + legend + probabilities + confidence)", () => {
    const r = parseSnapResponse({
      answers: {
        escalate: { type: "noul", noul: 0.92 },
        queue: { type: "choice", choice: "nurse_line", probabilities: { nurse_line: 0.97, primary_care: 0.02, pharmacy: 0.01, front_desk: 0 }, confidence: 1 },
        acuity: { type: "score", score: 1.86, legend: { "0": "Within a week", "1": "Within a day", "2": "Within an hour" }, probabilities: { "0": 0.02, "1": 0.1, "2": 0.88 }, confidence: 0.79 },
      },
      usage: { input_tokens: 812, output_tokens: 0 },
    });
    expect(noulOf(r.answers.escalate)).toBe(0.92);
    expect(choiceOf(r.answers.queue, ["nurse_line", "primary_care", "pharmacy", "front_desk"])).toBe("nurse_line");
    expect(r.answers.queue.confidence).toBe(1);
    expect(scoreLevelOf(r.answers.acuity, ["Within a week", "Within a day", "Within an hour"])).toBe(3);
    expect(r.answers.acuity).toMatchObject({ type: "score", score: 1.86, confidence: 0.79 });
    expect(r.usage).toEqual({ input_tokens: 812, output_tokens: 0 }); // Snap bills input only
  });

  it("reads a legend given as {label: index} by inverting it", () => {
    const levels = ["Within a week", "Within a day", "Within an hour"];
    const r = parseSnapResponse({ answers: { s: { type: "score", score: 0.2, legend: { "Within a week": 0, "Within a day": 1, "Within an hour": 2 } } } });
    expect(r.answers.s.legend).toEqual({ "0": "Within a week", "1": "Within a day", "2": "Within an hour" });
    expect(scoreLevelOf(r.answers.s, levels)).toBe(1);
  });

  it("reads the documented shape: noul number, choice + probabilities, score + legend", () => {
    const r = parseSnapResponse({
      answers: {
        a: { type: "noul", noul: 0.68 },
        c: { type: "choice", choice: "auth", probabilities: { auth: 0.8, docs: 0.2 }, confidence: 0.5 },
        s: { type: "score", score: 1.2, legend: { "0": "Can wait", "1": "This week", "2": "Today" }, probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 }, confidence: 0.4 },
      },
      usage: { input_tokens: 120, output_tokens: 0 },
    });
    expect(noulOf(r.answers.a)).toBe(0.68);
    expect(choiceOf(r.answers.c, ["auth", "docs"])).toBe("auth");
    expect(r.answers.c.confidence).toBe(0.5);
    expect(scoreLevelOf(r.answers.s, ["Can wait", "This week", "Today"])).toBe(2);
    expect(r.usage).toEqual({ input_tokens: 120, output_tokens: 0 });
  });

  it("accepts p / probability / value / bare-number nouls and numeric strings", () => {
    const r = parseSnapResponse({ answers: { a: { p: 0.1 }, b: { probability: "0.2" }, c: { value: 0.3 }, d: 0.4, e: { probabilities: { yes: 0.9, no: 0.1 } } } });
    expect([noulOf(r.answers.a), noulOf(r.answers.b), noulOf(r.answers.c), noulOf(r.answers.d), noulOf(r.answers.e)]).toEqual([0.1, 0.2, 0.3, 0.4, 0.9]);
    expect(noulOf(r.answers.missing)).toBeNull();
  });

  it("clamps probabilities to 0..1", () => {
    const r = parseSnapResponse({ answers: { a: { noul: 1.2 }, b: { noul: -0.1 } } });
    expect(noulOf(r.answers.a)).toBe(1);
    expect(noulOf(r.answers.b)).toBe(0);
  });

  it("accepts answers as an array of {name, ...} and answers nested under result/data", () => {
    expect(noulOf(parseSnapResponse({ answers: [{ name: "a", noul: 0.7 }, { question: "b", answer: { noul: 0.2 } }] }).answers.b)).toBe(0.2);
    expect(noulOf(parseSnapResponse({ result: { answers: { a: { noul: 0.5 } } } }).answers.a)).toBe(0.5);
    expect(noulOf(parseSnapResponse({ answers: { a: { type: "noul", answer: { noul: 0.35 } } } }).answers.a)).toBe(0.35);
    expect(noulOf(parseSnapResponse({ data: { answers: { a: { noul: 0.6 } }, usage: { input_tokens: 3 } } }).answers.a)).toBe(0.6);
    expect(parseSnapResponse({ data: { answers: { a: { noul: 0.6 } }, usage: { input_tokens: 3 } } }).usage.input_tokens).toBe(3);
  });

  it("reads choice from answer/selected/label, or the argmax of probabilities (object or array form)", () => {
    const r = parseSnapResponse({
      answers: {
        a: { answer: "docs" },
        b: { selected: "Rate Limit" },
        c: { probabilities: { auth: 0.1, docs: 0.7, other: 0.2 } },
        d: { probabilities: [{ option: "auth", probability: 0.9 }, { option: "docs", probability: 0.1 }] },
        e: { choice: "not-an-option" },
      },
    });
    const opts = ["auth", "docs", "rate-limit", "other"];
    expect(["a", "b", "c", "d", "e"].map((k) => choiceOf(r.answers[k], opts))).toEqual(["docs", "rate-limit", "docs", "auth", null]);
  });

  it("maps score answers to 1-based levels: 0-based legend, 1-based legend, no legend, probabilities only", () => {
    const five = ["1", "2", "3", "4", "5"];
    const r = parseSnapResponse({
      answers: {
        zero: { score: 2.1, legend: { "0": "a", "1": "b", "2": "c", "3": "d", "4": "e" } },
        one: { score: 4.4, legend: { "1": "a", "2": "b", "3": "c", "4": "d", "5": "e" } },
        bare: { score: 0.4 },
        above: { score: 4.6 },
        probs: { probabilities: { "0": 0.1, "1": 0.1, "2": 0.1, "3": 0.2, "4": 0.5 } },
        labels: { probabilities: { "1 low": 0.9, "5 high": 0.1 } },
        top: { score: 9 },
        none: { confidence: 0.3 },
      },
    });
    const lvl = (k: string, levels = five) => scoreLevelOf(r.answers[k], levels);
    expect(lvl("zero")).toBe(3);
    expect(lvl("one")).toBe(4);
    expect(lvl("bare")).toBe(1);
    expect(lvl("above")).toBe(5); // > n-1 can only be 1-based
    expect(lvl("probs")).toBe(4); // expected index 2.9
    expect(lvl("labels", ["1 low", "2", "3", "4", "5 high"])).toBe(1);
    expect(lvl("top")).toBe(5); // clamped
    expect(lvl("none")).toBeNull();
    expect(scoreLevelOf(undefined, five)).toBeNull();
  });

  it("throws bad_response when there is nothing to read", () => {
    expect(() => parseSnapResponse("nope")).toThrow(SubqError);
    expect(() => parseSnapResponse({ error: "x" })).toThrow(/no answers/);
  });
});

describe("models wire", () => {
  it("parses model ids from data[], models[] or a bare array", () => {
    expect(parseModels({ object: "list", data: [{ id: "subq-preview" }, { id: "subq-snap-preview" }] })).toEqual(["subq-preview", "subq-snap-preview"]);
    expect(parseModels({ models: [{ name: "a" }, "b"] })).toEqual(["a", "b"]);
    expect(parseModels(["x"])).toEqual(["x"]);
    expect(parseModels(null)).toEqual([]);
  });

  it("parseUsage accepts both shapes and never goes negative", () => {
    expect(parseUsage({ input_tokens: 5, output_tokens: 0 })).toEqual({ input_tokens: 5, output_tokens: 0 });
    expect(parseUsage({ prompt_tokens: "7", completion_tokens: 2 })).toEqual({ input_tokens: 7, output_tokens: 2 });
    expect(parseUsage({ input_tokens: -3 })).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(parseUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("errorDetail", () => {
  it("reads the documented SubQ body and the common variants", () => {
    expect(errorDetail('{"detail":{"error_type":"validation_error","message":"too long"}}')).toEqual({ type: "validation_error", message: "too long", param: null });
    expect(errorDetail('{"detail":"Not authenticated"}')).toEqual({ type: null, message: "Not authenticated", param: null });
    expect(errorDetail('{"detail":[{"loc":["body","response_format","json_schema"],"msg":"field required","type":"missing"}]}'))
      .toEqual({ type: "missing", message: "body.response_format.json_schema: field required", param: null });
    expect(errorDetail('{"error":{"message":"Unsupported value","type":"invalid_request_error","param":"reasoning_effort"}}'))
      .toEqual({ type: "invalid_request_error", message: "Unsupported value", param: "reasoning_effort" });
    expect(errorDetail("<html>502</html>")).toEqual({ type: null, message: null, param: null });
    expect(errorDetail("[1]")).toEqual({ type: null, message: null, param: null });
  });
});

describe("redact", () => {
  it("removes the key and bearer/key-shaped tokens and caps the length", () => {
    const t = redact(`bad key ${cfg.apiKey}; Authorization: Bearer abc.def-123; also sk-ABCDEFGH12345`, cfg.apiKey);
    expect(t).not.toContain(cfg.apiKey);
    expect(t).not.toContain("abc.def-123");
    expect(t).not.toContain("sk-ABCDEFGH12345");
    expect(redact("x".repeat(900)).length).toBe(500);
  });
});

describe("subqRequest", () => {
  it("POSTs JSON with the bearer key to base + path", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => json({ ok: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await subqRequest(cfg, { path: "/systemone", body: { a: 1 }, timeoutMs: 1000 });
    expect(r.json).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.subq.test/v1/systemone");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${cfg.apiKey}`);
    expect(JSON.parse(String(init.body))).toEqual({ a: 1 });
  });

  it("GETs without a body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await subqRequest(cfg, { path: "/models", timeoutMs: 1000 });
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it("throws http errors with a redacted excerpt (the key never leaks)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`{"error":"invalid key ${cfg.apiKey}"}`, { status: 401 })));
    const e = await subqRequest(cfg, { path: "/models", timeoutMs: 1000 }).catch((x) => x);
    expect(e).toBeInstanceOf(SubqError);
    expect(e).toMatchObject({ code: "http", status: 401 });
    expect(e.excerpt).toContain("invalid key [redacted]");
    expect(`${e.message} ${e.excerpt}`).not.toContain(cfg.apiKey);
  });

  it("reads the documented error body {detail: {error_type, message}} into errorType", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: { error_type: "validation_error", message: "questions/queue: must have required property 'criteria'" } }, 422)));
    const e = await subqRequest(cfg, { path: "/systemone", body: {}, timeoutMs: 1000 }).catch((x) => x);
    expect(e).toMatchObject({ code: "http", status: 422, errorType: "validation_error" });
    expect(e.message).toMatch(/^subq \/systemone http 422 validation_error: \{"detail"/);
    expect(e.excerpt).toContain("must have required property 'criteria'");
  });

  it("throws bad_json on a non-JSON 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })));
    await expect(subqRequest(cfg, { path: "/systemone", body: {}, timeoutMs: 1000 })).rejects.toMatchObject({ code: "bad_json", excerpt: "<html>gateway</html>" });
  });

  it("times out even when fetch ignores the abort signal", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const t0 = Date.now();
    await expect(subqRequest(cfg, { path: "/systemone", body: {}, timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("maps fetch failures to network errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(subqRequest(cfg, { path: "/models", timeoutMs: 1000 })).rejects.toMatchObject({ code: "network" });
  });
});

describe("choiceOf option codes", () => {
  it("maps System One option codes (A, B, ..., AA) back to the options in the order they were sent", () => {
    expect([optionCodeIndex("A"), optionCodeIndex("Z"), optionCodeIndex("AA"), optionCodeIndex("AB"), optionCodeIndex("a"), optionCodeIndex("ABC")]).toEqual([0, 25, 26, 27, null, null]);
    const opts = ["outage", "docs"];
    const ans = (a: unknown) => parseSnapResponse({ answers: { k: a } }).answers.k;
    expect(choiceOf(ans({ type: "choice", choice: "B" }), opts)).toBe("docs");
    expect(choiceOf(ans({ type: "choice", probabilities: { A: 0.8, B: 0.2 } }), opts)).toBe("outage");
    expect(choiceOf(ans({ type: "choice", choice: "C" }), opts)).toBeNull(); // out of range: no guess
    expect(choiceOf(ans({ type: "choice", choice: "docs" }), opts)).toBe("docs"); // names still win
  });
});

describe("subqRequestRetry", () => {
  const saved = { ...RETRY };
  afterEach(() => Object.assign(RETRY, saved));
  const fast = () => Object.assign(RETRY, { waitMs: 0, jitterMs: 0, minLeftMs: 50 });

  it.each([429, 500, 503])("retries once on HTTP %i, inside the same budget", async (status) => {
    fast();
    const f = vi.fn().mockResolvedValueOnce(new Response("busy", { status })).mockResolvedValueOnce(json({ ok: 1 }));
    vi.stubGlobal("fetch", f);
    const r = await subqRequestRetry(cfg, { path: "/systemone", body: {}, timeoutMs: 1000 });
    expect(r.json).toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("retries a network error once, then gives up with the second error", async () => {
    fast();
    const f = vi.fn(async () => { throw new TypeError("fetch failed"); });
    vi.stubGlobal("fetch", f);
    await expect(subqRequestRetry(cfg, { path: "/systemone", body: {}, timeoutMs: 1000 })).rejects.toMatchObject({ code: "network" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 402, 403, 422])("never retries HTTP %i (bad request, key, credits, model access)", async (status) => {
    fast();
    const f = vi.fn(async () => new Response('{"detail":{"error_type":"validation_error","message":"nope"}}', { status }));
    vi.stubGlobal("fetch", f);
    await expect(subqRequestRetry(cfg, { path: "/systemone", body: {}, timeoutMs: 1000 })).rejects.toMatchObject({ code: "http", status });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not retry a timeout, nor when too little budget is left", async () => {
    fast();
    const hang = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", hang);
    await expect(subqRequestRetry(cfg, { path: "/x", timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
    expect(hang).toHaveBeenCalledTimes(1);
    Object.assign(RETRY, { minLeftMs: 5_000 });
    const busy = vi.fn(async () => new Response("busy", { status: 429 }));
    vi.stubGlobal("fetch", busy);
    await expect(subqRequestRetry(cfg, { path: "/x", timeoutMs: 1000 })).rejects.toMatchObject({ status: 429 });
    expect(busy).toHaveBeenCalledTimes(1);
  });
});
