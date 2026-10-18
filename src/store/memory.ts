import { randomUUID } from "node:crypto";
import {
  DEFAULT_SETTINGS,
  type Attestation, type CleanNote, type Kind, type Match, type NoteAudit, type Settings, type Stats, type Store, type StoredNote,
  type SurfaceScore, type UnlockRecord,
} from "../types.js";

/** pg_trgm-style trigrams: lowercase alphanumeric words, each padded "  word ". */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** Trigram Jaccard similarity, same idea as pg_trgm similarity(). */
export function similarity(a: string, b: string): number {
  const ta = trigrams(a), tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export const SIMILARITY_THRESHOLD = 0.3;

/** Exactly the CleanNote fields (undefined -> null), so stray input keys (payout_address, proof, ...) are never stored. */
export function pickNote(n: CleanNote): CleanNote {
  return {
    kind: n.kind, category: n.category, surface: n.surface, surface_display: n.surface_display, what: n.what,
    tool: n.tool ?? null, error_class: n.error_class ?? null, tokens_spent: n.tokens_spent ?? null,
    dollars_spent: n.dollars_spent ?? null, workaround: n.workaround ?? null, teaser: n.teaser ?? null, wish: n.wish ?? null,
  };
}

const AUDIT_STATUS = new Set(["ok", "rejected", "skipped"]);
const auditNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const auditStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Exactly the NoteAudit fields, or null when absent/malformed (accepts the jsonb column's object or its JSON text). */
export function pickAudit(a: unknown): NoteAudit | null {
  if (typeof a === "string") {
    try { a = JSON.parse(a); } catch { return null; }
  }
  if (typeof a !== "object" || a === null || Array.isArray(a)) return null;
  const r = a as Record<string, unknown>;
  if (typeof r.status !== "string" || !AUDIT_STATUS.has(r.status)) return null;
  return {
    status: r.status as NoteAudit["status"], p_private: auditNum(r.p_private), p_real_issue: auditNum(r.p_real_issue),
    category: auditStr(r.category), severity: auditNum(r.severity), model: auditStr(r.model), ms: auditNum(r.ms) ?? 0,
    reason: auditStr(r.reason),
  };
}

/** Row limit as a non-negative integer (NaN -> 0), same in both stores. */
export const clampLimit = (limit: number): number => Math.max(0, Math.floor(limit) || 0);

/** Fold per-(surface, kind) counts into SurfaceScores, sorted by n desc. */
export function surfaceScores(rows: Array<{ surface: string; surface_display: string; kind: Kind; n: number }>): SurfaceScore[] {
  const by = new Map<string, SurfaceScore>();
  for (const r of rows) {
    const s = by.get(r.surface) ?? { surface: r.surface, surface_display: r.surface_display, n: 0, by_kind: {}, score: null, sparse: true };
    s.n += r.n;
    s.by_kind[r.kind] = (s.by_kind[r.kind] ?? 0) + r.n;
    by.set(r.surface, s);
  }
  for (const s of by.values()) {
    const good = s.by_kind.worked_well ?? 0;
    const denom = good + (s.by_kind.friction ?? 0) + (s.by_kind.barrier ?? 0);
    s.score = denom === 0 ? null : good / denom;
    s.sparse = s.n < 5;
  }
  return [...by.values()].sort((a, b) => b.n - a.n || a.surface.localeCompare(b.surface));
}

interface Unlock extends UnlockRecord { id: number; at: string }
interface LedgerRow { unlock_id: number; note_id: string; party: "filer" | "platform"; amount_micro: number }

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private notes: StoredNote[] = []; // insertion order
  private payouts = new Map<string, string>(); // never returned
  private queries: Array<{ at: string; surface: string; tool: string | null; matched: number }> = [];
  private unlocks: Unlock[] = [];
  private ledger: LedgerRow[] = [];
  private settings: Settings = { ...DEFAULT_SETTINGS };

  private visible(): StoredNote[] {
    return this.notes.filter((n) => !n.hidden);
  }

  /** Newest first; insertion order breaks same-millisecond ties. */
  private newestFirst(notes: StoredNote[]): StoredNote[] {
    const order = new Map(this.notes.map((n, i) => [n.id, i]));
    return [...notes].sort((a, b) => b.created_at.localeCompare(a.created_at) || order.get(b.id)! - order.get(a.id)!);
  }

  async insertNote(note: CleanNote, meta: { attestation: Attestation; payout_address: string | null; audit?: NoteAudit | null }): Promise<StoredNote> {
    const stored: StoredNote = {
      ...pickNote(note),
      id: randomUUID(),
      created_at: new Date().toISOString(),
      attestation: meta.attestation,
      quarantined: true,
      tier: "experiment",
      visibility: "public",
      hidden: false,
      audit: pickAudit(meta.audit),
    };
    this.notes.push(stored);
    if (meta.payout_address) this.payouts.set(stored.id, meta.payout_address);
    return structuredClone(stored);
  }

  async getNote(id: string): Promise<StoredNote | null> {
    const n = this.notes.find((x) => x.id === id);
    return n ? structuredClone(n) : null;
  }

  async findMatches(q: { surface: string; tool?: string | null; error_class?: string | null }, limit: number): Promise<Match[]> {
    const tool = q.tool ?? null, err = q.error_class ?? null;
    const visible = this.visible();
    const reports = (n: StoredNote) =>
      visible.filter((m) => m.surface === n.surface && m.tool === n.tool && m.error_class === n.error_class).length;
    const hits = visible.filter((n) =>
      n.surface === q.surface &&
      (tool === null || n.tool === tool) &&
      (err === null || n.error_class === null || similarity(n.error_class, err) > SIMILARITY_THRESHOLD));
    const ranked = this.newestFirst(hits)
      .map((n) => ({ note: structuredClone(n), reports: reports(n) }))
      .sort((a, b) => b.reports - a.reports); // stable: keeps newest-first within equal reports
    return ranked.slice(0, clampLimit(limit));
  }

  async logQuery(q: { surface: string; tool: string | null; matched: number }): Promise<void> {
    this.queries.push({ at: new Date().toISOString(), ...q });
  }

  async recordUnlock(u: UnlockRecord): Promise<void> {
    if (!this.notes.some((n) => n.id === u.note_id)) throw new Error(`recordUnlock: unknown note ${u.note_id}`);
    const id = this.unlocks.length + 1;
    this.unlocks.push({ ...u, id, at: new Date().toISOString() });
    this.ledger.push(
      { unlock_id: id, note_id: u.note_id, party: "filer", amount_micro: u.filer_micro },
      { unlock_id: id, note_id: u.note_id, party: "platform", amount_micro: u.platform_micro },
    );
  }

  private kindCounts(surface?: string) {
    const rows = new Map<string, { surface: string; surface_display: string; kind: Kind; n: number }>();
    const display = new Map<string, string>();
    for (const n of this.newestFirst(this.visible())) {
      if (surface !== undefined && n.surface !== surface) continue;
      if (!display.has(n.surface)) display.set(n.surface, n.surface_display);
      const key = `${n.surface}\u0000${n.kind}`;
      const r = rows.get(key) ?? { surface: n.surface, surface_display: display.get(n.surface)!, kind: n.kind, n: 0 };
      r.n++;
      rows.set(key, r);
    }
    return [...rows.values()];
  }

  async scores(surface?: string): Promise<SurfaceScore[]> {
    return surfaceScores(this.kindCounts(surface));
  }

  async stats(): Promise<Stats> {
    const visible = this.visible();
    return {
      store: "memory",
      notes: visible.length,
      verified: visible.filter((n) => n.attestation === "verified").length,
      unverified: visible.filter((n) => n.attestation === "unverified").length,
      queries: this.queries.length,
      unlocks: this.unlocks.length,
      filer_earned_micro: this.ledger.filter((l) => l.party === "filer").reduce((s, l) => s + l.amount_micro, 0),
      recent: this.newestFirst(visible).slice(0, 10).map((n) => ({
        id: n.id, created_at: n.created_at, kind: n.kind, surface_display: n.surface_display, what: n.what,
        attestation: n.attestation, has_workaround: n.workaround !== null,
      })),
      top_surfaces: surfaceScores(this.kindCounts()).slice(0, 5).map((s) => ({ surface_display: s.surface_display, n: s.n })),
    };
  }

  async getSettings(): Promise<Settings> {
    return { ...this.settings };
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    for (const k of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
      if (patch[k] !== undefined) (this.settings as Record<keyof Settings, unknown>)[k] = patch[k];
    }
    return { ...this.settings };
  }

  async hideNote(id: string): Promise<void> {
    const n = this.notes.find((x) => x.id === id);
    if (n) n.hidden = true;
  }
}
