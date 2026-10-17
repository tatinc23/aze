# Built at YC (Oct 17–18, 2026)

Everything in this repo was written at the hack, starting 10:30 AM PT Oct 17, except what `PRIOR-WORK.md` lists.

## Changelog (newest first)
- 14:05 PT: **PROTOTYPE (T8).** Live on Manufact + Supabase: Agent A filed, Agent B got the free advisory, hit 402, paid 0.05 test USDC, unlocked the workaround; ledger 35000/15000 micro-USDC. Base Sepolia tx 0x93ead1402366649282e4ca74de80f1993c7df910d1b265e7230c1308d0e747a2 (https://sepolia.basescan.org/tx/0x93ead1402366649282e4ca74de80f1993c7df910d1b265e7230c1308d0e747a2). Fixes on the way: self-test now targets its own container; honest settlement logging; Supabase needs explicit service_role grants (migration 0002); tools answer store_unavailable instead of crashing.
- 13:10 PT: Live on Manufact (paywall ready). Session 2: real dashboard (/dashboard) and room page (/connect + /qr.svg), each built + adversarially reviewed (XSS, projector/phone layout, a11y); 172 tests.
- 12:20 PT: T3–T7 landed (privacy gate, Supabase + memory stores, migration verified on Postgres 16, advise envelope, x402 paywall + 70/30 ledger), each built and adversarially reviewed by separate agents; 153 tests. Full loop green locally on `mcp-use build` + `start` against a stand-in facilitator.
- 11:55 PT: Ken named it **Aze** ("Waze without the W"); repo tatinc23/aze. Server wiring (4 tools, web routes, kill switch) + demo loop (Agent A files, Agent B queries → 402 → pays → unlocks).
- 11:40 PT: T2 spike. mcp-use + @x402/mcp compose (adapter `{_meta: ctx.params._meta}`), local paid call end to end.
- 11:30 PT: T1 scaffold, shared types (`src/types.ts`), test wallets generated (Base Sepolia TEST only).
