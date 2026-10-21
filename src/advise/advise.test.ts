import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Match, type StoredNote } from "../types.js";
import { buildEnvelope, formatUsdc } from "./index.js";

const stored = (id: string, over: Partial<StoredNote> = {}): StoredNote => ({
  id, created_at: "2026-10-17T00:00:00Z", attestation: "unverified", quarantined: false, tier: "experiment",
  visibility: "public", hidden: false, kind: "friction", category: "auth", surface: "inkbox", surface_display: "Inkbox",
  what: `issue ${id}`, tool: "inbox_create", error_class: null, tokens_spent: null, dollars_spent: null,
  workaround: null, teaser: null, wish: null, ...over,
});
const m = (id: string, over: Partial<StoredNote> = {}, reports = 1): Match => ({ note: stored(id, over), reports });
const withFix = { workaround: "Poll every 5s instead of 1s.", teaser: "Poll every 5s" };

describe("formatUsdc", () => {
  it("formats micro-USDC with at least 2 decimals and no trailing zeros", () => {
    expect(formatUsdc(50000)).toBe("0.05");
    expect(formatUsdc(1234567)).toBe("1.234567");
    expect(formatUsdc(1000000)).toBe("1.00");
    expect(formatUsdc(100000)).toBe("0.10");
    expect(formatUsdc(1500)).toBe("0.0015");
    expect(formatUsdc(0)).toBe("0.00");
    expect(formatUsdc(1)).toBe("0.000001");
  });
  it("rejects non-integer or negative amounts", () => {
    expect(() => formatUsdc(1.5)).toThrow();
    expect(() => formatUsdc(-1)).toThrow();
  });
});

describe("buildEnvelope", () => {
  it("keeps store order and slices to 5", () => {
    const matches = ["a", "b", "c", "d", "e", "f", "g"].map((id, i) => m(id, {}, 10 - i));
    const env = buildEnvelope("inkbox", matches, DEFAULT_SETTINGS, null);
    expect(env.advisories.map((a) => a.note_id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(env.advisories[0].reports).toBe(10);
    expect(env.surface).toBe("inkbox");
    expect(env.score).toBeNull();
  });

  it("labels verified and unverified notes", () => {
    const env = buildEnvelope("inkbox", [m("v", { attestation: "verified" }), m("u")], DEFAULT_SETTINGS, null);
    expect(env.advisories[0]).toMatchObject({ verified: true, label: "VERIFIED" });
    expect(env.advisories[1]).toMatchObject({ verified: false, label: "UNVERIFIED" });
  });

  it("prices only notes with a workaround, and only when unlock is enabled", () => {
    const matches = [m("w", withFix), m("n")];
    const on = buildEnvelope("inkbox", matches, DEFAULT_SETTINGS, null);
    expect(on.advisories[0]).toMatchObject({ has_workaround: true, teaser: "Poll every 5s", price_usdc: "0.05" });
    expect(on.advisories[1]).toMatchObject({ has_workaround: false, teaser: null, price_usdc: null });
    const off = buildEnvelope("inkbox", matches, { ...DEFAULT_SETTINGS, unlock_enabled: false }, null);
    expect(off.advisories[0]).toMatchObject({ has_workaround: true, teaser: "Poll every 5s", price_usdc: null });
  });

  it("never leaks the full workaround", () => {
    const env = buildEnvelope("inkbox", [m("w", withFix)], DEFAULT_SETTINGS, null);
    expect(JSON.stringify(env)).not.toContain(withFix.workaround);
  });

  it("says how to unlock, with the real price and filer share", () => {
    const env = buildEnvelope("inkbox", [m("n"), m("w", withFix)], { ...DEFAULT_SETTINGS, price_micro: 100000, filer_bps: 6500 }, null);
    expect(env.next).toBe("Call notes_unlock with note_id to get the full workaround (0.10 test USDC; 65% goes to the agent who filed it).");
    expect(buildEnvelope("inkbox", [m("w", withFix)], DEFAULT_SETTINGS, null).next).toContain("70% goes to the agent who filed it");
  });

  it("invites a workaround when there are advisories but none is unlockable", () => {
    const msg = "No paid workaround yet. If you solve it, call notes_file with kind 'workaround' and earn a cut of every unlock.";
    expect(buildEnvelope("inkbox", [m("n")], DEFAULT_SETTINGS, null).next).toBe(msg);
    expect(buildEnvelope("inkbox", [m("w", withFix)], { ...DEFAULT_SETTINGS, unlock_enabled: false }, null).next).toBe(msg);
  });

  it("invites filing when there are no matches, and passes the score through", () => {
    const score = { surface: "inkbox", surface_display: "Inkbox", n: 0, by_kind: {}, score: null, sparse: true };
    const env = buildEnvelope("inkbox", [], DEFAULT_SETTINGS, score);
    expect(env.advisories).toEqual([]);
    expect(env.score).toBe(score);
    expect(env.next).toBe("No known issues for this surface yet. If you hit one, call notes_file; you earn a cut when others unlock your workaround.");
  });

  it("never gives a short workaround away as its own teaser (gate teaser = whole text when <= 80 chars)", () => {
    const short = "Use the v2 endpoint with a retry header.";
    const env = buildEnvelope("inkbox", [m("s", { workaround: short, teaser: short })], DEFAULT_SETTINGS, null);
    const t = env.advisories[0].teaser as string;
    expect(t).not.toBe(short);
    expect(t.endsWith("…")).toBe(true);
    expect(short.startsWith(t.slice(0, -1))).toBe(true);
    expect(t.length).toBeLessThan(short.length);
    expect(JSON.stringify(env)).not.toContain(short);
    // A short workaround that itself ends with an ellipsis is still not given away.
    const dots = "Wait 30s and retry…";
    const env2 = buildEnvelope("inkbox", [m("d", { workaround: dots, teaser: dots })], DEFAULT_SETTINGS, null);
    expect(env2.advisories[0].teaser).not.toBe(dots);
    // A gate-style truncated teaser of a long workaround passes through unchanged.
    const long = "x".repeat(100);
    const tease = long.slice(0, 79) + "…";
    expect(buildEnvelope("inkbox", [m("l", { workaround: long, teaser: tease })], DEFAULT_SETTINGS, null).advisories[0].teaser).toBe(tease);
  });

  it("does not fail on a bad price setting when nothing is for sale", () => {
    const bad = { ...DEFAULT_SETTINGS, price_micro: 0.5 };
    expect(buildEnvelope("inkbox", [], bad, null).next).toContain("No known issues");
    expect(buildEnvelope("inkbox", [m("n")], bad, null).advisories[0].price_usdc).toBeNull();
    expect(buildEnvelope("inkbox", [m("w", withFix)], { ...bad, unlock_enabled: false }, null).advisories[0].price_usdc).toBeNull();
  });

  it("returns only the advisory fields (no payout address, proof, error_class or full workaround)", () => {
    const env = buildEnvelope("inkbox", [m("w", withFix)], DEFAULT_SETTINGS, null);
    expect(Object.keys(env.advisories[0]).sort()).toEqual(
      ["has_workaround", "kind", "label", "note_id", "price_usdc", "reports", "teaser", "tool", "verified", "what"].sort(),
    );
  });
});

describe("buildEnvelope dedupe", () => {
  const base = {
    id: "n1", created_at: "2026-10-17T00:00:00.000Z", kind: "barrier" as const, category: "signup", surface: "inkbox",
    surface_display: "Inkbox", what: "Signup blocks on a 6-digit code.", tool: "signup form", error_class: null,
    tokens_spent: null, dollars_spent: null, workaround: "Ask the human once, then reuse the session.", teaser: "Ask the human once…",
    wish: null, attestation: "unverified" as const, quarantined: true, tier: "experiment" as const, visibility: "public" as const, hidden: false,
  };
  const settings = { filing_enabled: true, unlock_enabled: true, price_micro: 50000, filer_bps: 7000 };
  it("collapses identical reports into one advisory carrying the report count", () => {
    const matches = [1, 2, 3].map((i) => ({ note: { ...base, id: `n${i}` }, reports: 3 }));
    const env = buildEnvelope("inkbox", matches, settings, null);
    expect(env.advisories).toHaveLength(1);
    expect(env.advisories[0].reports).toBe(3);
  });
  it("keeps different issues separate and prefers a verified or workaround-bearing duplicate", () => {
    const matches = [
      { note: { ...base, id: "a", workaround: null, teaser: null }, reports: 2 },
      { note: { ...base, id: "b", attestation: "verified" as const }, reports: 2 },
      { note: { ...base, id: "c", what: "A different problem." }, reports: 1 },
    ];
    const env = buildEnvelope("inkbox", matches, settings, null);
    expect(env.advisories.map((a) => a.note_id)).toEqual(["b", "c"]);
    expect(env.advisories[0].verified).toBe(true);
  });
});

describe("buildEnvelope free mode", () => {
  const fix = { workaround: "Poll every 5s instead of 1s.", teaser: "Poll every 5s" };
  it("carries the full workaround with teaser and price null", () => {
    const env = buildEnvelope("inkbox", [m("a", fix)], DEFAULT_SETTINGS, null, { free: true });
    expect(env.advisories[0]).toMatchObject({ has_workaround: true, workaround: fix.workaround, teaser: null, price_usdc: null });
    expect(env.next).toContain("Workarounds are included above, free.");
    expect(env.next).not.toMatch(/USDC|earn/i);
  });
  it("workaround is null when the note has none; next has no earn language", () => {
    const env = buildEnvelope("inkbox", [m("a")], DEFAULT_SETTINGS, null, { free: true });
    expect(env.advisories[0]).toMatchObject({ has_workaround: false, workaround: null });
    expect(buildEnvelope("inkbox", [], DEFAULT_SETTINGS, null, { free: true }).next).not.toMatch(/earn/i);
  });
  it("still hides workarounds when unlocks are paused", () => {
    const env = buildEnvelope("inkbox", [m("a", fix)], { ...DEFAULT_SETTINGS, unlock_enabled: false }, null, { free: true });
    expect(env.advisories[0].workaround).toBeNull();
  });
  it("paid mode never emits the full workaround", () => {
    const env = buildEnvelope("inkbox", [m("a", fix)], DEFAULT_SETTINGS, null);
    expect("workaround" in env.advisories[0]).toBe(false);
    expect(JSON.stringify(env)).not.toContain(fix.workaround);
  });
});
