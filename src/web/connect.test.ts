import { describe, expect, it } from "vitest";
import { connectHtml, esc, qrSvg, resolveBaseUrl } from "./connect.js";
import { registerWeb } from "./index.js";

const BASE = "https://calm-forge-4a5qt.run.mcp-use.com";

describe("connectHtml", () => {
  const html = connectHtml(BASE);

  it("shows the MCP URL, the Claude Code command and the JSON snippet", () => {
    expect(html).toContain(`${BASE}/mcp`);
    expect(html).toContain(`claude mcp add --transport http aze ${BASE}/mcp`);
    expect(html).toContain("&quot;mcpServers&quot;");
    expect(html).toContain("Waze for agents");
  });

  it("says test mode, the privacy rule, the price split, and links the dashboard and QR", () => {
    expect(html).toContain("Test mode: Base Sepolia test USDC");
    expect(html).toContain("No repos, people, emails, paths, or ids");
    expect(html).toContain("the filer gets 70%");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('src="/qr.svg"');
  });

  it("gives each Copy button a distinct accessible name and has a status line", () => {
    for (const l of ["the MCP link", "the Claude Code command", "the JSON snippet", "the line for your agent"])
      expect(html).toContain(`<span class="sr"> ${l}</span>`);
    expect(html).not.toContain('aria-label="Copy"');
    expect(html).toContain('role="status"');
  });

  it("loads nothing from other origins", () => {
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
    expect(html).not.toMatch(/@import|<link /);
  });

  it("escapes a malicious baseUrl everywhere", () => {
    const bad = `https://x.test"><script>alert(1)</script><img src=x onerror='y'>`;
    const out = connectHtml(bad);
    expect(out).not.toContain("<script>alert(1)");
    expect(out).not.toContain("onerror='y'");
    expect(out).not.toContain('x.test">');
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // Only the page's own copy-button script remains.
    expect(out.match(/<script>/g)?.length).toBe(1);
  });
});

describe("esc", () => {
  it("escapes the five HTML specials", () => {
    expect(esc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("resolveBaseUrl", () => {
  it("strips a trailing /mcp and slashes from MCP_URL", () => {
    expect(resolveBaseUrl(`${BASE}/mcp`, "http://localhost:3000/connect")).toBe(BASE);
    expect(resolveBaseUrl(`${BASE}/mcp/`, "http://localhost:3000/connect")).toBe(BASE);
    expect(resolveBaseUrl(`${BASE}/`, "http://localhost:3000/connect")).toBe(BASE);
  });
  it("upgrades to https only when the proxy says so, and ignores the forwarded host", () => {
    expect(resolveBaseUrl(undefined, "http://calm-forge.example/connect", "https")).toBe("https://calm-forge.example");
    expect(resolveBaseUrl(undefined, "http://calm-forge.example/connect", "https, http")).toBe("https://calm-forge.example");
    expect(resolveBaseUrl(undefined, "http://calm-forge.example/connect", "http")).toBe("http://calm-forge.example");
    expect(resolveBaseUrl(undefined, "http://localhost:3400/connect")).toBe("http://localhost:3400");
  });
  it("falls back to the request origin", () => {
    expect(resolveBaseUrl(undefined, "http://localhost:3400/connect?x=1")).toBe("http://localhost:3400");
    expect(resolveBaseUrl("  ", "http://localhost:3400/qr.svg")).toBe("http://localhost:3400");
  });
});

describe("qrSvg", () => {
  it("returns an SVG", async () => {
    const svg = await qrSvg(`${BASE}/connect`);
    expect(svg.trimStart().startsWith("<svg")).toBe(true);
  });
});

describe("routes", () => {
  // Minimal Hono-like stub: capture handlers and call them with a fake context.
  function harness() {
    const routes: Record<string, (c: any) => any> = {};
    const app = {
      get: (p: string, h: any) => (routes[`GET ${p}`] = h),
      post: (p: string, h: any) => (routes[`POST ${p}`] = h),
    };
    registerWeb(app, { store: { kind: "memory" } as any });
    const ctx = (url: string) => ({
      req: { url, header: () => undefined },
      html: (body: string) => ({ status: 200, body }),
      body: (body: string, status: number, headers: Record<string, string>) => ({ status, body, headers }),
      redirect: (to: string) => ({ status: 302, to }),
      json: (o: unknown) => o,
    });
    return { routes, ctx };
  }

  it("GET / redirects to /connect", () => {
    const { routes, ctx } = harness();
    expect(routes["GET /"](ctx("http://localhost:3400/"))).toEqual({ status: 302, to: "/connect" });
  });

  it("GET /qr.svg returns SVG of the /connect URL", async () => {
    const { routes, ctx } = harness();
    const prev = process.env.MCP_URL;
    delete process.env.MCP_URL;
    try {
      const r = await routes["GET /qr.svg"](ctx("http://localhost:3400/qr.svg"));
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toContain("image/svg+xml");
      expect(r.body.startsWith("<svg")).toBe(true);
    } finally {
      if (prev !== undefined) process.env.MCP_URL = prev;
    }
  });

  it("GET /connect uses MCP_URL when set", () => {
    const { routes, ctx } = harness();
    const prev = process.env.MCP_URL;
    process.env.MCP_URL = `${BASE}/mcp`;
    try {
      const r = routes["GET /connect"](ctx("http://internal:8080/connect"));
      expect(r.body).toContain(`${BASE}/mcp`);
      expect(r.body).not.toContain("internal:8080");
    } finally {
      if (prev === undefined) delete process.env.MCP_URL;
      else process.env.MCP_URL = prev;
    }
  });
});
