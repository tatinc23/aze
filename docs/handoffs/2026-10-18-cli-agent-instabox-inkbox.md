# CLI-agent prompt: Inkbox + Instabox setup for Aze (S3), written 2026-10-17 ~7:50 PM PT

Ken runs this in the Claude Code CLI on his laptop (it has network; the cloud build session does not). Ken pastes the
report back to the build session. Facts behind each command: `docs/research/2026-10-18-instabox-inkbox-facts.md`.

---

You're the hands for the Aze build (Waze for agents, MCP server live at https://calm-forge-4a5qt.run.mcp-use.com,
Manufact server `e5640ea8-1a70-40a5-93fe-1cecbbce358e`). Set up Inkbox identities and Instabox computers for the demo
agents, then report. Work through the phases in order. If a phase's precondition fails, skip what depends on it and
keep going with the rest.

## Rules (all phases)
- TEST ONLY. Never print, echo, log or paste a secret (API keys, signing keys, tokens): not in chat, not in GitHub,
  not in any repo file. Load keys without echoing them (`export X="$(op read 'op://…')"` or `read -rs X && export X`).
  Save secrets you create to `~/.aze-secrets/` (mkdir -m 700; files chmod 600; outside every git repo). Print only
  non-secret fields (pipe through `jq` selecting fields; never print whole create responses).
- Don't touch anything that already exists: no stop/rm/suspend/exec on Ken's existing Instabox boxes (Sammy, art,
  tat-ops, or any other), no edits, key rotation (`signing-key rotate`) or deletes on Ken's existing Inkbox identities,
  no new subscriptions on them. Rotating an identity's signing key breaks the agents that already use it.
- Don't send any email or SMS except the one test send in Phase 2 step 6.
- Manufact env vars go on server `e5640ea8-1a70-40a5-93fe-1cecbbce358e` (production), set the same way you set the
  other secrets tonight. Feed values from `~/.aze-secrets/` files, never typed or echoed. Don't start a deploy yourself.
- No PRs, no edits to the aze repo's `src/`. When unsure about something destructive, stop and ask Ken.

## Phase 1: Inkbox keys (read-only)
1. `npm i -g @inkbox/cli@0.7.19` (needs Node ≥ 22; check `node --version`).
2. For EACH of Ken's 3 Inkbox keys: load it as `INKBOX_API_KEY`, then
   `inkbox --json whoami | jq '{authType, authSubtype, scope, organizationId}'` and
   `inkbox --json identity list | jq '[.[] | {handle, id}]'`.
3. Ask Ken what the "100 agents on standby" from the Inkbox team are: an org with an identity quota, an invite or
   promo, or 100 existing identities with keys? Which org/console?
4. Decide: is there an **admin-scoped** key (`authSubtype: "api_key.admin_scoped"`) for the org that should hold Aze and
   the demo agents? If none, Ken creates one in the Inkbox console (API keys page; the API can't mint admin keys).
   Put it in `~/.aze-secrets/inkbox-admin.key`. If there is still no admin key, skip Phases 2, 3 and 5.

## Phase 2: Aze's own Inkbox identity (needs the admin key)
1. `inkbox --json identity create aze --display-name "Aze"` (if the handle is taken: `aze-map`, then `aze-notes`).
   Print `{handle, id, email}` (email field: `.emailAddress // .mailbox.emailAddress`).
2. Mint its agent-scoped key: `inkbox --json api-keys create --label aze-server --identity-id <aze id>` →
   `jq -r .apiKey > ~/.aze-secrets/inkbox-aze.key`. Then with THAT key:
   `inkbox --json whoami | jq '{authSubtype, scope}'` (report whether it's `api_key.agent_scoped.claimed`; A2A needs it).
3. With the aze key: `inkbox a2a enable -i <aze handle>` then
   `inkbox --json a2a settings -i <aze handle> | jq '{cardUrl, enabled}'` (report the card URL; it's public).
4. Webhook (admin key): `openssl rand -hex 32 > ~/.aze-secrets/inkbox-webhook.token`, then
   ```
   inkbox --json webhook subscription create --agent-identity-id <aze id> \
     --url https://calm-forge-4a5qt.run.mcp-use.com/webhooks/inkbox \
     --event-type message.received --event-type a2a.task.created --event-type a2a.task.message \
     --auth-token-stdin < ~/.aze-secrets/inkbox-webhook.token > ~/.aze-secrets/inkbox-sub.json
   jq '{id, ownerIdentityId, gotSigningKey: (.signingKey != null)}' ~/.aze-secrets/inkbox-sub.json
   jq -r .signingKey ~/.aze-secrets/inkbox-sub.json > ~/.aze-secrets/inkbox-signing.key
   ```
   If mixed mail + A2A events are refused, create two subscriptions (mail; then the a2a.* events). Only the first
   returns a signingKey. Deliveries 404 until Aze ships the route; that's expected, don't debug it.
5. Manufact env: `INKBOX_SIGNING_KEY` ← inkbox-signing.key, `INKBOX_WEBHOOK_TOKEN` ← inkbox-webhook.token,
   `INKBOX_AZE_KEY` ← inkbox-aze.key, `INKBOX_AZE_HANDLE` = the handle (not secret).
6. One test send, to prove one admin key can send as any org identity: with the ADMIN key,
   `inkbox --json email send -i <aze handle> --to <Ken's own inbox> --subject "Aze test" --body-text "admin-key send test" | jq '{id, status}'`.
   Report whether it worked (or the exact error).

## Phase 3: two demo-agent identities (needs the admin key)
Handles `aze-scout` and `aze-buyer` (placeholders until Ken/Muse names them). For each:
`identity create` → mint an agent-scoped key (`--label <handle>`, `--identity-id`) → save to
`~/.aze-secrets/inkbox-<handle>.key` → `whoami` with it (report authSubtype). Don't put these on Manufact; they go on
the Instabox boxes later.

## Phase 4: Instabox (needs Ken's Instabox sign-in)
1. `instabox --version`, `instabox whoami`, `instabox usage --json` (report the box limit and usage),
   `instabox ls` (report names and states only; touch none of them).
2. Paste verbatim (the CLI source is private, so this is our only reference): `instabox help`,
   `instabox exec --help`, `instabox port --help`, `instabox keys --help`, `instabox create --help`.
3. Server key: create an Instabox API key for the Manufact server (dashboard API Keys page or `instabox keys create`;
   scopes machines:read + machines:write if scopes are offered, NOT delete). Save it to `~/.aze-secrets/instabox.key`
   and check the prefix without printing it: `[[ $(cat ~/.aze-secrets/instabox.key) == ibk_* ]] && echo prefix-ok`.
   Set Manufact env `INSTABOX_API_KEY` from it (replace the current value if it isn't an `ibk_` key).
4. Two boxes, if usage allows (else report and skip):
   ```
   instabox create --name aze-scout --template agent-browser --auto-suspend 30m --meta app=aze --meta role=scout --no-vault
   instabox create --name aze-buyer --template universal     --auto-suspend 30m --meta app=aze --meta role=buyer --no-vault
   ```
   (`--no-vault` keeps Ken's personal vault secrets off these boxes.) Get each box id (`m_…`) from `instabox get <name>`
   and set Manufact env `INSTABOX_SCOUT_ID` and `INSTABOX_BUYER_ID` (not secret).
5. On each new box: `instabox exec <box> -- 'node --version; whoami; head -40 ~/MACHINE.md'` and egress checks
   (status codes only):
   `instabox exec <box> -- 'for u in https://calm-forge-4a5qt.run.mcp-use.com/api/health https://x402.org/facilitator/supported https://sepolia.base.org https://inkbox.ai https://api.subq.ai/v1/models; do printf "%s %s\n" "$(curl -s -o /dev/null -w "%{http_code}" -m 10 $u)" $u; done'`
   (Node must be ≥ 22 for the Inkbox SDK; if lower, report it, don't upgrade yet.)

## Phase 5: the 100 swarm identities (ONLY after Ken says "go" in this session)
With the admin key, create `aze-a001` … `aze-a100` (display names "Aze agent 001" …), sleeping 1 s between creates and
stopping at the first quota or rate-limit error. For each, mint an agent-scoped key and collect
`{"<handle>": "<key>"}` into `~/.aze-secrets/inkbox-swarm.json` (chmod 600). Report the count created and the
first error, if any. Don't set this on Manufact yet; the build session will choose how to load it.

## Report (paste back to Ken; no secrets anywhere in it)
```
INKBOX
- key 1/2/3: authSubtype, organizationId (same org? y/n), identity handles
- the "100 agents": what they are
- admin key: available? same org as Aze?
- aze identity: handle, email, id, a2a cardUrl, aze key authSubtype, subscription id(s), signingKey captured y/n
- Manufact env set: INKBOX_SIGNING_KEY / INKBOX_WEBHOOK_TOKEN / INKBOX_AZE_KEY / INKBOX_AZE_HANDLE (y/n each)
- admin-key test send as aze: ok / exact error
- scout/buyer identities: handle, email, id, key authSubtype
- swarm (if run): created N/100, first error
INSTABOX
- CLI version, account, usage/limit
- existing boxes: names only (untouched)
- new boxes: name, id, template, state, node version, whoami, MACHINE.md network/ports lines, egress status codes
- INSTABOX_API_KEY on Manufact: prefix-ok y/n, scopes chosen
- help output (verbatim): help, exec, port, keys, create
ERRORS / BLOCKERS: exact text
```
