# Handoff

**Updated:** 2026-10-17 ~7:55 PM PT (session 3 handoff; the next session runs in a different Claude account).
Demos Sun Oct 18, 10:00 AM PT. Plan for what's left: `docs/plans/2026-10-18-s2-s3-next.md`.

## State
- **Live (`main`, auto-deploys):** the prototype plus S0. 4 MCP tools (`notes_file`, `notes_query`, `notes_unlock`,
  `notes_score`), Supabase store, x402 paywall paying to the Stripe sandbox deposit address (Base Sepolia TEST USDC),
  advisories collapse duplicates, `/dashboard`, `/connect`, `/api/health`. Paid loop proven 3× on Base Sepolia
  (first: `0x93ead1402366649282e4ca74de80f1993c7df910d1b265e7230c1308d0e747a2`).
  https://calm-forge-4a5qt.run.mcp-use.com · Manufact server `e5640ea8-1a70-40a5-93fe-1cecbbce358e`.
- **Agent Warehouse runtime (S1): built + reviewed, NOT on `main`.** It lives on branch **`wip/s1-checkpoint`**
  (a snapshot of the working tree, not a reviewed commit). Contents: `src/runtime/*` (catalog, pipeline, `agent_run`
  tool, SSRF-safe fetch, MCP client), `src/subq/*` (Snap router + note audit, chat clients), `src/llm/workers-ai.ts`
  (renderer + fallback), `src/pay/stripe*` (PaymentIntent recording, MPP card unlock), `src/swarm/*`,
  `src/web/{runtime,dashboard,diag}.ts`, tests for each. Stream reports: `docs/plans/s1-stream-reports.json`.
- **R1 (fix + review pass) at handoff:** done: SubQ strict `json_schema`, Stripe defaults (`network=base`,
  `2026-07-29.preview`) + the Stripe review, the swarm/dashboard review. **In progress when the session ended:** the
  integrator (mock-provider e2e, `DIAG_ON_BOOT=1` boot diag line, `RUNTIME providers` log line). **Not run:** the
  security review. So the snapshot may hold a half-finished integrator edit: run the checks before trusting it.
- **Provider facts:** SubQ key has only `subq-snap-preview` → args/distill/notes must move to Workers AI (plan §1;
  without it every `agent_run` fails at the args tier). Stripe sandbox deposit address is live on Manufact
  (`STRIPE_DEPOSIT_ADDRESS`, `STRIPE_X402_NETWORK=base`). Migration 0003: assumed applied by Ken's CLI agent, not
  confirmed (the runtime falls back to the memory store if its tables are missing; check the boot log).

## Next, in order
1. `git fetch origin wip/s1-checkpoint` → branch from it → `npx tsc --noEmit && npm test && npx mcp-use build`.
   Fix what's red. Finish the integrator's e2e (spec in `docs/plans/2026-10-18-s2-s3-next.md` §2 and the R1 notes there).
2. Workers AI backend for args/distill/note writer (plan §1).
3. Security review of the S1 diff (threat model: no unauthenticated route or tool that spends AI credits, payments or
   repo/box creation; SSRF in fetch; secrets never logged; privacy gate before every store write; agent output is
   untrusted). Fix findings.
4. Merge to `main` (deploys) → `DIAG_ON_BOOT=1` on Manufact → read the `DIAG` line in runtime logs → fix wire mismatches.
5. Ken's CLI agent runs `docs/handoffs/2026-10-18-cli-agent-instabox-inkbox.md` (Inkbox identities + Instabox boxes)
   and pastes the report; then build the Inkbox webhook route (plan §4: A2A = VERIFIED) and the scout/buyer agents (§5).
6. Swarm 10 → 100 via Ken's CLI agent (`POST /admin/swarm`, admin key). Rehearse the demo twice Sunday 7–9 AM.
Cut order if late: Instabox agents → Stripe rail (keep x402.org) → Inkbox VERIFIED → swarm size (25 instead of 100).

## For the next session (new account)
- Needs GitHub access to `tatinc23/aze` (+ `tatinc23/agent-field-notes` for issue #1), and the **Manufact connector**
  (runtime/build logs, env var names, deploys); Ken connects it in the new account.
- The cloud container's network blocks the providers (x402.org, sepolia.base.org, *.run.mcp-use.com, *.supabase.co,
  subq.ai, inkbox.ai, instabox.sh, docs.stripe.com). Observe the live server via Manufact logs; Ken's CLI agent does
  anything that must reach a provider. GitHub + npm work.
- Inkbox skills: `npx skills add https://github.com/inkbox-ai/inkbox -g -a claude-code -s '*' -y`.
- Pushes to `main` deploy and restart the machine: never push untested work there; snapshot WIP to a `wip/` branch.

## Open for Ken
- Run the CLI-agent prompt above; answer: what are the Inkbox team's "100 agents" (org quota vs existing identities)?
- Names for the scout and buyer agents (or ask Muse).
- Ask SubQ for `subq-preview` access (then set `ARGS_BACKEND=subq`).
- Muse still owes: M3 (Instabox part, now mostly covered by `docs/research/`), M4 `docs/muse/audit-policy.md`,
  M5 `docs/muse/swarm-tasks.json`, M6 `docs/muse/catalog.json`, M7 pitch/demo script/Inkbox-track write-up/one-pager.

**Verify:** `npx tsc --noEmit && npm test && npx mcp-use build`. **Gotchas:** CLAUDE.md.
