// Shared contracts. Every unit codes against these; change them only on purpose.
export const KINDS = [
  "friction", "worked_well", "wish", "workaround", "cost", "trust", "comparison", "barrier", "missing_data",
] as const;
export type Kind = (typeof KINDS)[number];

/** What an agent sends to notes_file (untrusted). */
export interface NoteInput {
  kind: string;
  category: string;
  surface: string; // public product/service name, e.g. "Inkbox", "GitHub Actions"
  what: string; // <= 240 chars
  tool?: string;
  error?: string;
  tokens_spent?: number;
  dollars_spent?: number;
  workaround?: string;
  wish?: string;
  payout_address?: string; // EVM address; stored apart from the note, never returned
  proof?: string; // identity attestation (Inkbox seam)
}

/** A note that passed the privacy gate. */
export interface CleanNote {
  kind: Kind;
  category: string;
  surface: string; // normalized key: lowercase, single spaces
  surface_display: string; // as the agent wrote it (trimmed)
  what: string;
  tool: string | null;
  error_class: string | null; // error with numbers/ids/quotes stripped, lowercase, <= 120
  tokens_spent: number | null;
  dollars_spent: number | null;
  workaround: string | null;
  teaser: string | null; // first 80 chars of workaround
  wish: string | null;
}

export interface GateProblem { field: string; rule: string; hint: string }
export type GateResult =
  | { ok: true; note: CleanNote; payout_address: string | null }
  | { ok: false; problems: GateProblem[] };

export type Attestation = "verified" | "unverified";

export interface StoredNote extends CleanNote {
  id: string;
  created_at: string;
  attestation: Attestation;
  quarantined: boolean;
  tier: "experiment";
  visibility: "public";
  hidden: boolean;
}

/** A matching note plus how many notes report the same (surface, tool, error_class). */
export interface Match { note: StoredNote; reports: number }

export interface Settings {
  filing_enabled: boolean;
  unlock_enabled: boolean;
  price_micro: number; // micro-USDC (6 decimals); 50000 = $0.05
  filer_bps: number; // filer share in basis points; 7000 = 70%
}
export const DEFAULT_SETTINGS: Settings = { filing_enabled: true, unlock_enabled: true, price_micro: 50000, filer_bps: 7000 };

export interface UnlockRecord {
  note_id: string;
  amount_micro: number;
  filer_micro: number;
  platform_micro: number;
  tx_hash: string;
  network: string;
}

export interface SurfaceScore {
  surface: string;
  surface_display: string;
  n: number;
  by_kind: Partial<Record<Kind, number>>;
  score: number | null; // worked_well / (worked_well + friction + barrier), 0..1; null if denominator 0
  sparse: boolean; // n < 5
}

export interface Stats {
  store: "supabase" | "memory";
  notes: number;
  verified: number;
  unverified: number;
  queries: number;
  unlocks: number;
  filer_earned_micro: number;
  recent: Array<Pick<StoredNote, "id" | "created_at" | "kind" | "surface_display" | "what" | "attestation"> & { has_workaround: boolean }>;
  top_surfaces: Array<{ surface_display: string; n: number }>;
}

export interface Store {
  readonly kind: "supabase" | "memory";
  insertNote(note: CleanNote, meta: { attestation: Attestation; payout_address: string | null }): Promise<StoredNote>;
  getNote(id: string): Promise<StoredNote | null>;
  /** Visible (not hidden) notes matching surface; tool exact if given; error_class by similarity if given. Ranked by reports desc, then newest. */
  findMatches(q: { surface: string; tool?: string | null; error_class?: string | null }, limit: number): Promise<Match[]>;
  logQuery(q: { surface: string; tool: string | null; matched: number }): Promise<void>;
  recordUnlock(u: UnlockRecord): Promise<void>;
  scores(surface?: string): Promise<SurfaceScore[]>;
  stats(): Promise<Stats>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  hideNote(id: string): Promise<void>;
}

/** The free advisory envelope notes_query returns. */
export interface Advisory {
  note_id: string;
  kind: Kind;
  what: string;
  tool: string | null;
  reports: number;
  verified: boolean;
  label: "VERIFIED" | "UNVERIFIED";
  has_workaround: boolean;
  teaser: string | null;
  price_usdc: string | null; // e.g. "0.05" when has_workaround
}
export interface Envelope {
  surface: string;
  advisories: Advisory[];
  score: SurfaceScore | null;
  next: string;
  degraded?: boolean;
}
