# Hackathon skill candidates (one line per repeated friction; turn the top ones into skills at the end)

- 2026-10-17: Cloud container network policy silently blocks payment/deploy hosts (x402.org, Manufact app URLs); check `$HTTPS_PROXY/__agentproxy/status` first and ask for the allowlist up front.
- 2026-10-17: Library A's handler-context shape ≠ library B's expectation (mcp-use ctx.params._meta vs MCP SDK extra._meta); spike the seam with a local fake before building on it.
- 2026-10-17: Repo named in a kickoff prompt didn't exist yet; confirm build-repo existence before planning around it.
- 2026-10-17: Boot self-tests must call the container itself (localhost), not the public URL: during rollout the public URL still routes to the previous deployment, so results are about the wrong build.
- 2026-10-17: Log success honestly: "paymentMade" ≠ settled. Print the settlement receipt (success, errorReason, payer, tx) and the payer's balance before paying.
- 2026-10-17: A missing DB migration shows up only on first query; check the schema at boot and log "NOT ready" loudly.
- 2026-10-17: Quote heredocs (<<'EOF') whenever the body has backticks or $; an unquoted one executed doc text as commands.
