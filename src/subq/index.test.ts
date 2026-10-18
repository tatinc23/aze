import { afterEach, describe, expect, it, vi } from "vitest";
import { auditModeOf, baseUrlOf, createDiags, createSubq, reasoningEffortOf, subqConfig } from "./index.js";

const KEY = "sq-live-diag-key-0987654321";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("createSubq", () => {
  it("returns all null and no diags without SUBQ_API_KEY, and touches nothing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const env of [{}, { SUBQ_API_KEY: "" }, { SUBQ_API_KEY: "   " }]) {
      expect(createSubq(env)).toEqual({ router: null, args: null, distiller: null, noteWriter: null, auditor: null, diags: [] });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("builds every client and 4 diags with a key, without any network call", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const s = createSubq({ SUBQ_API_KEY: KEY });
    expect(s.router && s.args && s.distiller && s.noteWriter && s.auditor).toBeTruthy();
    expect(s.diags.map((d) => d.name)).toEqual(["subq-models", "subq-snap", "subq-snap-typed", "subq-chat"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SUBQ_AUDIT=off disables only the auditor; shadow/enforce keep it", () => {
    expect(createSubq({ SUBQ_API_KEY: KEY, SUBQ_AUDIT: "off" }).auditor).toBeNull();
    expect(createSubq({ SUBQ_API_KEY: KEY, SUBQ_AUDIT: "off" }).router).not.toBeNull();
    expect([auditModeOf(undefined), auditModeOf("shadow"), auditModeOf("OFF"), auditModeOf("0"), auditModeOf("enforce")]).toEqual(["enforce", "shadow", "off", "off", "enforce"]);
  });

  it("reads base URL and model overrides", () => {
    expect(subqConfig({ SUBQ_API_KEY: KEY })).toEqual({ apiKey: KEY, baseUrl: "https://api.subq.ai/v1", snapModel: "subq-snap-preview", chatModel: "subq-preview", reasoningEffort: "low" });
    expect(subqConfig({ SUBQ_API_KEY: KEY, SUBQ_BASE_URL: "https://proxy.test/v1/", SUBQ_SNAP_MODEL: "snap-x", SUBQ_CHAT_MODEL: "chat-y" }))
      .toMatchObject({ baseUrl: "https://proxy.test/v1", snapModel: "snap-x", chatModel: "chat-y" });
  });

  it("SUBQ_REASONING_EFFORT: documented values pass, off/omit sends none, unset or unknown = low", () => {
    for (const v of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) expect(reasoningEffortOf(v)).toBe(v);
    expect(reasoningEffortOf(" HIGH ")).toBe("high");
    for (const v of ["off", "omit", "unset", "false", "0"]) expect(reasoningEffortOf(v)).toBeNull();
    for (const v of [undefined, "", "turbo"]) expect(reasoningEffortOf(v)).toBe("low");
    expect(subqConfig({ SUBQ_API_KEY: KEY, SUBQ_REASONING_EFFORT: "off" })!.reasoningEffort).toBeNull();
    expect(subqConfig({ SUBQ_API_KEY: KEY, SUBQ_REASONING_EFFORT: "minimal" })!.reasoningEffort).toBe("minimal");
  });

  it("the runtime's chat calls carry the configured reasoning_effort and a json_schema response_format", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return json({ choices: [{ message: { content: '{"facts": "- x"}' } }] });
    }));
    const { distiller } = createSubq({ SUBQ_API_KEY: KEY, SUBQ_REASONING_EFFORT: "medium" });
    expect((await distiller!.distill("t", "raw")).facts).toBe("- x");
    expect(bodies[0]).toMatchObject({ model: "subq-preview", reasoning_effort: "medium", store: false, max_tokens: 1000, response_format: { type: "json_schema", json_schema: { name: "distill", strict: true } } });
  });

  it("SUBQ_BASE_URL: https, or http only for a local fake; anything else falls back to the real API", () => {
    expect(baseUrlOf(undefined)).toBe("https://api.subq.ai/v1");
    expect(baseUrlOf("https://proxy.test/v1//")).toBe("https://proxy.test/v1");
    expect(baseUrlOf("http://localhost:3611/v1")).toBe("http://localhost:3611/v1");
    expect(baseUrlOf("http://127.0.0.1:3611/v1")).toBe("http://127.0.0.1:3611/v1");
    for (const bad of ["http://api.subq.ai/v1", "ftp://x.test", "not a url", "https://user:pw@proxy.test/v1", "https://proxy.test/v1?k=1"]) {
      expect(baseUrlOf(bad)).toBe("https://api.subq.ai/v1");
    }
  });

  it("wires the auditor to Snap with the configured model", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return json({ answers: { private: { noul: 0.01 }, real_issue: { noul: 0.9 }, injection: { noul: 0.01 }, category: { choice: "docs" }, severity: { score: 1 } } });
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { auditor } = createSubq({ SUBQ_API_KEY: KEY, SUBQ_SNAP_MODEL: "snap-x" });
    const a = await auditor!.audit({
      kind: "friction", category: "docs", surface: "example api", surface_display: "Example API", what: "Docs page is out of date", tool: null,
      error_class: null, tokens_spent: null, dollars_spent: null, workaround: null, teaser: null, wish: null,
    }, []);
    expect(a).toMatchObject({ status: "ok", category: "docs", severity: 2, model: "snap-x" });
    expect(calls[0].url).toBe("https://api.subq.ai/v1/systemone");
    expect(calls[0].body.model).toBe("snap-x");
    warn.mockRestore();
  });
});

describe("SubQ diags", () => {
  const cfg = { apiKey: KEY, baseUrl: "https://api.subq.test/v1", snapModel: "subq-snap-preview", chatModel: "subq-preview" };
  const byName = (name: string) => createDiags(cfg).find((d) => d.name === name)!;

  it("subq-models lists ids and includes the raw response excerpt", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("https://api.subq.test/v1/models");
      return json({ object: "list", data: [{ id: "subq-snap-preview" }, { id: "subq-preview" }, { id: "subq-small" }] });
    }));
    const r = await byName("subq-models").check();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/^api\.subq\.test: 3 models: subq-snap-preview, subq-preview, subq-small \| raw: \{"object":"list"/);
  });

  it("subq-models is not ok when the list is empty or a configured model is missing (availability is per key)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [{ id: "subq-preview" }] })));
    const r = await byName("subq-models").check();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("configured but not listed: subq-snap-preview");
    vi.stubGlobal("fetch", vi.fn(async () => json({ unexpected: "shape" })));
    const empty = await byName("subq-models").check();
    expect(empty.ok).toBe(false);
    expect(empty.detail).toContain('raw: {"unexpected":"shape"}');
  });

  it("subq-snap asks one trivial noul; subq-snap-typed exercises choice + score", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.questions.blue) return json({ answers: { blue: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 12, output_tokens: 0 } });
      return json({ answers: { kind: { type: "choice", choice: "outage", probabilities: { outage: 0.9, docs: 0.1 } }, severity: { type: "score", score: 1.8, legend: { "0": "1 mild", "1": "2 bad", "2": "3 total outage" } } } });
    }));
    const snap = await byName("subq-snap").check();
    expect(snap.ok).toBe(true);
    expect(snap.detail).toContain("subq-snap-preview noul p=0.97");
    expect(snap.detail).toContain('raw: {"answers":{"blue"');
    expect(Object.keys(bodies[0].questions)).toEqual(["blue"]);
    expect(bodies[0].questions.blue.criteria).toEqual({ true: "The text says the sky is blue", false: "The text does not say that" });
    const typed = await byName("subq-snap-typed").check();
    expect(typed).toMatchObject({ ok: true });
    expect(typed.detail).toContain("choice=outage severity=3/3");
    expect(bodies[1].questions.kind.criteria).toEqual({ outage: "The service was down", docs: "The docs were wrong" });
  });

  it("subq-chat makes one tiny strict-JSON completion and says what the server took", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return json({ choices: [{ message: { content: '{"ok": true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
    }));
    const r = await createDiags({ ...cfg, reasoningEffort: "low" }).find((d) => d.name === "subq-chat")!.check();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('subq-preview said "{\\"ok\\": true}" json={"ok":true} finish=stop response_format=json_schema reasoning_effort=low');
    expect(r.detail).toContain('| raw: {"choices"');
    expect(bodies[0]).toEqual({
      model: "subq-preview",
      messages: [{ role: "user", content: 'Reply with exactly this JSON object and nothing else: {"ok": true}' }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "diag_ok", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } },
      },
      max_tokens: 200,
      reasoning_effort: "low",
      store: false,
    });
  });

  it("subq-chat reports a refused json_schema / reasoning_effort with the raw refusal excerpt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.reasoning_effort) return json({ detail: { error_type: "validation_error", message: "reasoning_effort: not supported" } }, 422);
      if (body.response_format) return json({ detail: { error_type: "validation_error", message: "response_format: json_schema not supported" } }, 400);
      return json({ choices: [{ message: { content: '{"ok": true}' } }] });
    }));
    const r = await createDiags({ ...cfg, reasoningEffort: "low" }).find((d) => d.name === "subq-chat")!.check();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("response_format=none reasoning_effort=none");
    expect(r.detail).toContain('dropped reasoning_effort (http 422): {"detail":{"error_type":"validation_error","message":"reasoning_effort: not supported"}}');
    expect(r.detail).toContain("dropped response_format (http 400)");
    warn.mockRestore();
  });

  it("reports HTTP errors with the raw excerpt, never the key, and never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`{"error":{"message":"Invalid API key: ${KEY}","type":"auth"}}`, { status: 401 })));
    for (const d of createDiags(cfg)) {
      const r = await d.check();
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/^http 401 \| raw: \{"error"/);
      expect(r.detail).not.toContain(KEY);
      expect(r.detail.length).toBeLessThanOrEqual(600);
    }
  });

  it("reports an unparseable Snap answer as not ok but keeps the raw body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ answers: { blue: { surprise: "shape" } } })));
    const r = await byName("subq-snap").check();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("p=unparsed");
    expect(r.detail).toContain('"surprise":"shape"');
  });
});
