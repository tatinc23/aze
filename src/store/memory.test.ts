import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type CleanNote } from "../types.js";
import { MemoryStore, similarity } from "./memory.js";
import { createStore, SupabaseStore } from "./index.js";

const base: CleanNote = {
  kind: "friction", category: "auth", surface: "inkbox", surface_display: "Inkbox", what: "OAuth device flow times out",
  tool: "inbox_create", error_class: "timeout waiting for device code", tokens_spent: 1200, dollars_spent: 0.02,
  workaround: "Poll every 5s instead of 1s; the server rate-limits faster polling.", teaser: "Poll every 5s instead of 1s",
  wish: null,
};
const note = (over: Partial<CleanNote> = {}): CleanNote => ({ ...base, ...over });
const unverified = { attestation: "unverified" as const, payout_address: null };

describe("similarity", () => {
  it("is 1 for identical, 0 for disjoint, symmetric, > 0.3 for near-duplicates", () => {
    expect(similarity("rate limit exceeded", "rate limit exceeded")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
    expect(similarity("", "abc")).toBe(0);
    const a = "timeout waiting for device code", b = "timed out waiting for device code";
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a));
    expect(similarity(a, b)).toBeGreaterThan(0.3);
    expect(similarity(a, "permission denied on bucket")).toBeLessThan(0.3);
  });
  it("matches pg_trgm similarity() exactly (values measured on Postgres 16 pg_trgm)", () => {
    expect(similarity("timeout waiting for device code", "timed out waiting for device code")).toBeCloseTo(0.8333333, 6);
    expect(similarity("rate_limit", "rate limit")).toBe(1);
    expect(similarity("", "")).toBe(0);
  });
  it("ignores case and punctuation", () => {
    expect(similarity("Rate-Limit: EXCEEDED", "rate limit exceeded")).toBe(1);
  });
});

describe("MemoryStore notes", () => {
  it("inserts with defaults and gets by id", async () => {
    const s = new MemoryStore();
    const n = await s.insertNote(note(), { attestation: "verified", payout_address: null });
    expect(n).toMatchObject({ ...base, attestation: "verified", quarantined: true, tier: "experiment", visibility: "public", hidden: false });
    expect(n.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(n.created_at))).toBe(false);
    expect(await s.getNote(n.id)).toEqual(n);
    expect(await s.getNote("nope")).toBeNull();
  });

  it("never returns the payout address from any method", async () => {
    const s = new MemoryStore();
    const addr = "0x1111111111111111111111111111111111111111";
    const n = await s.insertNote(note(), { attestation: "unverified", payout_address: addr });
    await s.recordUnlock({ note_id: n.id, amount_micro: 50000, filer_micro: 35000, platform_micro: 15000, tx_hash: "0xabc", network: "base-sepolia" });
    const outputs = [
      n, await s.getNote(n.id), await s.findMatches({ surface: "inkbox" }, 10), await s.stats(), await s.scores(), await s.getSettings(),
    ];
    expect(JSON.stringify(outputs)).not.toContain(addr);
    expect(JSON.stringify(outputs)).not.toContain("payout");
  });

  it("stores only CleanNote fields: stray keys (payout_address, proof) are dropped, undefined becomes null", async () => {
    const s = new MemoryStore();
    const sneaky = { ...note(), tool: undefined, payout_address: "0x3333333333333333333333333333333333333333", proof: "secret-proof" };
    const n = await s.insertNote(sneaky as unknown as CleanNote, unverified);
    const outputs = [n, await s.getNote(n.id), await s.findMatches({ surface: "inkbox" }, 10)];
    expect(JSON.stringify(outputs)).not.toMatch(/0x3333|secret-proof|payout|proof/);
    expect(n.tool).toBeNull();
    // undefined normalized to null, so it counts as the same report as an explicit null tool
    await s.insertNote(note({ tool: null }), unverified);
    expect((await s.findMatches({ surface: "inkbox" }, 10))[0].reports).toBe(2);
  });

  it("returns copies, so callers cannot mutate stored notes", async () => {
    const s = new MemoryStore();
    const n = await s.insertNote(note(), unverified);
    n.what = "changed";
    (await s.getNote(n.id))!.hidden = true;
    expect(await s.getNote(n.id)).toMatchObject({ what: base.what, hidden: false });
  });

  it("hideNote excludes the note from matches, reports, stats and scores, but getNote still sees it", async () => {
    const s = new MemoryStore();
    const a = await s.insertNote(note(), unverified);
    const b = await s.insertNote(note(), unverified);
    await s.hideNote(a.id);
    await s.hideNote("unknown"); // no-op
    const m = await s.findMatches({ surface: "inkbox" }, 10);
    expect(m.map((x) => x.note.id)).toEqual([b.id]);
    expect(m[0].reports).toBe(1);
    expect((await s.stats()).notes).toBe(1);
    expect((await s.scores())[0].n).toBe(1);
    expect((await s.getNote(a.id))?.hidden).toBe(true);
  });
});

describe("MemoryStore.findMatches", () => {
  it("filters by surface and exact tool", async () => {
    const s = new MemoryStore();
    const a = await s.insertNote(note({ tool: "inbox_create" }), unverified);
    const b = await s.insertNote(note({ tool: "inbox_send" }), unverified);
    await s.insertNote(note({ surface: "stripe", surface_display: "Stripe" }), unverified);
    expect((await s.findMatches({ surface: "inkbox" }, 10)).map((x) => x.note.id).sort()).toEqual([a.id, b.id].sort());
    expect((await s.findMatches({ surface: "inkbox", tool: "inbox_send" }, 10)).map((x) => x.note.id)).toEqual([b.id]);
    expect(await s.findMatches({ surface: "inkbox", tool: "Inbox_Send" }, 10)).toEqual([]);
    expect(await s.findMatches({ surface: "nothing" }, 10)).toEqual([]);
  });

  it("matches error_class by similarity; notes without an error_class always match", async () => {
    const s = new MemoryStore();
    const near = await s.insertNote(note({ error_class: "timeout waiting for device code" }), unverified);
    await s.insertNote(note({ error_class: "permission denied on bucket" }), unverified);
    const none = await s.insertNote(note({ error_class: null }), unverified);
    const ids = (await s.findMatches({ surface: "inkbox", error_class: "timed out waiting for device code" }, 10)).map((x) => x.note.id);
    expect(ids.sort()).toEqual([near.id, none.id].sort());
    expect(await s.findMatches({ surface: "inkbox", error_class: null }, 10)).toHaveLength(3);
  });

  it("counts reports over identical (surface, tool, error_class), nulls equal, and ranks by reports then newest", async () => {
    const s = new MemoryStore();
    const lone = await s.insertNote(note({ error_class: "quota exceeded" }), unverified);
    const t1 = await s.insertNote(note({ tool: null, error_class: null, what: "first" }), unverified);
    const t2 = await s.insertNote(note({ tool: null, error_class: null, what: "second" }), unverified);
    const t3 = await s.insertNote(note({ tool: null, error_class: null, what: "third" }), unverified);
    const p1 = await s.insertNote(note(), unverified);
    const p2 = await s.insertNote(note(), unverified);
    const m = await s.findMatches({ surface: "inkbox" }, 10);
    expect(m.map((x) => [x.note.id, x.reports])).toEqual([
      [t3.id, 3], [t2.id, 3], [t1.id, 3], [p2.id, 2], [p1.id, 2], [lone.id, 1],
    ]);
    expect(await s.findMatches({ surface: "inkbox" }, 2)).toHaveLength(2);
    expect(await s.findMatches({ surface: "inkbox" }, 0)).toEqual([]);
    expect(await s.findMatches({ surface: "inkbox" }, 1.9)).toHaveLength(1);
    expect(await s.findMatches({ surface: "inkbox" }, Number.NaN)).toEqual([]);
  });

  it("breaks report ties by created_at, not insertion order", async () => {
    vi.useFakeTimers();
    try {
      const s = new MemoryStore();
      vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
      const later = await s.insertNote(note({ what: "later" }), unverified);
      vi.setSystemTime(new Date("2026-10-17T11:00:00Z"));
      const earlier = await s.insertNote(note({ error_class: "quota exceeded", what: "earlier" }), unverified);
      expect((await s.findMatches({ surface: "inkbox" }, 10)).map((x) => x.note.id)).toEqual([later.id, earlier.id]);
      expect((await s.stats()).recent.map((r) => r.id)).toEqual([later.id, earlier.id]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MemoryStore ledger and stats", () => {
  it("records unlocks into the ledger and totals stats", async () => {
    const s = new MemoryStore();
    const a = await s.insertNote(note(), { attestation: "verified", payout_address: "0x2222222222222222222222222222222222222222" });
    const b = await s.insertNote(note({ workaround: null, teaser: null, surface: "stripe", surface_display: "Stripe" }), unverified);
    await s.insertNote(note({ surface: "stripe", surface_display: "Stripe" }), unverified);
    await s.logQuery({ surface: "inkbox", tool: null, matched: 1 });
    await s.logQuery({ surface: "stripe", tool: "charge", matched: 0 });
    const u = { note_id: a.id, amount_micro: 50000, filer_micro: 35000, platform_micro: 15000, tx_hash: "0x1", network: "base-sepolia" };
    await s.recordUnlock(u);
    await s.recordUnlock({ ...u, tx_hash: "0x2" });
    await expect(s.recordUnlock({ ...u, note_id: "missing" })).rejects.toThrow(/unknown note/);

    const st = await s.stats();
    expect(st).toMatchObject({ store: "memory", notes: 3, verified: 1, unverified: 2, queries: 2, unlocks: 2, filer_earned_micro: 70000 });
    expect(st.top_surfaces).toEqual([{ surface_display: "Stripe", n: 2 }, { surface_display: "Inkbox", n: 1 }]);
    expect(st.recent).toHaveLength(3);
    expect(st.recent[2]).toEqual({
      id: a.id, created_at: a.created_at, kind: "friction", surface_display: "Inkbox", what: base.what, attestation: "verified", has_workaround: true,
    });
    expect(st.recent.find((r) => r.id === b.id)?.has_workaround).toBe(false);
  });

  it("caps recent at 10 newest and top_surfaces at 5", async () => {
    const s = new MemoryStore();
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j <= i; j++) await s.insertNote(note({ surface: `s${i}`, surface_display: `S${i}`, what: `n${i}.${j}` }), unverified);
    }
    const st = await s.stats();
    expect(st.recent).toHaveLength(10);
    expect(st.recent[0].what).toBe("n6.6");
    expect(st.top_surfaces.map((t) => t.n)).toEqual([7, 6, 5, 4, 3]);
  });

  it("starts empty", async () => {
    expect(await new MemoryStore().stats()).toEqual({
      store: "memory", notes: 0, verified: 0, unverified: 0, queries: 0, unlocks: 0, filer_earned_micro: 0, recent: [], top_surfaces: [],
    });
  });
});

describe("MemoryStore.scores", () => {
  it("computes by_kind, score, sparse, sorted by n desc, and filters by surface", async () => {
    const s = new MemoryStore();
    for (const kind of ["worked_well", "worked_well", "worked_well", "friction", "barrier", "wish"] as const) {
      await s.insertNote(note({ kind }), unverified);
    }
    await s.insertNote(note({ kind: "wish", surface: "stripe", surface_display: "Stripe" }), unverified);
    await s.insertNote(note({ kind: "cost", surface: "stripe", surface_display: "Stripe API" }), unverified);

    const all = await s.scores();
    expect(all).toEqual([
      { surface: "inkbox", surface_display: "Inkbox", n: 6, by_kind: { worked_well: 3, friction: 1, barrier: 1, wish: 1 }, score: 0.6, sparse: false },
      { surface: "stripe", surface_display: "Stripe API", n: 2, by_kind: { wish: 1, cost: 1 }, score: null, sparse: true },
    ]);
    expect(await s.scores("stripe")).toEqual([all[1]]);
    expect(await s.scores("nothing")).toEqual([]);
  });

  it("scores 0 when only friction/barrier", async () => {
    const s = new MemoryStore();
    await s.insertNote(note({ kind: "barrier" }), unverified);
    expect((await s.scores())[0]).toMatchObject({ score: 0, sparse: true, n: 1 });
  });
});

describe("MemoryStore settings", () => {
  it("defaults, patches known keys, ignores undefined and unknown keys", async () => {
    const s = new MemoryStore();
    expect(await s.getSettings()).toEqual(DEFAULT_SETTINGS);
    const next = await s.setSettings({ price_micro: 100000, filing_enabled: false, filer_bps: undefined, bogus: 1 } as never);
    expect(next).toEqual({ ...DEFAULT_SETTINGS, price_micro: 100000, filing_enabled: false });
    expect(await s.getSettings()).toEqual(next);
    next.unlock_enabled = false;
    expect((await s.getSettings()).unlock_enabled).toBe(true);
  });
});

describe("createStore", () => {
  it("uses memory without Supabase env, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createStore({}).kind).toBe("memory");
    expect(createStore({ SUPABASE_URL: "https://x.supabase.co" }).kind).toBe("memory");
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
  it("uses Supabase when both vars are set (no network at construction)", () => {
    const s = createStore({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" });
    expect(s).toBeInstanceOf(SupabaseStore);
    expect(s.kind).toBe("supabase");
  });
});
