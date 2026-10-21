# Handoff

## 2026-10-20: agent_run is decide-only; Workers AI removed (branch `claude/agent-run-decide-only`, on top of PR #13)
- **What shipped (Ken's 2026-10-20 call):** `agent_run` takes `task` + the caller's `tools` (1-20, each `name`,
  `description`, optional `surface`) + optional `surface` + `access_key`. Flow: map check (the `notes_query` lookup,
  `checkMap` in `src/advise/index.ts`, shared with notes_query) for each tool's service (max 5) → SubQ Snap scores every
  tool → returns `chosen` (p >= 0.5, max 3), `scores`, `advisories` that apply (whole-service notes + notes filed against
  that tool), `next` (run the tools yourself, file friction with notes_file), `cost_micro_usd.snap`. outputSchema:
  `runOutput` in `src/runtime/tools.ts`. Snap down or failing = status `failed` (isError) but advisories for every
  candidate still come back.
- **Removed:** `src/llm/*` (Workers AI chat, renderer, second vote), `src/subq/chat.ts`, `schema.ts`, `ensemble.ts`, the
  SubQ chat diag + config (`SUBQ_CHAT_MODEL`, `SUBQ_REASONING_EFFORT`), `ARGS_BACKEND` / `SYSTEM_ONE_CF*` / `RENDER_*` /
  `SUBQ_CHAT_PRICE_*` handling. `grep -ri "workers ai\|workers-ai" src` is empty. The Snap note audit is unchanged.
- **Swarm + POST /admin/run** use the same decide-only pipeline with the warehouse catalog as candidates (they bring no
  tools). They no longer fetch pages, answer or file notes, so the swarm is now a routing demo.
- **Ken decides:** `src/runtime/executors.ts`, `fetch.ts`, `mcp-client.ts` (+ tests) are unwired but kept (not in the
  removal list). Options: (a) delete them, (b) keep for a future "Aze runs it for you" mode. Their diags are gone from
  /admin/diag.
- **Privacy:** caller tool names are stored in `runs.assets` but masked as `[caller tool]` on public `/api/runs`, and the
  snap timing detail for caller tools carries counts and p values only. `/admin/run` (operator) shows names.
- **Run log:** same `runs` table, no migration. New rows: tiers `notes` + `snap` only; `answer`, `raw_bytes`,
  `distilled_bytes` null. Old rows keep their args/render data; readers skip unknown tiers.
- **Env on Manufact now unused (safe to delete after merge):** `ARGS_BACKEND`, `SYSTEM_ONE_CF`, `SYSTEM_ONE_CF_MODEL`,
  `RENDER_MODEL`, `RENDER_PRICE_IN_PER_M`, `RENDER_PRICE_OUT_PER_M`, `SUBQ_CHAT_MODEL`, `SUBQ_CHAT_PRICE_*`,
  `SUBQ_REASONING_EFFORT`, `CF_API_TOKEN`/`CF_ACCOUNT_ID` (unless something outside this repo uses them).
- **Not verified live:** no SubQ key was reachable from this session, so the PR's sample uses a fixed-score stand-in
  (`SAMPLE_FAKE_SNAP=1 npx tsx scripts/agent-run-sample.ts`). After merge: set RUNTIME_ACCESS_KEY if it is not set, warm
  /api/health, run one real agent_run, then rescore.

## 2026-10-20: reframe off "Waze for agents" + Manufact tool docs (branch `claude/mcp-leaderboard-docs-5cc13e`)
- **Framing (Ken):** title "Aze: the bottleneck map for AI agents"; hero "Every task, agents hit walls built for humans.
  Aze maps them so they can be fixed."; three lines "Show humans where AI workflows break. Better agent output through
  smarter tool calls. Less LLM token spend." Goal: Manufact classes Aze as Data & Analytics, not Dev Tools.
- **Models (Ken, 2026-10-20): Clef is SKIPPED.** The 2026-10-19 Clef-Omni plan below is cancelled. Decide is Snap
  only for now. The end state is two SubQ models: Snap for typed decisions, and SubQ 1.1 Small (early access, not on
  our key) for long-context language. Big picture: `docs/ideas/hybrid-execution-harness.md`.
- **Snap-only, no Workers AI (Ken, 2026-10-20):** SubQ makes every decision. The caller's LLM reads Snap's results
  in the MCP tool result (no handoff model), then fills inputs, runs tools and answers itself. Next build: `agent_run`
  takes the task + the caller's tools, Snap picks, Aze returns decisions + advisories; Workers AI (args, distill,
  render, note drafts, second vote) is removed. README runtime table and dashboard still say "Workers AI fills inputs
  and distills" until that ships; that PR updates them.
- **MCP surface:** idempotentHint + outputSchema on all 4 tools; `kind` is `z.enum(KINDS)` and text fields carry the gate's
  `.max()` limits (invalid kind/length now fails schema validation before the gate); notes_unlock readOnlyHint -> false
  (it settles a payment and writes a ledger row); websiteUrl -> `<base>/docs` (new page `src/web/docs.ts`).
- **Business ideas:** `docs/ideas/business-model.md` (build and sell fixes; parked data sales + Ken's objection; the
  original consent language).
- **Next:** Ken merges -> warm `/api/health` -> re-curl `initialize` and `/docs` -> Snap-only agent_run + Workers AI removal -> rescore.

---
## 2026-10-19: Clef-Omni plan (CANCELLED 2026-10-20: Clef skipped; step 4 "return decisions to the caller" still applies) (written by Claude, session ended at Ken's request, no code written)

### The intended flow (Ken, 2026-10-19). The code does not do this yet.
1. A human asks their AI to do something.
2. The AI calls Aze's connector with the task.
3. **SubQ Snap + Cloudflare Clef-Omni decide and reason:** which tool, which known walls apply, what to do about them.
4. Aze hands those decisions and the facts back to **the caller's LLM**.
5. The caller's LLM finishes the task and gives the human the result.

Clef-Omni is a stand-in. SubQ's own small model isn't on Ken's key yet (it only has `subq-snap-preview`); when SubQ
grants it, compare the two and keep whichever wins.

### What the code does today (main `a208008`; PR #12 is docs only)
- Decide: SubQ Snap only. The second vote (`src/llm/workers-ai-systemone.ts`, combined in `src/subq/ensemble.ts`) is
  wired but off (`SYSTEM_ONE_CF=off` in production; it is opt-in). Its default model is Llama 3.1 8B, which reports
  its own `p_yes` in JSON, and that number isn't calibrated.
- Structure (args, distill, note drafts): GLM-5.3 Flash, falling back to gpt-oss-120b, on Workers AI.
- Answer: **Aze writes it** (`src/runtime/pipeline.ts` step 5, `runtime.renderer.render`), on the same Workers AI pair.
  The caller's LLM gets a finished answer, not decisions plus facts.
- CLI commits `c9101b7`/`79eaf1c` (README) and `9dd5ccc` (dashboard labels) describe the intended flow as if it
  were live. PR #12 fixes the README. **The dashboard labels are still wrong** until the work below ships.

### Verified facts about Clef-Omni (Cloudflare docs, read 2026-10-19 via the Cloudflare docs MCP)
- `@cf/cloudflare/clef-omni` exists on Workers AI (launched Oct 9, 2026). It's a **decision model**: you give it a
  state plus typed questions, and it returns a probability for every allowed option. It does not generate text. It
  uses the same "System One API" as Clef / Clef-flash and Typesafe's Jev. The docs say: "change the model ID to
  `@cf/cloudflare/clef-omni` and set the `model` selector to `clef-omni`."
- Specs: 30B MoE (3B active), 64k context. Inputs: text, JSON, images, audio, video. $0.15 per million input
  tokens; output is free.
- Clef-flash costs $0.038/M and Clef is up to 2x faster. For text-only routing, try `clef` and `clef-flash` before
  `clef-omni`. Omni's extra is media input, and Aze sends none.

### Do NOT do this: `RENDER_MODEL=@cf/cloudflare/clef-omni`
The renderer and the chat tiers expect generated text, and Clef doesn't produce any. Pointing them at Clef would
break every answer and every note draft. **Clef goes in the decide slot, not the render slot.**
`SYSTEM_ONE_CF_MODEL=@cf/cloudflare/clef-omni` on its own probably fails too. The current adapter sends a chat
prompt and parses a JSON reply; Clef has its own System One request format. So the work is a small native adapter,
not an env var.

### The work, in order (branch + PR, Ken merges; main auto-deploys)
1. **Read the request/response format** on the model page (`/workers-ai/models/clef-omni/`, "View as Markdown").
   Don't guess the body.
2. **Add a native Clef `Decider`** next to `workers-ai-systemone.ts`. It maps Snap's questions (noul / choice /
   score, `src/subq/wire.ts`) onto Clef's typed questions, and Clef's probabilities back onto `SnapAnswer`.
   - Same CF credentials, redaction and timeouts as the existing adapter.
   - Price it: per input token, output free.
   - Add a `DIAG_ON_BOOT` probe with the same questions as the Snap diag.
   - Tests use recorded fixtures.
3. **Switch:** `SYSTEM_ONE_CF=clef` (or a new `DECIDER_2=clef`); `SYSTEM_ONE_CF_MODEL` picks clef / clef-flash /
   clef-omni. Keep Llama as a non-default option.
   - The off-by-default reason was uncalibrated, self-reported `p_yes`. Clef returns real probabilities, but check
     agreement against Snap on a fixed task set before turning it on: log both votes, then compare.
4. **Return decisions to the caller (step 4 of the flow).** Add an `agent_run` mode, e.g. `answer: "caller"`, that
   skips `renderer.render` and returns:
   - the routing decisions with their probabilities;
   - the advisories that applied;
   - the distilled facts.

   Keep today's rendered answer as the default until the new mode is proven. The pipeline already returns facts when
   there's no renderer (see step 5's "renderer unavailable" branch), so this is mostly a flag plus output shape.
5. **Then fix the docs to match:** the dashboard labels (`9dd5ccc`), the README runtime table, and `/connect`.
   Don't change them before the code ships.
6. **Prove it:** deploy (merge), set `DIAG_ON_BOOT=1`, warm `/api/health`, and read the `DIAG` + `RUNTIME
   providers` lines in the Manufact runtime logs. Then run 10 `agent_run`s, then a 25-agent swarm, and compare Snap
   alone with Snap + Clef: routing agreement, latency and cost.

### Rules that still hold
TEST mode only. Never print secrets. Never rotate keys on Ken's identities. Don't log rejected note input. Instabox
box ids come from env only. `inkbox_send` sends only to allowlisted recipients. Nothing public merges without Ken's
review. Production deploys and force-pushes are blocked by the classifier; don't work around it.

### Open PR
[tatinc23/aze#12](https://github.com/tatinc23/aze/pull/12): the README repositioning (agent self-reported data,
routing, token spend, data sales). CI is green and it's mergeable. **Waiting on Ken.** It now also carries this
handoff.

---
## History (Oct 17–18 hack sessions)
## 8:26 AM PT Sun: hard rules until the demo (coordinator, Ken approved)
No pushes to main (branch + PR, Ken merges). After the 8:30 freeze, no merges or env changes on production.
SYSTEM_ONE_CF=off on purpose; leave it off. PR #6 (inkbox_send allowlist via INKBOX_SEND_ALLOW, Instabox box id
from INSTABOX_BOX_ID only) is open and merges after the demo. Both executors are still stubs.

## MORNING STATUS (written 3:40 AM PT Sun by Claude; read this first)
- **Live:** deploy #27 (main c7f02d2 + env), healthy. Proven loop + privacy gate + lean dashboard.
- **Inkbox: LIVE → Muse uses version A.** @aze (agent signup, own org) has a webhook to /inkbox/webhook.
  Verified 3:38 AM: @samantha → @aze "check GitHub" answered in <3 s with 2 advisories; CLI agent's "file" task
  stored a VERIFIED note ("filed replied" in the log). One unsigned delivery was correctly refused (401).
- **Board:** 4 test/sponsor notes hidden; 7 seed notes filed (CLI agent, 09:50 UTC).
- **NOT done: the paid loop.** Logs show only an unpaid notes_unlock (402), no settlement tonight. The stage loop
  needs the Base Sepolia TEST buyer key on the demo laptop. Ken: find it (1Password) and run
  `BUYER_PRIVATE_KEY=... npx tsx demo/agent.ts https://calm-forge-4a5qt.run.mcp-use.com/mcp` once during rehearsal.
- **Review before anything is sent:** submission kit https://claude.ai/artifact/YBR9Lj2156kRCd3kvgMHhp (private);
  Muse's M7 (ask Muse to post it to agent-field-notes#1 so Claude can claim-check it).
- **Check one note:** the VERIFIED note filed in the Inkbox test is about Inkbox signup needing a human code
  (true, and positive workaround). Keep it (good for the Inkbox track) or hide it via /admin/switch.
- Code freeze holds: no pushes to main before the demo. PR #3 (docs only) merges after the demo.

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
