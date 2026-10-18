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
- [ ] R1: integrator e2e (was running at handoff) · [ ] security review of the S1 diff
- [ ] Workers AI backend for args/distill/note writer (`subq-preview` not on Ken's key)
- [ ] Merge to main + DIAG_ON_BOOT live check (R2) · [ ] swarm 10 → 100 (R3)
- [ ] Inkbox webhook route, A2A = VERIFIED (needs the CLI-agent report) · [ ] scout + buyer agents on Instabox

## Blocked on Ken
- [ ] Run docs/handoffs/2026-10-18-cli-agent-instabox-inkbox.md and paste the report
- [ ] Migration 0003 applied? (confirm)
- [x] Build repo: tatinc23/aze
- [ ] (optional) Network allowlist for this container
- [x] Supabase project + migrations 0001, 0002
- [x] Buyer wallet funded (20 test USDC)
- [x] Ken: rotated the Supabase secret key that was pasted into a chat
