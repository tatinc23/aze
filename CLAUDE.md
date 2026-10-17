# prior-art (working name): CLAUDE.md

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
- Wallet keys live in `.env.wallets` (gitignored, TEST ONLY). Never mainnet.
