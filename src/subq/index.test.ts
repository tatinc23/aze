import { afterEach, describe, expect, it, vi } from "vitest";
import { auditModeOf, baseUrlOf, createDiags, createSubq, subqConfig } from "./index.js";

const KEY = "sq-live-diag-key-0987654321";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("createSubq", () => {
  it("returns all null and no diags without SUBQ_API_KEY, and touches nothing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const env of [{}, { SUBQ_API_KEY: "" }, { SUBQ_API_KEY: "   " }]) {
      expect(createSubq(env)).toEqual({ router: null, auditor: null, diags: [] });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("builds the router, the auditor and 3 diags with a key, without any network call", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const s = createSubq({ SUBQ_API_KEY: KEY });
    expect(s.router && s.auditor).toBeTruthy();
    expect(s.diags.map((d) => d.name)).toEqual(["subq-models", "subq-snap", "subq-snap-typed"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SUBQ_AUDIT=off disables only the auditor; shadow/enforce keep it", () => {
    expect(createSubq({ SUBQ_API_KEY: KEY, SUBQ_AUDIT: "off" }).auditor).toBeNull();
    expect(createSubq({ SUBQ_API_KEY: KEY, SUBQ_AUDIT: "off" }).router).not.toBeNull();
    expect([auditModeOf(undefined), auditModeOf("shadow"), auditModeOf("OFF"), auditModeOf("0"), auditModeOf("enforce")]).toEqual(["enforce", "shadow", "off", "off", "enforce"]);
  });

  it("reads base URL and model overrides", () => {
    expect(subqConfig({ SUBQ_API_KEY: KEY })).toEqual({ apiKey: KEY, baseUrl: "https://api.subq.ai/v1", snapModel: "subq-snap-preview" });
    expect(subqConfig({ SUBQ_API_KEY: KEY, SUBQ_BASE_URL: "https://proxy.test/v1/", SUBQ_SNAP_MODEL: "snap-x" }))
      .toMatchObject({ baseUrl: "https://proxy.test/v1", snapModel: "snap-x" });
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
  const cfg = { apiKey: KEY, baseUrl: "https://api.subq.test/v1", snapModel: "subq-snap-preview" };
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
