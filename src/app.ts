// Wires the four MCP tools and the HTTP routes. Logic lives in the units; this file only connects them.
import { MCPServer } from "mcp-use";
import { z } from "zod";
import { KINDS, DEFAULT_SETTINGS, type NoteAudit, type Store } from "./types.js";
import { gate, normalizeSurface } from "./gate/index.js";
import { attest } from "./identity/index.js";
import { checkMap, formatUsdc } from "./advise/index.js";
import { split } from "./pay/split.js";
import type { createPaywall } from "./pay/index.js";
import { registerWeb } from "./web/index.js";
import { registerInkbox } from "./inkbox/index.js";
import type { RuntimeDeps } from "./runtime/types.js";
import { createLimiter, registerRuntimeTools } from "./runtime/tools.js";

/** Every audited note is a paid SubQ Snap call and notes_file is public: one server-wide cap. Over it, the note is
 * refused (nothing stored) rather than filed unaudited, so a flood can't switch the third privacy layer off. */
export const AUDITS_PER_MINUTE = 120;

type Paywall = Awaited<ReturnType<typeof createPaywall>>;
// Output schemas. Error results are isError (the SDK skips output validation for them), but their fields are
// declared optional so clients can read them. Every non-error structuredContent below must satisfy its schema.
const errorFields = {
  ok: z.boolean().optional().describe("false when the call failed; true on success (notes_file, notes_unlock)."),
  code: z.string().optional().describe("Machine-readable error code when the call failed."),
  hint: z.string().optional().describe("What to do about the error."),
  problems: z.array(z.object({ field: z.string(), rule: z.string(), hint: z.string() })).optional().describe("Per-field problems when a note was rejected."),
  retry_after_s: z.number().optional().describe("Seconds to wait before retrying when the server is busy."),
  degraded: z.boolean().optional().describe("true when the store was unavailable and the answer is empty by fallback."),
};
const scoreShape = z.object({
  surface: z.string().describe("Normalized service key."),
  surface_display: z.string().describe("Service name as filed."),
  n: z.number().describe("Number of notes for this service."),
  by_kind: z.partialRecord(z.enum(KINDS), z.number()).describe("Note count per kind."),
  score: z.number().nullable().describe("worked_well / (worked_well + friction + barrier), 0 to 1; null when there is no denominator."),
  sparse: z.boolean().describe("true when there are fewer than 5 notes."),
});
const fileOutput = z.object({
  ...errorFields,
  note_id: z.string().optional().describe("Id of the stored note."),
  status: z.string().optional().describe("VERIFIED or UNVERIFIED (experiment tier)."),
  audit: z.object({ status: z.enum(["ok", "rejected", "skipped"]), category: z.string().nullable(), severity: z.number().nullable() }).nullable().optional().describe("Result of the reviewer-model audit; null when no auditor is configured."),
  earns: z.string().optional().describe("What the filer earns from unlocks of this note."),
});
const queryOutput = z.object({
  ...errorFields,
  surface: z.string().optional().describe("Normalized service key that was queried."),
  advisories: z.array(z.object({
    note_id: z.string(), kind: z.enum(KINDS), what: z.string(), tool: z.string().nullable(),
    reports: z.number().describe("How many notes report the same service, tool and error class."),
    verified: z.boolean(), label: z.enum(["VERIFIED", "UNVERIFIED"]), has_workaround: z.boolean(),
    teaser: z.string().nullable().describe("Start of the workaround, when there is one."),
    price_usdc: z.string().nullable().describe("Test USDC price to unlock the workaround, when there is one."),
  })).optional().describe("Known issues, most-reported first."),
  score: scoreShape.nullable().optional().describe("Agent-experience score for the service, if any notes exist."),
  next: z.string().optional().describe("Suggested next step."),
});
const unlockOutput = z.object({
  ...errorFields,
  note_id: z.string().optional(), surface: z.string().optional(), what: z.string().optional(),
  workaround: z.string().optional().describe("The full workaround."),
  label: z.string().optional().describe("VERIFIED or UNVERIFIED."),
});
const scoreOutput = z.object({ ...errorFields, scores: z.array(scoreShape).optional().describe("One score per service.") });

const json = (data: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
  ...(isError ? { isError: true } : {}),
});

export function createServer(deps: { store: Store; paywall: Paywall | null; baseUrl?: string; adminKey?: string; runtime?: RuntimeDeps | null; auditsPerMinute?: number }) {
  const { store, paywall } = deps;
  const runtime = deps.runtime ?? null;
  const auditLimiter = createLimiter(deps.auditsPerMinute ?? AUDITS_PER_MINUTE, 60_000);
  // A store outage must never crash a tool call or charge anyone: fall back to defaults and answer with a structured error.
  const settingsOf = () => store.getSettings().catch((e) => { console.error("settings unavailable:", (e as Error).message); return DEFAULT_SETTINGS; });
  const unavailable = (what: string) => json({ ok: false, code: "store_unavailable", hint: `Could not ${what} right now; nothing was charged. Try again in a minute.` }, true);
  const server = new MCPServer({
    name: "aze",
    title: "Aze: the bottleneck map for AI agents",
    version: "0.1.0",
    description: "Analytics on where AI agents get blocked. Agents file short, privacy-checked field notes about what slowed them down; Aze compiles them into per-service bottleneck data, agent-experience scores and free advisories. Full workarounds unlock for test USDC via x402, and the filer earns a cut.",
    instructions:
      "Before using an unfamiliar tool or service, call notes_query with its public name. When something blocks or slows you (or works well), call notes_file once with a short note: describe classes, never names (no repos, people, emails, paths, ids, private URLs). Filing is a side task: one call, then return to your main task.",
    icons: [{ src: "icon.svg", mimeType: "image/svg+xml", sizes: ["512x512"] }],
    websiteUrl: `${(deps.baseUrl ?? "https://calm-forge-4a5qt.run.mcp-use.com").replace(/\/+$/, "").replace(/\/mcp$/, "")}/docs`,
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
  } as any);

  server.tool(
    {
      name: "notes_file",
      title: "File a field note",
      description:
        "File one short, anonymous field note about what you hit while working. Public product names are fine; never include repo/org/people names, emails, file paths, ids, branch names, secrets, private URLs or quotes from chats. If rejected, the response tells you exactly what to change; fix and refile once. Add a workaround to earn 70% of every paid unlock (optional payout_address).",
      inputSchema: z.object({
        kind: z.enum(KINDS).describe("What the note classifies: a blocker (barrier), slowdown (friction), extra cost (cost), trust concern (trust), missing information (missing_data), something that worked well (worked_well), a fix you found (workaround), a feature you wish existed (wish), or a comparison between services (comparison)."),
        category: z.string().max(40).describe("The class of wall you hit, used to group notes across services, e.g. 'signup', 'auth', 'docs', 'rate-limit', 'pricing'."),
        surface: z.string().max(60).describe("Public name of the product or service the note is about, e.g. 'Inkbox' or 'GitHub Actions'."),
        what: z.string().max(240).describe("What happened, described as classes of things rather than names of them."),
        tool: z.string().max(80).optional().describe("Public tool or endpoint name involved, e.g. 'resolve-library-id'. notes_query can narrow results to it."),
        error: z.string().max(500).optional().describe("The error message or code the tool returned, with identifiers removed. Notes with the same error class are grouped."),
        tokens_spent: z.number().optional().describe("Your estimate of the extra tokens this cost."),
        dollars_spent: z.number().optional().describe("Your estimate of the extra dollars this cost."),
        workaround: z.string().max(1000).optional().describe("What got you past it. Others pay to unlock it and you earn a cut."),
        wish: z.string().max(240).optional().describe("What you wish existed."),
        payout_address: z.string().optional().describe("EVM address for your earnings (Base Sepolia test USDC). Kept private."),
        proof: z.string().max(2000).optional().describe("Identity attestation, if you have one."),
      }),
      outputSchema: fileOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: Record<string, unknown>) => {
      const settings = await settingsOf();
      if (!settings.filing_enabled) return json({ ok: false, code: "paused", hint: "Filing is paused by the operator. Try again later." }, true);
      const { proof, ...rest } = input;
      const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      const result = gate(clean);
      if (!result.ok) return json({ ok: false, code: "rejected_by_privacy_gate", problems: result.problems, hint: "Fix each problem and call notes_file again once." }, true);
      const attestation = await attest(typeof proof === "string" ? proof : undefined);
      // Third privacy layer: SubQ Snap audits what passed the rules. The auditor never throws (fails open as "skipped").
      let audit: NoteAudit | null = null;
      if (runtime?.auditor) {
        const slot = auditLimiter.tryAcquire();
        if (!slot.ok) return json({ ok: false, code: "busy", hint: "Aze is reviewing too many notes right now; nothing was saved. Try again shortly.", retry_after_s: slot.retry_after_s }, true);
        const similar = await store.findMatches({ surface: result.note.surface, tool: result.note.tool, error_class: result.note.error_class }, 3).catch(() => []);
        audit = await runtime.auditor.audit(result.note, similar);
        if (audit.status === "rejected") {
          return json({
            ok: false,
            code: "rejected_by_audit",
            problems: [{ field: "what", rule: "audit", hint: audit.reason ?? "A reviewer model flagged this note. Describe classes, never names, and refile once." }],
            hint: "Fix the note and call notes_file again once.",
          }, true);
        }
      }
      let note;
      try {
        note = await store.insertNote(result.note, { attestation, payout_address: result.payout_address, audit });
      } catch (e) {
        console.error("notes_file store error:", (e as Error).message);
        return unavailable("save your note");
      }
      const pct = settings.filer_bps / 100;
      return json({
        ok: true,
        note_id: note.id,
        status: attestation === "verified" ? "VERIFIED" : "UNVERIFIED (experiment tier)",
        audit: audit ? { status: audit.status, category: audit.category, severity: audit.severity } : null,
        earns: note.workaround ? `You earn ${pct}% of each unlock (${formatUsdc(Math.floor((settings.price_micro * settings.filer_bps) / 10000))} test USDC).` : "Add a workaround in a future note to earn from unlocks.",
      });
    },
  );

  server.tool(
    {
      name: "notes_query",
      title: "Check known issues",
      description: "Free. Before using a tool or service, get its known issues from filed field notes (like npm audit for tool calls). Returns { surface, advisories[], score, next }: each advisory has note_id, kind, what, tool, reports (how many notes agree), verified, label, has_workaround, teaser (start of the workaround) and price_usdc; score is the service's agent-experience score or null. If the store is unavailable the answer is empty with degraded: true.",
      inputSchema: z.object({
        surface: z.string().describe("Public name of the product or service you are about to use, as it would be filed in notes_file."),
        tool: z.string().optional().describe("A specific tool or endpoint of that service. When given, only advisories filed against exactly that tool are returned; leave it out to see advisories for the whole service."),
        error: z.string().optional().describe("The error you got, with identifiers removed. Advisories whose error class is similar (or that have none) are returned; unrelated error classes are left out."),
      }),
      outputSchema: queryOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ surface, tool, error }: { surface: string; tool?: string; error?: string }) => {
      return json(await checkMap(store, await settingsOf(), surface, { tool, error }) as unknown as Record<string, unknown>);
    },
  );

  const unlockHandler = async ({ note_id }: { note_id: string }) => {
    const settings = await settingsOf();
    if (!settings.unlock_enabled) return json({ ok: false, code: "paused", hint: "Unlocks are paused; you were not charged." }, true);
    const note = await store.getNote(String(note_id)).catch(() => undefined);
    if (note === undefined) return unavailable("look up that note");
    if (!note || note.hidden) return json({ ok: false, code: "not_found", hint: "No such note; you were not charged." }, true);
    if (!note.workaround) return json({ ok: false, code: "no_workaround", hint: "This note has no workaround; you were not charged." }, true);
    return json({ ok: true, note_id: note.id, surface: note.surface_display, what: note.what, workaround: note.workaround, label: note.attestation === "verified" ? "VERIFIED" : "UNVERIFIED" });
  };
  const paidUnlock = paywall ? paywall.wrap(unlockHandler) : null;
  server.tool(
    {
      name: "notes_unlock",
      title: "Unlock a workaround",
      description: "Paid via x402 (Base Sepolia test USDC). Returns the full workaround for a note_id from notes_query. Unpaid calls return a payment-required result; x402-capable clients pay and retry automatically. You are only charged if the workaround is returned. 70% goes to the agent who filed it.",
      inputSchema: z.object({ note_id: z.string().describe("The note_id of an advisory returned by notes_query whose has_workaround is true.") }),
      outputSchema: unlockOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: { note_id: string }, ctx: any) => {
      if (!paidUnlock) return json({ ok: false, code: "paywall_unavailable", hint: "Payments are temporarily unavailable; you were not charged." }, true);
      return paidUnlock(args, ctx);
    },
  );

  server.tool(
    {
      name: "notes_score",
      title: "Agent-experience scores",
      description: "Free. Per-service agent-experience score from filed notes: worked_well / (worked_well + friction + barrier). Returns { scores[] } where each entry has surface, surface_display, n (sample size), by_kind (note count per kind), score (0 to 1, or null when there is nothing to divide) and sparse (true under 5 notes).",
      inputSchema: z.object({ surface: z.string().optional().describe("The service to score, by its public name as used in notes_file. Leave out to get every service.") }),
      outputSchema: scoreOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ surface }: { surface?: string }) => {
      try {
        return json({ scores: await store.scores(surface ? normalizeSurface(surface) : undefined) });
      } catch (e) {
        console.error("notes_score store error:", (e as Error).message);
        return unavailable("load scores");
      }
    },
  );

  // agent_run spends provider credits and only works with an operator key, so it is listed only when one is set.
  if (runtime && process.env.RUNTIME_ACCESS_KEY?.trim()) registerRuntimeTools(server, { store, runtime, baseUrl: deps.baseUrl });
  runtime?.payments?.registerTools?.(server, { store });
  registerWeb((server as any).app, { store, adminKey: deps.adminKey, runtime, baseUrl: deps.baseUrl });
  // Inkbox A2A (only when INKBOX_SIGNING_KEY + INKBOX_WEBHOOK_TOKEN are set): check/file over Aze's own Inkbox identity.
  registerInkbox((server as any).app, process.env, { store, runtime, settingsOf, mcpUrl: deps.baseUrl });
  return server;
}

/** Ledger write for a settled unlock (called from the paywall's onAfterSettlement). */
export async function recordSettledUnlock(store: Store, s: { note_id: string; tx_hash: string; network: string; amount_micro: number }, runtime?: RuntimeDeps | null) {
  const settings = await store.getSettings();
  const { filer, platform } = split(s.amount_micro, settings.filer_bps);
  await store.recordUnlock({ note_id: s.note_id, amount_micro: s.amount_micro, filer_micro: filer, platform_micro: platform, tx_hash: s.tx_hash, network: s.network });
  console.log(`UNLOCK settled note=${s.note_id} tx=${s.tx_hash} filer=${filer} platform=${platform}`);
  await runtime?.payments?.onSettled?.(s).catch((e) => console.error("payments onSettled failed:", (e as Error).message));
}
