# Handoff

**Updated:** 2026-10-17 ~13:20 PT.
**Live:** MCP https://calm-forge-4a5qt.run.mcp-use.com/mcp · dashboard /dashboard · room page /connect (+ /qr.svg).
Manufact server "Aze" id e5640ea8-1a70-40a5-93fe-1cecbbce358e (org Tatinc). Pushes to main auto-deploy.
**State:** T1–T7, T9–T12 done; 180 tests. Paywall ready on Manufact (facilitator reachable). Store = memory until Supabase vars land.
**Next:** T8 live proof. Ken's laptop CLI agent is setting BUYER_PRIVATE_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
ADMIN_KEY (sensitive) on Manufact and running supabase/migrations/0001_init.sql. Then redeploy → runtime logs must show
`[store]` not in-memory, `paywall ready`, and `SELFTEST ... tx: 0x…` (check on sepolia.basescan.org).
**After T8:** set SELFTEST_ON_BOOT=0 (otherwise every deploy files another demo note and spends $0.05 test USDC).
Then T13 (gate hardening with Gemini/Grok corpora when they arrive on agent-field-notes#1), rehearsal, Session 3.
**Verify:** `npx tsc --noEmit && npm test && npx mcp-use build`.
**Gotchas:** don't name a file `src/server.ts`; never `pkill -f` a pattern that appears in your own command line.
