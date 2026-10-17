import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SETTINGS,
  type Attestation, type CleanNote, type Kind, type Match, type Settings, type Stats, type Store, type StoredNote,
  type SurfaceScore, type UnlockRecord,
} from "../types.js";
import { surfaceScores } from "./memory.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Pick exactly the StoredNote fields from a notes row (or its to_jsonb form). */
function toNote(r: Row): StoredNote {
  return {
    id: String(r.id),
    created_at: new Date(String(r.created_at)).toISOString(),
    kind: r.kind as Kind,
    category: String(r.category),
    surface: String(r.surface),
    surface_display: String(r.surface_display),
    what: String(r.what),
    tool: str(r.tool),
    error_class: str(r.error_class),
    tokens_spent: num(r.tokens_spent),
    dollars_spent: num(r.dollars_spent),
    workaround: str(r.workaround),
    teaser: str(r.teaser),
    wish: str(r.wish),
    attestation: r.attestation as Attestation,
    quarantined: Boolean(r.quarantined),
    tier: "experiment",
    visibility: "public",
    hidden: Boolean(r.hidden),
  };
}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`supabase ${what}: ${res.error.message}`);
  return res.data;
}

export class SupabaseStore implements Store {
  readonly kind = "supabase" as const;
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  async insertNote(note: CleanNote, meta: { attestation: Attestation; payout_address: string | null }): Promise<StoredNote> {
    const row = check(
      await this.db.from("notes").insert({ ...note, attestation: meta.attestation }).select("*").single(),
      "insert note",
    ) as Row;
    const stored = toNote(row);
    if (meta.payout_address) {
      const res = await this.db.from("note_payouts").insert({ note_id: stored.id, payout_address: meta.payout_address });
      if (res.error) {
        await this.db.from("notes").delete().eq("id", stored.id); // keep insert all-or-nothing
        throw new Error(`supabase insert payout: ${res.error.message}`);
      }
    }
    return stored;
  }

  async getNote(id: string): Promise<StoredNote | null> {
    if (!UUID.test(id)) return null;
    const row = check(await this.db.from("notes").select("*").eq("id", id).maybeSingle(), "get note") as Row | null;
    return row ? toNote(row) : null;
  }

  async findMatches(q: { surface: string; tool?: string | null; error_class?: string | null }, limit: number): Promise<Match[]> {
    const rows = check(
      await this.db.rpc("find_matches", {
        p_surface: q.surface, p_tool: q.tool ?? null, p_error_class: q.error_class ?? null, p_limit: Math.max(0, limit),
      }),
      "find_matches",
    ) as Array<{ note: Row; reports: number }> | null;
    return (rows ?? []).map((r) => ({ note: toNote(r.note), reports: Number(r.reports) }));
  }

  async logQuery(q: { surface: string; tool: string | null; matched: number }): Promise<void> {
    check(await this.db.from("queries").insert(q), "log query");
  }

  async recordUnlock(u: UnlockRecord): Promise<void> {
    check(
      await this.db.rpc("record_unlock", {
        p_note_id: u.note_id, p_amount: u.amount_micro, p_filer: u.filer_micro, p_platform: u.platform_micro,
        p_tx: u.tx_hash, p_network: u.network,
      }),
      "record_unlock",
    );
  }

  private async kindCounts(surface?: string) {
    const rows = check(await this.db.rpc("surface_kind_counts", { p_surface: surface ?? null }), "surface_kind_counts") as
      Array<{ surface: string; surface_display: string; kind: Kind; n: number }> | null;
    return (rows ?? []).map((r) => ({ ...r, n: Number(r.n) }));
  }

  async scores(surface?: string): Promise<SurfaceScore[]> {
    return surfaceScores(await this.kindCounts(surface));
  }

  async stats(): Promise<Stats> {
    const [totals, recent, counts] = await Promise.all([
      this.db.rpc("store_stats"),
      this.db.from("notes")
        .select("id, created_at, kind, surface_display, what, attestation, workaround")
        .eq("hidden", false).order("created_at", { ascending: false }).limit(10),
      this.kindCounts(),
    ]);
    const t = check(totals, "store_stats") as Record<string, unknown>;
    const r = (check(recent, "recent notes") ?? []) as Row[];
    return {
      store: "supabase",
      notes: Number(t.notes),
      verified: Number(t.verified),
      unverified: Number(t.unverified),
      queries: Number(t.queries),
      unlocks: Number(t.unlocks),
      filer_earned_micro: Number(t.filer_earned_micro),
      recent: r.map((n) => ({
        id: String(n.id), created_at: new Date(String(n.created_at)).toISOString(), kind: n.kind as Kind,
        surface_display: String(n.surface_display), what: String(n.what), attestation: n.attestation as Attestation,
        has_workaround: n.workaround !== null && n.workaround !== undefined,
      })),
      top_surfaces: surfaceScores(counts).slice(0, 5).map((s) => ({ surface_display: s.surface_display, n: s.n })),
    };
  }

  async getSettings(): Promise<Settings> {
    const rows = (check(await this.db.from("settings").select("key, value"), "get settings") ?? []) as Array<{ key: string; value: unknown }>;
    const out: Settings = { ...DEFAULT_SETTINGS };
    for (const { key, value } of rows) {
      if (key in DEFAULT_SETTINGS) (out as Record<keyof Settings, unknown>)[key as keyof Settings] = value;
    }
    return out;
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    const rows = (Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>)
      .filter((k) => patch[k] !== undefined)
      .map((k) => ({ key: k, value: patch[k] }));
    if (rows.length) check(await this.db.from("settings").upsert(rows, { onConflict: "key" }), "set settings");
    return this.getSettings();
  }

  async hideNote(id: string): Promise<void> {
    if (!UUID.test(id)) return;
    check(await this.db.from("notes").update({ hidden: true }).eq("id", id), "hide note");
  }
}
