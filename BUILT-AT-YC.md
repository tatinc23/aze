# Built at YC (Oct 17–18, 2026)

Everything in this repo was written at the hack, starting 10:30 AM PT Oct 17, except what `PRIOR-WORK.md` lists.

## Changelog (newest first)
- ~19:15 PT: Live provider checks (Ken's CLI agent): the SubQ key lists only `subq-snap-preview` (`subq-preview` is early
  access), so args/distill/note writing move to Workers AI behind the same interfaces; Stripe sandbox crypto deposit
  address created and set as the x402 payTo on Manufact. Inkbox skills installed for the build agent; Instabox (by
  InsForge) CLI + SDK located.
- ~18:30–19:40 PT: Container restart lost the S1 review/integration stages (files survived on disk + a WIP branch);
  resumed as R1: SubQ JSON mode switched to strict `json_schema` per the docs, Stripe defaults fixed (`network=base` in
  sandbox, `2026-07-29.preview`), the lost Stripe and swarm reviews, an end-to-end test against mock providers, a
  security review.
- ~17:20–18:30 PT: **Agent Warehouse runtime, S1** (not deployed yet): five streams built in parallel by separate agents,
  each adversarially reviewed. A: catalog + pipeline (identity → Snap route → args → execute → distill → render → field
  notes), `agent_run` tool, SSRF-safe fetch, MCP calls. B: SubQ Snap router + Snap note audit (third privacy layer).
  C: Workers AI renderer with timeout + fallback. D: Stripe machine payments (x402 settlements recorded as Stripe
  PaymentIntents; MPP card unlock). E: swarm runner (HD payout addresses) + dashboard agent grid + economics panel.
- 17:33 PT: Advisories collapse identical reports into one advisory with a count (npm-audit style); `/api/health`.
- 17:28 PT: Paywall pays to the Stripe sandbox deposit address when set (Base Sepolia), else the platform test wallet.
- 17:17 PT: S0 for the evening sprint: frozen runtime contracts, migration 0003 (`warehouse_assets`, `runs`,
  `notes.audit`), Snap audit hook in `notes_file`, `/admin/diag`, payments plugin hook. Plan:
  `docs/plans/2026-10-17-evening-warehouse-sprint.md`.
- 14:05 PT: **PROTOTYPE (T8).** Live on Manufact + Supabase: Agent A filed, Agent B got the free advisory, hit 402, paid 0.05 test USDC, unlocked the workaround; ledger 35000/15000 micro-USDC. Base Sepolia tx 0x93ead1402366649282e4ca74de80f1993c7df910d1b265e7230c1308d0e747a2 (https://sepolia.basescan.org/tx/0x93ead1402366649282e4ca74de80f1993c7df910d1b265e7230c1308d0e747a2). Fixes on the way: self-test now targets its own container; honest settlement logging; Supabase needs explicit service_role grants (migration 0002); tools answer store_unavailable instead of crashing.
- 13:10 PT: Live on Manufact (paywall ready). Session 2: real dashboard (/dashboard) and room page (/connect + /qr.svg), each built + adversarially reviewed (XSS, projector/phone layout, a11y); 172 tests.
- 12:20 PT: T3–T7 landed (privacy gate, Supabase + memory stores, migration verified on Postgres 16, advise envelope, x402 paywall + 70/30 ledger), each built and adversarially reviewed by separate agents; 153 tests. Full loop green locally on `mcp-use build` + `start` against a stand-in facilitator.
- 11:55 PT: Ken named it **Aze** ("Waze without the W"); repo tatinc23/aze. Server wiring (4 tools, web routes, kill switch) + demo loop (Agent A files, Agent B queries → 402 → pays → unlocks).
- 11:40 PT: T2 spike. mcp-use + @x402/mcp compose (adapter `{_meta: ctx.params._meta}`), local paid call end to end.
- 11:30 PT: T1 scaffold, shared types (`src/types.ts`), test wallets generated (Base Sepolia TEST only).
