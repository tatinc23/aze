# Aze: CLAUDE.md

**Aze: the bottleneck map for AI agents.** Every task, agents hit walls built for humans. Aze maps them so they can be fixed.
Show humans where AI workflows break. Better agent output through smarter tool calls. Less LLM token spend.

Big idea: learn things about AI. Thoughts already happening inside every agent task become useful once enough are
collected and sorted; Aze compiles them to find the bottlenecks and blockers so the solutions can be built.
Business ideas (parked/later): `docs/ideas/business-model.md`.

An MCP server where agents file short, privacy-gated field notes about what blocked them,
other agents query before acting and get free advisories (npm-audit style), and the full workaround is unlocked
via x402 (Base Sepolia TEST USDC). The filer earns 70% of each unlock (ledger). Built at the YC "Make Something
Agents Want" hack, Oct 17–18 2026. Hack changelog: `BUILT-AT-YC.md`. Prior work: `PRIOR-WORK.md`.

Spec + plan (planned before 10:30): tatinc23/agent-field-notes `docs/superpowers/specs/2026-10-17-paid-prior-art-design.md`,
`docs/superpowers/plans/2026-10-17-paid-prior-art-build.md`. Coordination: tatinc23/agent-field-notes issue #1.

## Start here (every session)
Read `HANDOFF.md` → `TASKS.md` → the plan. Commit + push after every task. Update HANDOFF.md before stopping.

## Team routing (Ken 2026-10-17)
Muse (Meta) owns everything without repo context: pitch, demo script, one-pager, the Inkbox-track second submission,
booth talking points, and judgment calls Claude escalates. Claude owns code, deploys and the repo. Escalate on
tatinc23/agent-field-notes#1, not through Ken.

## Live
MCP https://calm-forge-4a5qt.run.mcp-use.com/mcp · /dashboard · /connect · /docs · /qr.svg · Manufact server e5640ea8-1a70-40a5-93fe-1cecbbce358e.
Pushes to main auto-deploy (a deploy restarts the machine). Manufact autosuspends idle machines: warm with /health before demoing.

## Stack
mcp-use 2.10 `MCPServer` (Hono; `server.app` for HTTP routes) on Manufact · `@x402/mcp` 2.28 paywall on
`notes_unlock` · Supabase (`supabase-js`, service role, server only) with an in-memory store fallback ·
SubQ Snap (the only model: `agent_run` routing + the note audit) · vitest. Shared contracts: `src/types.ts`,
runtime contracts `src/runtime/types.ts`.
`agent_run` is decide-only (Ken 2026-10-20): task + the caller's tools in → map check → Snap scores the tools → chosen
tools, scores, advisories and a next step out. The caller's LLM runs the tools and answers; Aze runs no tools and writes
no answers or notes. Workers AI was removed the same day; don't bring a second model back without Ken. The SubQ chat
client stays unwired for SubQ 1.1 Small (see the SubQ gotcha below).

## Commands
- Tests: `npm test` · typecheck: `npx tsc --noEmit` · local server: `npx tsx index.ts`
- Spike/local payments: `node spike/fake-facilitator.mjs` + `X402_FACILITATOR_URL=http://localhost:4999`

## Gotchas (cost real time)
- mcp-use tool handlers get `ctx.params._meta`, not `extra._meta`. Wrap paid handlers as
  `paid(handler)(args, { _meta: ctx?.params?._meta })` or payment is never seen (proved in `spike/`).
- `@x402/mcp` does NOT settle when the handler returns `isError` or throws; write ledger rows in `onAfterSettlement`.
- MCP SDK clients validate `structuredContent` against `outputSchema` even on `isError` results (sdk 1.32
  `Client.callTool`). Every error shape a tool returns must pass its schema. `notes_unlock`'s 402 returns x402's
  payment-required object, so its schema stays a loose object. A strict one breaks auto-pay (bug shipped in #13, fixed in #15).
- The Claude cloud container's network policy blocks x402.org, sepolia.base.org, *.run.mcp-use.com, *.supabase.co
  unless Ken allowlists them. Manufact runtime logs (Manufact MCP tools) are the way to observe the live server.
- Privacy: never log or store rejected note input. Public product names are OK; repo/people/org names, emails,
  paths, IDs, private URLs are not. Never write raw notes to git.
- Newer Supabase projects don't auto-grant table privileges: migration 0002 grants service_role explicitly.
- SELFTEST_ON_BOOT=1 makes every deploy file a demo note and spend 0.05 test USDC; keep it 0 except when proving the loop.
- Wallet keys live in `.env.wallets` (gitignored, TEST ONLY). Never mainnet.
- SubQ: Ken's key has only `subq-snap-preview` (Snap: router + note audit). The SubQ chat client (`src/subq/chat.ts`,
  `SUBQ_CHAT_MODEL`) is kept UNWIRED on purpose (Ken 2026-10-20): its intended job is synthesizing filed notes into
  bottleneck reports with SubQ 1.1 Small (early access, not on the key yet). Turning it on = set `SUBQ_CHAT_MODEL`
  (adds the `subq-chat` diag) and wire the report job. Chat JSON mode is strict `json_schema`.
- `src/runtime/executors.ts`, `fetch.ts`, `mcp-client.ts` are no longer used by the pipeline (decide-only). They stay
  until Ken decides whether to delete them; tests still cover them.
- Inkbox `verifyWebhook` checks only the HMAC (no timestamp window) and THROWS on a wrong-length signature: enforce
  the 300 s window + request-id dedupe yourself, wrap in try/catch. Email sender matching is not authenticated; only
  A2A `caller` is. Never rotate signing keys on Ken's existing identities.
- Instabox is by InsForge (a sponsor). Exec caps at 600 s with buffered output; use `background: true` + files for
  longer work. Never take a box id from a caller; read it from env.
- A container restart kills running workflows (files survive). Snapshot WIP to `wip/s1-checkpoint` with a temp
  `GIT_INDEX_FILE` + `git commit-tree`, never by pushing untested work to `main` (it auto-deploys).
