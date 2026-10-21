# Tasks (moving state; CLAUDE.md is the stable reference)

## Session 1: prototype
- [x] T1 Scaffold + docs + shared types
- [x] T2 Spike: mcp-use + @x402/mcp compose (local, fake facilitator). **Primary path.** Live settle pending (repo + network).
- [x] T3 Supabase migration + store (Supabase + memory)
- [x] T4 Privacy gate + corpus tests
- [x] T5 notes_file (+ identity seam, kill switch)
- [x] T6 notes_query + advise envelope
- [x] T7 notes_unlock + ledger split
- [x] T8 PROTOTYPE: live loop on Manufact + Supabase, real Base Sepolia settlement tx 0x93ead1402366649282e4ca74de80f1993c7df910d1b265e7230c1308d0e747a2 (2026-10-17 14:05 PT)

## Session 2 (ultracode point)
- [x] T9 notes_score (in T5–T7) · [x] T10 dashboard · [x] T11 kill switch + hide (basic) · [x] T12 /connect + QR · [ ] T13 gate hardening (waiting on Gemini/Grok corpora; also block HTML tags in notes)

## Session 3: Agent Warehouse runtime (evening sprint; plan docs/plans/2026-10-17-evening-warehouse-sprint.md)
- [x] S0 contracts, migration 0003, /admin/diag, payments plugin hook · [x] advisory dedupe · [x] Stripe deposit payTo
- [x] S1 streams A–E built + A/B/C reviewed (on `wip/s1-checkpoint`, not `main`)
- [x] R1: SubQ json_schema · Stripe defaults + review · swarm/dashboard review
- [x] R1: integrator e2e (had landed in the snapshot) · [x] security review of the S1 diff + fixes (PR #1)
- [x] Workers AI backend for args/distill/note writer (`ARGS_BACKEND`, default workers-ai)
- [ ] Merge PR #1 to main (Ken) + DIAG_ON_BOOT live check (R2) · [ ] Ken: set RUNTIME_ACCESS_KEY for agent_run · [ ] swarm 10 → 100 (R3)
- [ ] Inkbox webhook route, A2A = VERIFIED (needs the CLI-agent report) · [ ] scout + buyer agents on Instabox

## Blocked on Ken
- [ ] Run docs/handoffs/2026-10-18-cli-agent-instabox-inkbox.md and paste the report
- [ ] Migration 0003 applied? (confirm)
- [x] Build repo: tatinc23/aze
- [ ] (optional) Network allowlist for this container
- [x] Supabase project + migrations 0001, 0002
- [x] Buyer wallet funded (20 test USDC)
- [x] Ken: rotated the Supabase secret key that was pasted into a chat

## Session 4 (2026-10-20): reframe + Manufact leaderboard docs
- [x] Drop "Waze for agents" from every live surface; new hook "Aze: the bottleneck map for AI agents" + Ken's three lines
- [x] Data business out of the README, parked in docs/ideas/business-model.md (+ "build and sell the solutions" angle)
- [x] Tool docs per the Manufact report: idempotentHint on all 4, outputSchema on all 4, meaning-first inputs, limits moved into the schema, notes_unlock title shortened and readOnlyHint corrected to false
- [x] websiteUrl -> new /docs page
- [x] Pipeline copy states the final flow (Ken): Snap picks tools, Workers AI structures, your LLM answers. Clef skipped (Ken 2026-10-20)
- [ ] Ken: merge the PR, then warm /api/health, re-curl initialize + /docs, and re-run the Manufact scoring
- [x] BEFORE the rescore: Snap-only `agent_run` (task + caller's tools in; Snap decisions + advisories out; caller's LLM does the rest) and remove Workers AI (Ken 2026-10-20). Branch `claude/agent-run-decide-only`
- [ ] Later: SubQ 1.1 Small for the language tier when the key has it; see docs/ideas/hybrid-execution-harness.md
- [ ] Check whether Manufact has a manual category setting (Data & Analytics); not found in public docs

## Session 5 (2026-10-20): decide-only agent_run
- [x] agent_run: task + caller's tools in; map check, Snap scores, advisories + next step out; outputSchema `runOutput`
- [x] Workers AI + SubQ chat code removed; swarm and /admin/run decide-only over the catalog
- [x] Dashboard "How a run works" + economics (map check, Snap) and README runtime table / token-savings copy updated
- [ ] Ken: merge PR #13, then this PR; delete the unused env vars listed in HANDOFF.md
- [ ] Ken: delete or keep `src/runtime/executors.ts` / `fetch.ts` / `mcp-client.ts` (unwired now)
- [ ] After deploy: one real agent_run against live Snap (needs RUNTIME_ACCESS_KEY), then rerun the Manufact scoring
- [ ] Later: let Snap see the advisories when it scores (today they come back next to the pick)
