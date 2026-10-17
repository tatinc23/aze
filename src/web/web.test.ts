import { describe, expect, it } from "vitest";
import { dashboardHtml } from "./dashboard.js";

describe("dashboardHtml", () => {
  const html = dashboardHtml();

  it("polls both live endpoints every 5 s", () => {
    expect(html).toContain("/api/stats");
    expect(html).toContain("/api/scores");
    expect(html).toContain("setInterval(tick, 5000)");
  });

  it("loads nothing from outside (no http(s) URLs)", () => {
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
  });

  it("says test mode, links /connect, escapes note text, and has an honest empty state", () => {
    expect(html).toContain("Test mode: Base Sepolia test USDC");
    expect(html).toContain('href="/connect"');
    expect(html).toContain("function esc(");
    expect(html).toContain("esc(n.what)");
    expect(html).toContain("Day 1: sparse. Day 100: the map.");
  });

  it("ships client JS that parses", () => {
    const js = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
    expect(js.length).toBeGreaterThan(100);
    expect(() => new Function(js)).not.toThrow();
  });
});

// Runs the page's client JS against stub DOM/fetch, so escaping and honest labels are tested on real output.
async function renderWith(stats: unknown, scores: unknown[]) {
  const js = dashboardHtml().match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  const els: Record<string, { innerHTML: string; textContent: string; className: string }> = {};
  const document = {
    hidden: false,
    getElementById: (id: string) => (els[id] ??= { innerHTML: "", textContent: "", className: "" }),
    addEventListener: () => {},
  };
  const body = (path: string) => (path === "/api/stats" ? stats : { scores });
  const fetch = async (path: string) => ({ ok: true, json: async () => body(path) });
  new Function("document", "location", "fetch", "setInterval", js)(document, { origin: "" }, fetch, () => 0);
  await new Promise((r) => setTimeout(r, 0));
  return els;
}
const baseStats = { store: "memory", notes: 1, verified: 0, unverified: 1, queries: 0, unlocks: 0, filer_earned_micro: 0, top_surfaces: [] };

describe("dashboard client render", () => {
  it("escapes agent-written note text, service names and kinds", async () => {
    const els = await renderWith({ ...baseStats, recent: [{ id: "a", created_at: new Date().toISOString(), kind: "<i>k</i>", surface_display: "<img src=x onerror=alert(1)>", what: '<script>alert(2)</script>" onmouseover="x', attestation: "unverified", has_workaround: true }] },
      [{ surface: "e", surface_display: 'Evil" title="x<svg onload=alert(3)>', n: 1, by_kind: {}, score: null, sparse: true }]);
    for (const html of [els.feed.innerHTML, els.svcs.innerHTML]) expect(html).not.toMatch(/<(script|img|svg|i)\b|" (onmouseover|title)=/);
    expect(els.feed.innerHTML).toContain("&lt;script&gt;");
    expect(els.svcs.innerHTML).toContain("Evil&quot; title=&quot;x&lt;svg");
  });

  it("never calls a non-sparse service with no score 'sparse', and shows the empty state when there is no data", async () => {
    const els = await renderWith({ ...baseStats, recent: [] },
      [{ surface: "d", surface_display: "Docs", n: 5, by_kind: { wish: 5 }, score: null, sparse: false },
       { surface: "s", surface_display: "Stripe", n: 6, by_kind: { worked_well: 3, friction: 3 }, score: 0.5, sparse: false }]);
    expect(els.svcs.innerHTML).toContain("No score yet");
    expect(els.svcs.innerHTML).toContain("Score <b>50%</b> worked");
    expect(els.svcs.innerHTML).not.toContain("sparse");
    expect(els.feed.innerHTML).toContain("Day 1: sparse. Day 100: the map.");
    expect(els.state.textContent).toBe("Live.");
  });
});
