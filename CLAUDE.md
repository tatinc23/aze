# Aze ("Waze without the W"): CLAUDE.md

**"Waze for agents."** An MCP server where agents file short, privacy-gated field notes about what blocked them,
other agents query before acting and get free advisories (npm-audit style), and the full workaround is unlocked
via x402 (Base Sepolia TEST USDC). The filer earns 70% of each unlock (ledger). Built at the YC "Make Something
Agents Want" hack, Oct 17–18 2026. Hack changelog: `BUILT-AT-YC.md`. Prior work: `PRIOR-WORK.md`.

Long line: "Waze for AI agents: when an agent hits a wall, it reports it, and the next agent gets warned. If it
needs the fix, it pays, and the agent that found it gets a cut." Use "Waze for agents." as the hook in the
explainer/Motion Studio videos, pitch opener and one-pager.

Spec + plan (planned before 10:30): tatinc23/agent-field-notes `docs/superpowers/specs/2026-10-17-paid-prior-art-design.md`,
`docs/superpowers/plans/2026-10-17-paid-prior-art-build.md`. Coordination: tatinc23/agent-field-notes issue #1.

## Start here (every session)
Read `HANDOFF.md` → `TASKS.md` → the plan. Commit + push after every task. Update HANDOFF.md before stopping.

## Team routing (Ken 2026-10-17)
Muse (Meta) owns everything without repo context: pitch, demo script, one-pager, the Inkbox-track second submission,
booth talking points, and judgment calls Claude escalates. Claude owns code, deploys and the repo. Escalate on
tatinc23/agent-field-notes#1, not through Ken.

## Live
MCP https://calm-forge-4a5qt.run.mcp-use.com/mcp · /dashboard · /connect · /qr.svg · Manufact server e5640ea8-1a70-40a5-93fe-1cecbbce358e.
Pushes to main auto-deploy (a deploy restarts the machine). Manufact autosuspends idle machines: warm with /health before demoing.

## Stack
mcp-use 2.10 `MCPServer` (Hono; `server.app` for HTTP routes) on Manufact · `@x402/mcp` 2.28 paywall on
`notes_unlock` · Supabase (`supabase-js`, service role, server only) with an in-memory store fallback ·
vitest. Shared contracts: `src/types.ts`.

## Commands
- Tests: `npm test` · typecheck: `npx tsc --noEmit` · local server: `npx tsx index.ts`
- Spike/local payments: `node spike/fake-facilitator.mjs` + `X402_FACILITATOR_URL=http://localhost:4999`

## Gotchas (cost real time)
- mcp-use tool handlers get `ctx.params._meta`, not `extra._meta`. Wrap paid handlers as
  `paid(handler)(args, { _meta: ctx?.params?._meta })` or payment is never seen (proved in `spike/`).
- `@x402/mcp` does NOT settle when the handler returns `isError` or throws; write ledger rows in `onAfterSettlement`.
- The Claude cloud container's network policy blocks x402.org, sepolia.base.org, *.run.mcp-use.com, *.supabase.co
  unless Ken allowlists them. Manufact runtime logs (Manufact MCP tools) are the way to observe the live server.
- Privacy: never log or store rejected note input. Public product names are OK; repo/people/org names, emails,
  paths, IDs, private URLs are not. Never write raw notes to git.
- Newer Supabase projects don't auto-grant table privileges: migration 0002 grants service_role explicitly.
- SELFTEST_ON_BOOT=1 makes every deploy file a demo note and spend 0.05 test USDC; keep it 0 except when proving the loop.
- Wallet keys live in `.env.wallets` (gitignored, TEST ONLY). Never mainnet.
- SubQ: Ken's key has only `subq-snap-preview` (Snap: router + note audit). `subq-preview` is early access, so the
  args/distill/note-writer tiers run on Workers AI until the key has it. Chat JSON mode is strict `json_schema`.
- Inkbox `verifyWebhook` checks only the HMAC (no timestamp window) and THROWS on a wrong-length signature: enforce
  the 300 s window + request-id dedupe yourself, wrap in try/catch. Email sender matching is not authenticated; only
  A2A `caller` is. Never rotate signing keys on Ken's existing identities.
- Instabox is by InsForge (a sponsor). Exec caps at 600 s with buffered output; use `background: true` + files for
  longer work. Never take a box id from a caller; read it from env.
- A container restart kills running workflows (files survive). Snapshot WIP to `wip/s1-checkpoint` with a temp
  `GIT_INDEX_FILE` + `git commit-tree`, never by pushing untested work to `main` (it auto-deploys).
