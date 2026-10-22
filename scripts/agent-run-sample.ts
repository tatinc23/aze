// Prints one local agent_run result: Aze's server in memory on an ephemeral port, one note filed through notes_file,
// then agent_run over MCP with three candidate tools. With SUBQ_API_KEY set, SubQ Snap decides for real; with
// SAMPLE_FAKE_SNAP=1 a fixed-score stand-in decides (labelled as such in the output); with neither, the run shows the
// "Snap unavailable" shape. Nothing touches Supabase or the live server.
// Usage: SUBQ_API_KEY=... npx tsx scripts/agent-run-sample.ts   (or SAMPLE_FAKE_SNAP=1 npx tsx scripts/agent-run-sample.ts)
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import { buildRuntime } from "../src/runtime/deps.js";
import type { Router } from "../src/runtime/types.js";

/** Fixed scores, for showing the result shape without a SubQ key. Never used by the server. */
const FIXED: Record<string, number> = { "github.search_code": 0.9, web_fetch: 0.35, "calendar.create_event": 0.02 };
const fakeSnap: Router = {
  label: "fixed-score stand-in (not Snap)",
  async route(_task, candidates) {
    return { choices: candidates.map((c) => ({ asset_id: c.id, p: FIXED[c.id] ?? 0 })), ms: 1, usage: { input_tokens: 600, output_tokens: 0 } };
  },
};

const key = randomBytes(16).toString("hex");
process.env.RUNTIME_ACCESS_KEY = key;
process.env.MCP_USE_PHASE = "build"; // skip the catalog seed: this run brings its own tools
const fake = process.env.SAMPLE_FAKE_SNAP === "1";
const built = buildRuntime({ SUBQ_API_KEY: fake ? "" : process.env.SUBQ_API_KEY ?? "", SUBQ_AUDIT: "off" });
const runtime = fake ? { ...built, router: fakeSnap } : built;
const server = createServer({ store: new MemoryStore(), paywall: null, runtime }) as unknown as { listen: (p: number) => Promise<{ port: number }>; close: () => Promise<void> };
const { port } = await server.listen(0);
const client = new Client({ name: "agent-run-sample", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
try {
  await client.callTool({ name: "notes_file", arguments: {
    kind: "barrier", category: "rate-limit", surface: "GitHub", tool: "github.search_code",
    what: "Code search returns 403 after a few unauthenticated calls in a row.",
  } });
  const r = await client.callTool({ name: "agent_run", arguments: {
    task: "Find where the retry logic is implemented in the public octokit/request.js repository.",
    surface: "GitHub",
    tools: [
      { name: "github.search_code", description: "Search code across public GitHub repositories and return matching files." },
      { name: "web_fetch", description: "Fetch one public web page over HTTPS and return its readable text." },
      { name: "calendar.create_event", description: "Create an event on the user's calendar.", surface: "Google Calendar" },
    ],
    access_key: key,
  } });
  console.log(JSON.stringify({ snap: fake ? "fixed-score stand-in (SAMPLE_FAKE_SNAP=1)" : runtime.router ? "SubQ Snap (live)" : "none (no SUBQ_API_KEY)", isError: r.isError ?? false, result: r.structuredContent }, null, 2));
} finally {
  await client.close();
  await server.close();
  process.exit(0);
}
