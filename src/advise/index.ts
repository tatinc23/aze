import type { Advisory, Envelope, Match, Settings, SurfaceScore } from "../types.js";

const MAX_ADVISORIES = 5;

/** Micro-USDC (6 decimals) to a decimal string: 50000 -> "0.05", 1234567 -> "1.234567". Keeps at least 2 decimals. */
export function formatUsdc(micro: number): string {
  if (!Number.isInteger(micro) || micro < 0) throw new Error(`formatUsdc: bad amount ${micro}`);
  const whole = Math.floor(micro / 1_000_000);
  let frac = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
}

/** Build the free advisory envelope notes_query returns. Matches arrive ranked by the store; order is kept. */
export function buildEnvelope(surface: string, matches: Match[], settings: Settings, score: SurfaceScore | null): Envelope {
  // Lazy: a bad price setting must not break the free envelope when nothing is for sale.
  let price: string | undefined;
  const priceUsdc = () => (price ??= formatUsdc(settings.price_micro));
  const advisories: Advisory[] = matches.slice(0, MAX_ADVISORIES).map(({ note, reports }) => {
    const verified = note.attestation === "verified";
    const has_workaround = note.workaround != null;
    return {
      note_id: note.id,
      kind: note.kind,
      what: note.what,
      tool: note.tool,
      reports,
      verified,
      label: verified ? "VERIFIED" : "UNVERIFIED",
      has_workaround,
      teaser: has_workaround ? safeTeaser(note.workaround as string, note.teaser) : null,
      price_usdc: has_workaround && settings.unlock_enabled ? priceUsdc() : null,
    };
  });
  return { surface, advisories, score, next: nextStep(advisories, settings, priceUsdc) };
}

/**
 * The gate's teaser is the whole workaround when it is 80 chars or shorter, which would give the paid
 * content away free. If the teaser reveals the whole workaround, show only its first half.
 */
function safeTeaser(workaround: string, teaser: string | null): string | null {
  if (teaser == null) return null;
  const full = workaround.trim();
  const shown = teaser.endsWith("…") ? teaser.slice(0, -1) : teaser;
  if (teaser.trim() !== full && shown.trim().length < full.length) return teaser;
  const half = full.slice(0, Math.floor(full.length / 2)).trimEnd();
  return half ? half + "…" : null;
}

function nextStep(advisories: Advisory[], settings: Settings, price: () => string): string {
  if (advisories.length === 0) {
    return "No known issues for this surface yet. If you hit one, call notes_file; you earn a cut when others unlock your workaround.";
  }
  if (settings.unlock_enabled && advisories.some((a) => a.has_workaround)) {
    const pct = settings.filer_bps / 100;
    return `Call notes_unlock with note_id to get the full workaround (${price()} test USDC; ${pct}% goes to the agent who filed it).`;
  }
  return "No paid workaround yet. If you solve it, call notes_file with kind 'workaround' and earn a cut of every unlock.";
}
