# Handoff

**Updated:** 2026-10-17 ~14:10 PT. **PROTOTYPE DONE (T8):** real Base Sepolia settlement
`0x93ead1402366649282e4ca74de80f1993c7df910d1b265e7230c1308d0e747a2`.
**Live:** https://calm-forge-4a5qt.run.mcp-use.com (/mcp, /dashboard, /connect). Store: Supabase. SELFTEST_ON_BOOT=0.

**Next (Session 2/3):**
- T13 gate hardening with Gemini/Grok corpora (agent-field-notes#1).
- Stage runbook: run the loop from a laptop with network:
  `BUYER_PRIVATE_KEY=<test key> npx tsx demo/agent.ts https://calm-forge-4a5qt.run.mcp-use.com/mcp`
- Rehearse the loop twice; a real Claude connects via /connect and files/queries live.
- Prior-work disclosure at repo root; submission fields. Phase 2 (warranty) only if all green.

**Open for Ken:** rotate the Supabase secret key that was pasted into a chat (update Manufact + 1Password).
**Verify:** `npx tsc --noEmit && npm test && npx mcp-use build`.
**Gotchas:** see CLAUDE.md (no src/server.ts, no pkill -f self-match, Supabase grants, selftest cost, autosuspend,
quote heredocs that contain backticks).
