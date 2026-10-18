# Handoff

**Updated:** 2026-10-17 ~10:15 PM PT (session 4). Demos Sun Oct 18, 10:00 AM PT.
Plan for what's left: `docs/plans/2026-10-18-s2-s3-next.md`.

## State
- **Live (`main`, auto-deploys): unchanged.** The prototype plus S0. 4 MCP tools (`notes_file`, `notes_query`,
  `notes_unlock`, `notes_score`), Supabase store, x402 paywall paying to the Stripe sandbox deposit address (Base
  Sepolia TEST USDC), `/dashboard`, `/connect`, `/api/health`. Paid loop proven 3× on Base Sepolia (first:
  `0x93ead1402366649282e4ca74de80f1993c7df910d1b265e7230c1308d0e747a2`).
  https://calm-forge-4a5qt.run.mcp-use.com · Manufact server `e5640ea8-1a70-40a5-93fe-1cecbbce358e`.
- **S1 runtime + session-4 work: branch `claude/nice-einstein-uangdn`, draft PR tatinc23/aze#1. NOT merged/deployed.**
  Green: `npx tsc --noEmit` · `npm test` 715/715 · `npx mcp-use build`.
  - The `wip/s1-checkpoint` snapshot was green as-is. The integrator work had landed: `DIAG_ON_BOOT=1` and the
    `RUNTIME providers` line both exist.
  - **Workers AI chat backend** (plan §1, `a6cf95d`): `ARGS_BACKEND=workers-ai` (default) | `subq`.
    - Args, distill and the note writer use the renderer's models (GLM-5.3 Flash, falling back to gpt-oss-120b). The
      primary model gets 2/3 of the 30 s budget. No `response_format` is sent; the factories extract and validate the
      reply, then retry once.
    - Without CF creds those tiers are off; they do NOT fall back to the SubQ chat, which would 403.
    - Snap (router + audit) stays on SubQ.
    - Chat tiers are priced with `RENDER_PRICE_*`, null when unset.
    - The providers line shows `chat=workers-ai`.
  - **Security review of the S1 diff done** (3 parallel reviewers: routes, runtime, payments). Fixed (`b5ed113`):
    - HIGH: `notes_file` made a paid Snap audit call per public call, with no limit. It is now capped at 120/min
      server-wide; over the cap it returns `busy` and stores nothing, never a note filed unaudited.
    - `agent_run` accepts only `RUNTIME_ACCESS_KEY`, **no longer `ADMIN_KEY`** (that key must not sit in LLM-visible
      tool args). It applies the `/admin/run` task and surface rules and allows at most 3 runs in flight.
    - Public rendered answers mask emails, @handles and IPv4s.
  - **Known and accepted (low/info):**
    - The `mcp` executor has no DNS pinning or body cap. Catalog rows are writable by the service role only.
    - Prompt-injected "workarounds" in runtime-filed notes.
    - The soft deadline doesn't cancel an in-flight `notes_file`.
    - `inkbox_send` takes any `to`: allowlist recipients before wiring it.
    - The card rail's global 30/min attempt limiter can be filled by one attacker, which locks out real payers. No
      money moves (test mode). Fix if the card rail ships: one attempt per challenge id plus a per-IP bucket.
    - `agent_run` has its own 60/h budget, separate from the swarm budget.
- **Unverified (no network here):** Workers AI reply shapes and latency on JSON prompts. A run makes 3–6 model calls
  against a 120 s deadline, and earlier measurements on these models saw answers take ~110 s, so expect
  `agent_run`/swarm timeouts under load. Migration 0003 is still unconfirmed.

## Next, in order
1. **Ken:** set `RUNTIME_ACCESS_KEY` on Manufact (only if `agent_run` is wanted; `ADMIN_KEY` no longer works for it).
   Make sure `CF_ACCOUNT_ID`/`CF_API_TOKEN` are set, or the chat tiers stay off.
2. **Ken merges PR #1** (= deploy + restart) early enough to watch one boot, NOT in the last hour before the demo.
   Then set `DIAG_ON_BOOT=1`, warm `/api/health`, and read the `DIAG {...}` + `RUNTIME providers` lines in the
   Manufact runtime logs. Re-run the proven paid loop once against the new deploy. If anything in it broke, revert the
   merge and demo the prototype.
3. Fix wire mismatches the DIAG line shows, one validated push each.
4. Swarm 10 → 25 (→ 100 only if 25 is clean) via Ken's CLI agent (`POST /admin/swarm`, admin key).
5. Inkbox VERIFIED / Instabox agents: only if everything above is green; both still wait on the CLI-agent report
   (`docs/handoffs/2026-10-18-cli-agent-instabox-inkbox.md`).
6. Rehearse the demo twice Sunday 7–9 AM. **The demo spine is the proven loop** (file → query → advisory → 402 →
   unlock → settlement hash). Show `agent_run` and the swarm only from a recording, or as a bonus if live is green.
Cut order if late: Instabox agents → Stripe rail (keep x402.org) → Inkbox VERIFIED → swarm size.

## For the next session
- Needs GitHub access to `tatinc23/aze` (+ `tatinc23/agent-field-notes` for issue #1), and the **Manufact connector**
  (runtime/build logs, env var names, deploys). **Session 4 had no Manufact connector**, so nothing live was observed.
- The cloud container's network blocks the providers (x402.org, sepolia.base.org, *.run.mcp-use.com, *.supabase.co,
  subq.ai, inkbox.ai, instabox.sh, docs.stripe.com). Ken's CLI agent does anything that must reach a provider.
- Pushes to `main` deploy and restart the machine: never push untested work there.

## Open for Ken
- Merge decision on PR #1 (see Next 2) + `RUNTIME_ACCESS_KEY`.
- The CLI-agent prompt; what the Inkbox team's "100 agents" are; scout/buyer agent names.
- Ask SubQ for `subq-preview` access (then `ARGS_BACKEND=subq`).
- Muse: M7 drafted (pitch, demo script, one-pager, Inkbox write-up, booth notes); polish due 8 AM. Check that every
  hash/number on screen comes from this repo, and that any live `agent_run`/swarm beat has a recorded backup.
  M4–M6 still open (the swarm falls back to built-in tasks without M5).

**Verify:** `npx tsc --noEmit && npm test && npx mcp-use build`. **Gotchas:** CLAUDE.md.
