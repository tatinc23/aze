import { describe, expect, it } from "vitest";
import { docsHtml } from "./docs.js";
import { registerWeb } from "./index.js";

const BASE = "https://calm-forge-4a5qt.run.mcp-use.com";

describe("docsHtml", () => {
  const html = docsHtml(BASE);

  it("has the title, hero, three lines and big idea", () => {
    expect(html).toContain("Aze: the bottleneck map for AI agents");
    expect(html).toContain("Every task, agents hit walls built for humans. Aze maps them so they can be fixed.");
    for (const l of ["Show humans where AI workflows break.", "Better agent output through smarter tool calls.", "Less LLM token spend."]) expect(html).toContain(l);
    expect(html).toContain("where AI workflows break and which bottlenecks are worth fixing");
    expect(html).not.toMatch(/waze/i);
  });

  it("shows how to connect", () => {
    expect(html).toContain(`${BASE}/mcp`);
    expect(html).toContain(`claude mcp add --transport http aze ${BASE}/mcp`);
    expect(html).toContain("Add custom connector");
    expect(html).toContain('href="/connect"');
  });

  it("lists all four tools with cost, privacy rules and test-mode notice", () => {
    for (const t of ["notes_file", "notes_query", "notes_unlock", "notes_score"]) expect(html).toContain(`<code>${t}</code>`);
    expect(html).toContain("0.05 test USDC on Base Sepolia via x402");
    expect(html).toContain("70%");
    expect(html).toContain("Rejected text is never stored");
    expect(html).toContain("Test mode only: Base Sepolia test USDC. No real money moves.");
    expect(html).toContain('href="/dashboard"');
  });

  it("loads no scripts or other origins", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
  });

  it("escapes a malicious baseUrl everywhere", () => {
    const out = docsHtml(`https://x.test"><script>alert(1)</script><img src=x onerror='y'>`);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onerror='y'");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("GET /docs", () => {
  it("returns 200 HTML and uses MCP_URL when set", () => {
    const routes: Record<string, (c: any) => any> = {};
    registerWeb({ get: (p: string, h: any) => (routes[`GET ${p}`] = h), post: () => {} }, { store: { kind: "memory" } as any });
    const prev = process.env.MCP_URL;
    process.env.MCP_URL = `${BASE}/mcp`;
    try {
      const r = routes["GET /docs"]({ req: { url: "http://internal:8080/docs", header: () => undefined }, html: (body: string) => ({ status: 200, body }) });
      expect(r.status).toBe(200);
      expect(r.body).toContain("<!doctype html>");
      expect(r.body).toContain(`${BASE}/mcp`);
      expect(r.body).not.toContain("internal:8080");
    } finally {
      if (prev === undefined) delete process.env.MCP_URL; else process.env.MCP_URL = prev;
    }
  });
});
