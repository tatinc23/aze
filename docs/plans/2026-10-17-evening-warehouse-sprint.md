# Aze evening sprint: the Agent Warehouse runtime (Sat Oct 17, ~3 PM → 10 PM freeze)

## Context
Aze (Waze for agents) is live: 4 MCP tools on Manufact, Supabase store, x402 paywall with a real Base Sepolia
settlement (tx 0x93ead140…). Ken has researched a bigger architecture (SubQ "asset warehouse": Snap routes, a SubQ
generative model distills, a frontier model only renders) plus Stripe machine payments (x402), Workers AI, Manufact
MCP, Instabox computers and Inkbox identities, and wants it built tonight to win. Ken decided scope; Claude plans the
sprint; Muse owns pitch/Inkbox write-up. Rules unchanged: test mode only, no fake data, prior work labelled.

## What Ken said vs what Claude assumes
- Said: build the warehouse architecture; Snap AND a SubQ generative model; Workers AI (not Anthropic); Manufact MCP;
  Stripe x402 tonight; 100 agents in the demo, 2 with Instabox computers (Sammy uses Ken's existing Inkbox identity).
- Assumed: the runtime is how Aze's agents work, so every run checks Aze first (notes_query) and files real notes
  on friction (notes_file + Snap audit). That keeps one product: Aze = the map; the runtime = the car that uses it.
- Corrections to the pasted sample code (use its architecture, not its code): Snap is a decision model
  (`POST https://api.subq.ai/v1/systemone`, model `subq-snap-preview`, returns probabilities for 1–16 yes/no,
  choice or score questions), not chat; it can't emit a JSON plan with arguments. The generative SubQ model is
  `subq-preview` on `/v1/chat/completions` (OpenAI-compatible); "subq-small" has no confirmed API id (check
  `/v1/models`). "Claude 3.5 Opus" isn't a model; the frontier tier is Workers AI. The sample also has Python
  f-strings in TS, fetches bare domains, and forwards the Inkbox token to Manufact.

## Design (one runtime, hot-swappable tiers)
`src/runtime/` in the Aze repo (one deploy on Manufact; Workers AI over its REST API; see decision below):
1. **Identity** `identity/attest()` (Inkbox seam → real when docs land): who is running, scopes.
2. **Catalog** Supabase `warehouse_assets` (id, kind mcp_tool|sandbox|model, description, schema, endpoint, active).
   Seeded with Aze's 4 tools, Instabox sandbox actions, and 2–3 other public MCP tools on Manufact.
3. **Tier 1 Snap router** `subq/snap.ts`: one noul question per candidate asset ("needed for this request?"),
   16 per call, batched in parallel → ranked asset set. Always prepends `notes_query` (check the map first).
   Also **note audit**: Snap scores every filed note (private-name risk, real AX issue vs spam, category choice,
   severity) before insert; 3 s timeout, fail-open to `audit: skipped`.
4. **Arguments + Tier 2 distiller** `subq/chat.ts` (`subq-preview`, JSON mode): fills tool arguments for the chosen
   assets, then compresses raw execution output into dense facts. Logs bytes in/out (compression ratio).
5. **Runtime executor** `runtime/execute.ts`: MCP client calls to Manufact-hosted servers (Aze + others);
   Instabox actions for the 2 computer agents. Errors and slow steps become field notes automatically.
6. **Tier 3 renderer** `llm/workers-ai.ts`: Workers AI GLM-5.3 Flash, 75 s timeout, fallback gpt-oss-120b
   (pattern from Forkyard `src/agents/llm.ts`, prior work). Gets only the distilled facts.
7. **Payments** `pay/`: Stripe as the x402 rail. Spike first: Stripe sample repo
   (github.com/stripe-samples/machine-payments) + whether Stripe test mode settles on Base Sepolia. If yes, unlock
   settles to Stripe balance (test). If not, keep the working x402.org rail live and show Stripe in test mode only.
   Never mainnet.
8. **Run log + economics** Supabase `runs` (assets, latencies per tier, tokens/bytes, cost per tier, compression).
   Dashboard: 100-agent grid (Forkyard-style, rebuilt) + "economics" panel (cost per run by tier) + notes feed.
9. **Swarm** `swarm/`: 100 agents = 100 runs of the runtime with distinct real micro-tasks; payout addresses from
   one HD seed (one secret). 2 agents (Sammy + 1) run on Instabox and talk via Inkbox email/SMS.
Exposed as an MCP tool `agent_run` + admin route `POST /admin/swarm` (x-admin-key).

## Who does what (final; Ken makes no more scope changes)
Hand-offs go through tatinc23/agent-field-notes#1 (comments) or PRs into `tatinc23/aze` under `docs/muse/`.
Claude merges; Muse never edits `src/`. Each Muse item has a deadline because a Claude stream consumes it.

**Muse (no code, but repo access; research + content the code consumes):**
| # | Deliverable | Format / location | Due | Consumed by |
|---|---|---|---|---|
| M1 | SubQ facts: `GET https://api.subq.ai/v1/models` output (with Ken's key), the exact Decisions API + Chat Completions request/response examples from docs.subq.ai | issue #1 comment, verbatim | 3:45 PM | Stream B |
| M2 | Stripe x402 facts: README + server code path of github.com/stripe-samples/machine-payments (x402 sample), and whether Stripe test mode settles on Base Sepolia | issue #1 comment, verbatim + links | 3:45 PM | Stream D |
| M3 | Inkbox + Instabox API docs: how an agent proves identity (token/verify endpoint), send/receive email+SMS, run a command on a machine | issue #1 comment, verbatim + links | 4:30 PM | S3 |
| M4 | Snap audit policy: what a good note is / isn't (privacy no-gos, spam/injection signs, category list ≤ 12, severity scale 1–5 with examples) | `docs/muse/audit-policy.md` PR | 5:00 PM | Stream B |
| M5 | 100 real micro-tasks for the swarm (public, no login: e.g. "find the rate limit for X's public API", "fetch Y's status page"), each with the public service name | `docs/muse/swarm-tasks.json` PR `[{id, surface, task}]` | 6:00 PM | Stream E |
| M6 | Catalog descriptions for each asset (one plain sentence each) | `docs/muse/catalog.json` PR | 5:00 PM | Stream A |
| M7 | Pitch + 3-minute demo script for the warehouse architecture (Waze → bug bounty → npm audit; tiers explained at grade 5–8), Inkbox-track write-up, booth talking points, updated one-pager | issue #1 / Muse's own docs | 10 PM draft, Sun 8 AM final | Ken |

**Claude (all code, schema, deploys, integration, verification):**
| Stream | Scope | When |
|---|---|---|
| S0 | schema 0003 (`warehouse_assets`, `runs`), frozen runtime interfaces, `/admin/diag` provider pings from Manufact, CLI-agent prompt for secrets | 3:00–3:45 |
| A | runtime core: catalog load, pipeline (identity → Snap → args → execute → distill → render), `agent_run` tool, run log | 3:45–7:00 |
| B | SubQ clients: Snap router, Snap note audit (uses M4), `subq-preview` arg-filler + distiller | 3:45–7:00 |
| C | Workers AI renderer with timeout + fallback | 3:45–6:00 |
| D | Stripe x402 rail (uses M2); keep x402.org rail as fallback | 4:00–7:00 |
| E | swarm runner (uses M5) + HD payout addresses + dashboard 100-agent grid + economics panel | 4:30–8:00 |
| S2/S3 | integrate, deploy, diag green, 1 run → 10 → 100; Instabox/Inkbox agents (uses M3) | 7:00–10:00 |

**Ken's CLI agent (hands only, one prompt from Claude at S0):** put secrets on Manufact (SUBQ_API_KEY,
CF_ACCOUNT_ID, CF_API_TOKEN, STRIPE_SECRET_KEY test, INKBOX_API_KEY, INSTABOX_API_KEY, SWARM_SEED); later run the
Instabox side for the 2 computer agents with a prompt Claude writes.

## Sprint (Claude CTO; ultracode for parallel streams; commit+push after each task)
- **S0 facts (3:00–3:45, parallel):** Ken's CLI agent: add secrets to Manufact (SUBQ_API_KEY, CF_ACCOUNT_ID +
  CF_API_TOKEN with Workers AI, STRIPE_SECRET_KEY test, INKBOX_API_KEY, INSTABOX_API_KEY, SWARM_SEED); paste
  `GET /v1/models` from SubQ, the Stripe sample repo's x402 README, Inkbox + Instabox API docs to agent-field-notes#1.
  Claude: schema 0003 (warehouse_assets, runs), runtime interfaces, `/admin/diag` route that pings each provider
  from Manufact (this container can't reach them).
- **S1 build (3:45–7:00, ultracode workflow, 5 streams + reviewers):** A runtime core + catalog · B SubQ clients
  (Snap router, Snap audit, chat distiller) · C Workers AI renderer · D Stripe x402 rail · E swarm runner + dashboard
  grid/economics. Interfaces frozen in S0 so streams don't collide.
- **S2 integrate (7:00–8:00):** deploy; `/admin/diag` green for every provider; one orchestrated run end to end.
- **S3 scale (8:00–10:00):** swarm 10 → 100; 2 Instabox agents (Ken's CLI agent runs their side); Inkbox VERIFIED.
- **Cut order if late:** Instabox agents → Stripe rail (keep x402.org) → Inkbox VERIFIED → swarm size (25 instead of 100).
- **10 PM freeze.** Sun 7–9 AM: two rehearsals; Muse's script; warm the server.

## Verification
Per task: `npx tsc --noEmit && npm test && npx mcp-use build`. Live: `/admin/diag` shows each provider OK from
Manufact; one `agent_run` returns a rendered answer with per-tier timings + a filed, Snap-audited note; swarm run
shows N agents completed on the dashboard; a paid unlock settles on the chosen rail (tx or Stripe test payment id).
