// Stream E: the spend cap for operator-started runs (swarm agents + POST /admin/run). Every run spends provider
// credits (Snap, SubQ, Workers AI, the Snap note audit), and prices are partly unknown, so the honest cap is a run
// count: at most `max` runs per sliding hour. A swarm reserves all n of its runs up front (a 100-agent swarm that would
// stall halfway is worse for the demo than a clear 429), and gets back the ones a stop kept from starting.
// In memory only: it resets on restart, like the swarm grid. A leaked admin key can spend at most `max` runs an hour.

export const DEFAULT_RUNS_PER_HOUR = 300;
export const MAX_RUNS_PER_HOUR = 100_000;
export const HOUR_MS = 3_600_000;

export type Take = { ok: true; id: number } | { ok: false; left: number; retry_after_s: number | null };

export interface RunBudget {
  readonly max: number;
  /** Reserve n runs, or say how many are left and when enough frees up (null: n can never fit). */
  take(n: number): Take;
  /** Give back up to n runs of reservation `id` (runs that never started). */
  refund(id: number, n: number): void;
  /** Runs still available in the current window. */
  left(): number;
}

/** Runs-per-hour from env (SWARM_RUNS_PER_HOUR): an integer 0..100000; 0 turns operator runs off. Anything else
 * falls back to the default (a typo must not remove the cap). */
export function runsPerHour(env: NodeJS.ProcessEnv): number {
  const v = env.SWARM_RUNS_PER_HOUR;
  if (typeof v !== "string" || !/^\s*\d+\s*$/.test(v)) return DEFAULT_RUNS_PER_HOUR;
  const n = Number(v);
  return n <= MAX_RUNS_PER_HOUR ? n : DEFAULT_RUNS_PER_HOUR;
}

export function createRunBudget(max: number, windowMs = HOUR_MS, now: () => number = Date.now): RunBudget {
  const cap = Number.isInteger(max) && max >= 0 ? max : DEFAULT_RUNS_PER_HOUR;
  const held: Array<{ id: number; t: number; n: number }> = []; // oldest first
  let nextId = 1;
  const prune = (t: number) => {
    while (held.length && t - held[0].t >= windowMs) held.shift();
  };
  const used = () => held.reduce((s, h) => s + h.n, 0);
  return {
    max: cap,
    take(n) {
      const t = now();
      prune(t);
      const want = Number.isInteger(n) && n > 0 ? n : 1;
      const u = used();
      if (u + want <= cap) {
        const id = nextId++;
        held.push({ id, t, n: want });
        return { ok: true, id };
      }
      if (want > cap) return { ok: false, left: Math.max(0, cap - u), retry_after_s: null };
      // When will enough of the oldest reservations expire?
      let free = cap - u;
      for (const h of held) {
        free += h.n;
        if (free >= want) return { ok: false, left: Math.max(0, cap - u), retry_after_s: Math.max(1, Math.ceil((h.t + windowMs - t) / 1000)) };
      }
      return { ok: false, left: Math.max(0, cap - u), retry_after_s: null };
    },
    refund(id, n) {
      const h = held.find((x) => x.id === id);
      if (!h || !Number.isInteger(n) || n <= 0) return;
      h.n = Math.max(0, h.n - n);
    },
    left() {
      prune(now());
      return Math.max(0, cap - used());
    },
  };
}
