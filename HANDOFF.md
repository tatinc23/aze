# Handoff

**Updated:** 2026-10-17 ~12:20 PT. **Next task:** T8 live: Manufact server for tatinc23/aze (main), env vars, deploy, SELFTEST_ON_BOOT run -> real Base Sepolia tx in runtime logs. Then Session 2.
**State:** T1-T7 done, 153 tests green, local loop green (`node spike/fake-facilitator.mjs`, then `X402_FACILITATOR_URL=http://localhost:4999 npx tsx scripts/serve.ts`, then `npx tsx demo/agent.ts http://localhost:3000/mcp`).
**Blockers (Ken):** fund buyer wallet; Supabase project + run `supabase/migrations/0001_init.sql` + set SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY on the Manufact server; optional network allowlist.
**Verify:** `npx tsc --noEmit && npm test && npx mcp-use build`.
**Gotcha:** don't name a file `src/server.ts` (mcp-use build mistakes it for the entry).
