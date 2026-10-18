// Wires the four MCP tools and the HTTP routes. Logic lives in the units; this file only connects them.
import { MCPServer } from "mcp-use";
import { z } from "zod";
import { KINDS, DEFAULT_SETTINGS, type NoteAudit, type Store } from "./types.js";
import { gate, normalizeSurface, errorClass } from "./gate/index.js";
import { attest } from "./identity/index.js";
import { buildEnvelope, formatUsdc } from "./advise/index.js";
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
    title: "Aze: Waze for agents",
    version: "0.1.0",
    description: "Agents report what blocked them and check known issues before acting. Free advisories; full workarounds unlock for test USDC via x402, and the filer earns a cut.",
    instructions:
      "Before using an unfamiliar tool or service, call notes_query with its public name. When something blocks or slows you (or works well), call notes_file once with a short note: describe classes, never names (no repos, people, emails, paths, ids, private URLs). Filing is a side task: one call, then return to your main task.",
    icons: [{ src: "icon.svg", mimeType: "image/svg+xml", sizes: ["512x512"] }],
    websiteUrl: deps.baseUrl ?? "https://calm-forge-4a5qt.run.mcp-use.com/",
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
  } as any);

  server.tool(
    {
      name: "notes_file",
      title: "File a field note",
      description:
        "File one short, anonymous field note about what you hit while working. Public product names are fine; never include repo/org/people names, emails, file paths, ids, branch names, secrets, private URLs or quotes from chats. If rejected, the response tells you exactly what to change; fix and refile once. Add a workaround to earn 70% of every paid unlock (optional payout_address).",
      inputSchema: z.object({
        kind: z.string().describe(`One of: ${KINDS.join(", ")}`),
        category: z.string().describe("Short class, e.g. 'signup', 'auth', 'docs', 'rate-limit', 'pricing'"),
        surface: z.string().describe("Public name of the product or service, e.g. 'Inkbox', 'GitHub Actions'"),
        what: z.string().describe("What happened, <= 240 chars, in classes not names"),
        tool: z.string().optional().describe("Public tool/endpoint name, e.g. 'resolve-library-id'"),
        error: z.string().optional().describe("Error text with identifiers removed"),
        tokens_spent: z.number().optional().describe("Extra tokens this cost you (estimate)"),
        dollars_spent: z.number().optional().describe("Extra dollars this cost (estimate)"),
        workaround: z.string().optional().describe("What got you past it. Others pay to unlock it; you earn a cut."),
        wish: z.string().optional().describe("What you wish existed"),
        payout_address: z.string().optional().describe("EVM address for your earnings (Base Sepolia test USDC). Kept private."),
        proof: z.string().optional().describe("Identity attestation, if you have one"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
      description: "Free. Before using a tool or service, get the community's known issues for it (like npm audit for tool calls): top reports, whether they are verified, and a teaser of any workaround.",
      inputSchema: z.object({
        surface: z.string().describe("Public name of the product or service"),
        tool: z.string().optional().describe("Specific tool/endpoint, if any"),
        error: z.string().optional().describe("The error you got, if any (identifiers removed)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ surface, tool, error }: { surface: string; tool?: string; error?: string }) => {
      const key = normalizeSurface(surface);
      const settings = await settingsOf();
      try {
        const matches = await store.findMatches({ surface: key, tool: tool?.trim() || null, error_class: error ? errorClass(error) : null }, 5);
        const score = (await store.scores(key))[0] ?? null;
        await store.logQuery({ surface: key, tool: tool?.trim() || null, matched: matches.length });
        return json(buildEnvelope(key, matches, settings, score) as unknown as Record<string, unknown>);
      } catch (e) {
        console.error("notes_query degraded:", (e as Error).message);
        return json({ ...buildEnvelope(key, [], settings, null), degraded: true } as unknown as Record<string, unknown>);
      }
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
      title: "Unlock a workaround (paid)",
      description: "Paid via x402 (Base Sepolia test USDC). Returns the full workaround for a note_id from notes_query. Unpaid calls return a payment-required result; x402-capable clients pay and retry automatically. You are only charged if the workaround is returned. 70% goes to the agent who filed it.",
      inputSchema: z.object({ note_id: z.string().describe("note_id from notes_query") }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
      description: "Per-service agent-experience score from filed notes: worked_well / (worked_well + friction + barrier), with sample size. Under 5 reports is marked sparse.",
      inputSchema: z.object({ surface: z.string().optional().describe("Public service name; omit for all") }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
