import { describe, expect, it, vi } from "vitest";
import type { CleanNote } from "../types.js";
import { SupabaseStore } from "./supabase.js";

// A tiny stand-in for the supabase-js query builder: records calls, returns queued results.
function fakeDb(results: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const next = (key: string) => {
    const r = results[key]?.shift() ?? {};
    return { data: r.data ?? null, error: r.error ?? null };
  };
  const builder = (table: string) => {
    let op = "";
    const b: any = {
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(next(`${table}.${op}`)).then(ok, bad),
    };
    for (const m of ["insert", "select", "delete", "update", "upsert", "eq", "order", "limit", "single", "maybeSingle"]) {
      b[m] = (...args: unknown[]) => {
        calls.push({ op: `${table}.${m}`, args });
        if (!op && ["insert", "select", "delete", "update", "upsert"].includes(m)) op = m;
        return b;
      };
    }
    return b;
  };
  const db = {
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: unknown) => {
      calls.push({ op: `rpc.${fn}`, args: [args] });
      return next(`rpc.${fn}`);
    },
  };
  return { db, calls };
}

const store = (results: Parameters<typeof fakeDb>[0]) => {
  const s = new SupabaseStore("https://x.supabase.co", "service-key");
  const f = fakeDb(results);
  (s as unknown as { db: unknown }).db = f.db;
  return { s, calls: f.calls };
};

const ID = "0b9d7c2e-1f7a-4c1e-9a7b-2a3c4d5e6f70";
const clean: CleanNote = {
  kind: "friction", category: "auth", surface: "inkbox", surface_display: "Inkbox", what: "w", tool: null,
  error_class: null, tokens_spent: null, dollars_spent: null, workaround: "wa", teaser: "wa", wish: null,
};
// A post-0003 row: notes.audit exists (null when the note was filed without a Snap audit).
const row = { ...clean, id: ID, created_at: "2026-10-17T18:37:55.81049+00:00", attestation: "unverified", quarantined: true, tier: "experiment", visibility: "public", hidden: false, audit: null };
const audit = { status: "ok", p_private: 0.02, p_real_issue: 0.9, category: "auth", severity: 2, model: "subq-snap-preview", ms: 380, reason: null } as const;

describe("SupabaseStore (fake client)", () => {
  it("inserts only CleanNote fields into notes and the payout into note_payouts", async () => {
    const { s, calls } = store({ "notes.insert": [{ data: { ...row, extra_column: "x" } }], "note_payouts.insert": [{}] });
    const sneaky = { ...clean, payout_address: "0x4444444444444444444444444444444444444444", proof: "p" } as CleanNote;
    const n = await s.insertNote(sneaky, { attestation: "unverified", payout_address: "0x4444444444444444444444444444444444444444" });
    const noteInsert = calls.find((c) => c.op === "notes.insert")!.args[0] as Record<string, unknown>;
    expect(Object.keys(noteInsert).sort()).toEqual([...Object.keys(clean), "attestation"].sort());
    expect(calls.find((c) => c.op === "note_payouts.insert")!.args[0]).toEqual({ note_id: ID, payout_address: "0x4444444444444444444444444444444444444444" });
    expect(Object.keys(n).sort()).toEqual(Object.keys(row).sort()); // no extra_column, no payout
    expect(n.created_at).toBe("2026-10-17T18:37:55.810Z");
  });

  it("deletes the note and throws when the payout insert fails", async () => {
    const { s, calls } = store({ "notes.insert": [{ data: row }], "note_payouts.insert": [{ error: { message: "boom" } }], "notes.delete": [{}] });
    await expect(s.insertNote(clean, { attestation: "unverified", payout_address: "0x4444444444444444444444444444444444444444" })).rejects.toThrow(/insert payout/);
    expect(calls.some((c) => c.op === "notes.eq" && c.args[1] === ID)).toBe(true);
    expect(calls.some((c) => c.op === "notes.delete")).toBe(true);
  });

  it("skips the database for non-UUID ids", async () => {
    const { s, calls } = store({});
    expect(await s.getNote("../admin")).toBeNull();
    await s.hideNote("nope");
    expect(calls).toEqual([]);
  });

  it("maps find_matches rows and clamps the limit", async () => {
    const { s, calls } = store({ "rpc.find_matches": [{ data: [{ note: row, reports: 3 }] }] });
    const m = await s.findMatches({ surface: "inkbox" }, 2.7);
    expect(calls[0]).toEqual({ op: "rpc.find_matches", args: [{ p_surface: "inkbox", p_tool: null, p_error_class: null, p_limit: 2 }] });
    expect(m).toEqual([{ note: { ...row, created_at: "2026-10-17T18:37:55.810Z" }, reports: 3 }]);
  });

  it("surfaces Postgres errors from record_unlock", async () => {
    const { s } = store({ "rpc.record_unlock": [{ error: { message: "violates foreign key" } }] });
    await expect(s.recordUnlock({ note_id: ID, amount_micro: 1, filer_micro: 1, platform_micro: 0, tx_hash: "0x", network: "n" })).rejects.toThrow(/record_unlock/);
  });

  it("writes the audit into notes.audit on insert and maps it back", async () => {
    const { s, calls } = store({ "notes.insert": [{ data: { ...row, audit } }] });
    const n = await s.insertNote(clean, { attestation: "unverified", payout_address: null, audit: { ...audit, extra: "x" } as typeof audit });
    const noteInsert = calls.find((c) => c.op === "notes.insert")!.args[0] as Record<string, unknown>;
    expect(noteInsert.audit).toEqual(audit); // exactly the NoteAudit fields
    expect(Object.keys(noteInsert).sort()).toEqual([...Object.keys(clean), "attestation", "audit"].sort());
    expect(n.audit).toEqual(audit);
  });

  it("does not send the audit column when there is no audit (works before migration 0003)", async () => {
    const { s, calls } = store({ "notes.insert": [{ data: row }] });
    await s.insertNote(clean, { attestation: "unverified", payout_address: null, audit: null });
    expect("audit" in (calls.find((c) => c.op === "notes.insert")!.args[0] as object)).toBe(false);
  });

  it("retries without the audit when notes.audit does not exist yet, and still saves the note", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { s, calls } = store({
      "notes.insert": [{ error: { message: "Could not find the 'audit' column of 'notes' in the schema cache" } }, { data: row }],
    });
    const n = await s.insertNote(clean, { attestation: "unverified", payout_address: null, audit });
    const inserts = calls.filter((c) => c.op === "notes.insert").map((c) => c.args[0] as Record<string, unknown>);
    expect(inserts).toHaveLength(2);
    expect("audit" in inserts[1]).toBe(false);
    expect(n.id).toBe(ID);
    expect(n.audit).toBeNull();
    warn.mockRestore();
  });

  it("does not retry other insert errors", async () => {
    const { s, calls } = store({ "notes.insert": [{ error: { message: "permission denied for table notes" } }] });
    await expect(s.insertNote(clean, { attestation: "unverified", payout_address: null, audit })).rejects.toThrow(/insert note/);
    expect(calls.filter((c) => c.op === "notes.insert")).toHaveLength(1);
  });

  it("maps audit from getNote and find_matches rows; absent or malformed -> null", async () => {
    const { audit: _none, ...preMigration } = row; // a row from before migration 0003 has no audit key
    const { s } = store({
      "notes.select": [{ data: { ...row, audit } }, { data: preMigration }],
      "rpc.find_matches": [{ data: [{ note: { ...row, audit: JSON.stringify(audit) }, reports: 1 }, { note: { ...row, audit: { bogus: 1 } }, reports: 1 }] }],
    });
    expect((await s.getNote(ID))!.audit).toEqual(audit);
    expect((await s.getNote(ID))!.audit).toBeNull();
    const m = await s.findMatches({ surface: "inkbox" }, 5);
    expect(m.map((x) => x.note.audit)).toEqual([audit, null]);
  });
});
