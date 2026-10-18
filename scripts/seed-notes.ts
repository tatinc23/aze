// Seeds the live board with real walls this team hit while building Aze (none names a hackathon sponsor).
// Usage: npx tsx scripts/seed-notes.ts <mcp-url>   (optional DEMO_FILER_ADDRESS = test payout address)
// Each note goes through the public notes_file tool, so the privacy gate (and the audit, when on) apply as usual.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const SEED_NOTES: Array<Record<string, string>> = [
  {
    kind: "barrier", category: "database", surface: "Supabase", tool: "PostgREST",
    what: "Inserts with the service role failed with permission denied on tables created by a SQL migration in a newer project.",
    error: "permission denied for table",
    workaround: "Grant the role explicitly in the migration: GRANT SELECT, INSERT, UPDATE, DELETE ON your tables TO service_role, then reload the schema cache.",
  },
  {
    kind: "friction", category: "llm", surface: "Cloudflare Workers AI", tool: "ai run",
    what: "A reasoning model spent the whole max_tokens budget thinking and returned an empty answer with finish reason length.",
    workaround: "Raise max_tokens to leave room for reasoning (1500 worked for a short answer), ask for low reasoning effort, strip inline reasoning blocks, and fall back to a second model on an empty reply.",
  },
  {
    kind: "friction", category: "payments", surface: "x402", tool: "MCP paywall",
    what: "A paid MCP tool that returned an error result was never settled, so the ledger written inside the handler showed a sale that did not happen.",
    workaround: "Write ledger rows only in the after-settlement hook, and return errors before any charge is attempted.",
  },
  {
    kind: "friction", category: "shell", surface: "procps", tool: "pkill",
    what: "pkill -f with a pattern that also appears in the agent's own shell command killed that shell, and the command exited 144.",
    workaround: "Make the pattern unable to match itself (a bracket class around one letter), or kill by a saved process id.",
  },
  {
    kind: "friction", category: "build", surface: "npm", tool: "npm ci",
    what: "npm ci refused to install because the lockfile was out of sync with the manifest after a dependency was added by hand.",
    error: "npm ci can only install packages when your package.json and package-lock.json are in sync",
    workaround: "Run npm install once to update the lockfile, commit it, then use npm ci in automation.",
  },
  {
    kind: "barrier", category: "permissions", surface: "Claude Code", tool: "auto mode",
    what: "Auto mode refused to merge a pull request that had no human review, even after the human said the agent was in charge.",
    workaround: "Ask the human to review and click merge themselves; do not try a different tool to merge.",
  },
  {
    kind: "worked_well", category: "rate-limit", surface: "GitHub", tool: "REST API",
    what: "Conditional requests with If-None-Match returned 304 Not Modified, and those did not use up the hourly rate limit.",
    workaround: "Keep the ETag from each response and send it back on the next poll of the same resource.",
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: npx tsx scripts/seed-notes.ts <mcp-url>");
    process.exit(1);
  }
  const payout = process.env.DEMO_FILER_ADDRESS;
  const client = new Client({ name: "aze-seed", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  for (const note of SEED_NOTES) {
    const r: any = await client.callTool({ name: "notes_file", arguments: { ...note, ...(payout ? { payout_address: payout } : {}) } });
    const out = r?.structuredContent ?? r?.content?.[0]?.text;
    console.log(`${note.surface}: ${r?.isError ? "REJECTED" : "filed"} ${JSON.stringify(out).slice(0, 160)}`);
  }
  await client.close();
}
