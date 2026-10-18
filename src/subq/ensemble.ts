// Two System One models vote on routing: SubQ Snap and Workers AI (src/llm/workers-ai-systemone.ts) each answer the
// same yes/no question per asset, in parallel, and the probabilities are averaged per asset. If one model fails or
// times out the other still routes; only when every voter fails does routing fail (the pipeline then falls back).
// Only priced voters' tokens are billed (Snap); Workers AI tokens stay unpriced rather than billed at Snap's rate.
import type { Asset, Router, Usage } from "../runtime/types.js";

export interface Voter {
  label: string;
  router: Router;
  /** Bill this voter's tokens on the snap tier. */
  priced: boolean;
}

const ZERO: Usage = { input_tokens: 0, output_tokens: 0 };
const add = (a: Usage, b: Usage | undefined): Usage =>
  b ? { input_tokens: a.input_tokens + (b.input_tokens || 0), output_tokens: a.output_tokens + (b.output_tokens || 0) } : a;
const short = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 80);

/** One voter: its own router, unchanged. Several: a blended router. None: null. */
export function createEnsembleRouter(voters: Voter[]): Router | null {
  if (voters.length === 0) return null;
  if (voters.length === 1) return voters[0].router;
  return {
    async route(task: string, assets: Asset[]) {
      const t0 = Date.now();
      const settled = await Promise.allSettled(voters.map((v) => v.router.route(task, assets)));
      const sum = new Map<string, { p: number; n: number }>();
      const order: string[] = [];
      let usage: Usage = { ...ZERO };
      const parts: string[] = [];
      settled.forEach((r, i) => {
        const v = voters[i];
        if (r.status === "rejected") {
          const u = (r.reason as { usage?: Usage })?.usage;
          if (v.priced) usage = add(usage, u);
          parts.push(`${v.label} failed (${short(r.reason)})`);
          return;
        }
        if (v.priced) usage = add(usage, r.value.usage);
        const top = r.value.choices.slice().sort((a, b) => b.p - a.p)[0];
        parts.push(`${v.label}${top ? ` ${top.asset_id} p=${top.p.toFixed(2)}` : " no pick"}`);
        for (const c of r.value.choices) {
          if (!Number.isFinite(c.p)) continue;
          const s = sum.get(c.asset_id);
          if (s) { s.p += c.p; s.n += 1; } else { sum.set(c.asset_id, { p: c.p, n: 1 }); order.push(c.asset_id); }
        }
      });
      const ok = settled.filter((r) => r.status === "fulfilled").length;
      if (ok === 0) {
        const first = (settled[0] as PromiseRejectedResult).reason;
        const err = first instanceof Error ? first : new Error(String(first));
        (err as Error & { usage?: Usage }).usage = usage;
        err.message = `every System One model failed: ${parts.join("; ")}`;
        throw err;
      }
      // Average over the voters that answered; an asset only one model scored keeps that model's p.
      const choices = order.map((id) => ({ asset_id: id, p: sum.get(id)!.p / sum.get(id)!.n })).sort((a, b) => b.p - a.p);
      return { choices, ms: Date.now() - t0, usage, detail: `System One votes: ${parts.join(", ")}` };
    },
  };
}
