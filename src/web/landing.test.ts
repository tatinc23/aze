import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LANDING_CSP, PROOF_TX, landingHtml } from "./landing.js";

describe("landingHtml", () => {
  const html = landingHtml();

  it("says what Aze is, test mode, and links connect, the live map and the on-chain proof", () => {
    expect(html).toContain("the bottleneck map for AI agents");
    expect(html).toContain("Test mode: Base Sepolia test USDC");
    expect(html).toContain('href="/connect"');
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain(`href="https://sepolia.basescan.org/tx/${PROOF_TX}"`);
  });

  it("does not overstate payouts: the filer's share is a ledger credit", () => {
    expect(html).toContain("credited");
    expect(html).not.toMatch(/goes straight to|paid out on chain/i);
  });

  it("loads nothing from outside: the only external URL is the proof link", () => {
    const urls = html.match(/https?:\/\/[^\s"'<)]+/g) ?? [];
    expect(urls).toEqual([`https://sepolia.basescan.org/tx/${PROOF_TX}`]);
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet|url\(|@import/i);
  });

  it("has a CSP that allows only its own inline script and style (by hash) and same-origin fetches", () => {
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1] ?? "";
    expect(csp).toBe(LANDING_CSP);
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<style>"));
    const hash = (t: string) => `'sha256-${createHash("sha256").update(t, "utf8").digest("base64")}'`;
    expect(csp).toContain(`script-src ${hash(html.match(/<script>([\s\S]*)<\/script>/)![1])}`);
    expect(csp).toContain(`style-src ${hash(html.match(/<style>([\s\S]*)<\/style>/)![1])}`);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(html).not.toMatch(/\sstyle=|style="|\son[a-z]+=/i);
  });

  it("renders live notes escaped, one pin per note, and survives a failed fetch", async () => {
    const js = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
    expect(() => new Function(js)).not.toThrow();
    const els: Record<string, { innerHTML: string; textContent: string; className: string }> = {};
    const document = {
      getElementById: (id: string) => (els[id] ??= { innerHTML: "", textContent: "", className: "" }),
      querySelectorAll: () => [],
      addEventListener: () => {},
    };
    const stats = {
      notes: 2, queries: 3, unlocks: 1, filer_earned_micro: 35000,
      recent: [
        { id: "a", kind: "barrier", surface_display: "<img src=x onerror=alert(1)>", what: "<script>alert(2)</script>", attestation: "verified" },
        { id: "b", kind: "worked_well", surface_display: "GitHub", what: "ok", attestation: "unverified" },
      ],
    };
    const run = async (fetch: unknown) => {
      new Function("document", "fetch", "setTimeout", js)(document, fetch, () => 0);
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    };
    await run(() => Promise.resolve({ ok: true, json: async () => stats }));
    expect(els["t-notes"].textContent).toBe("2");
    expect(els["t-paid"].textContent).toBe("0.035");
    expect((els.pins.innerHTML.match(/<li/g) ?? []).length).toBe(2);
    expect(els.pins.innerHTML).toContain("mk-stop");
    expect(els.pins.innerHTML).toContain("mk-clear");
    for (const h of [els.pins.innerHTML, els.pick.innerHTML]) expect(h).not.toMatch(/<(script|img)\b/);
    expect(els.pick.innerHTML).toContain("&lt;script&gt;");
    expect(els.pick.innerHTML).toContain("Verified");
    expect(els.live.className).toBe("live");
    await run(() => Promise.reject(new Error("down")));
    expect(els.live.className).toBe("live err");
  });
});
