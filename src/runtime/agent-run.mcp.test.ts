// agent_run end to end over the real MCP surface: Aze's createServer (memory store) on an ephemeral port, the official
// MCP SDK client (which validates structuredContent against the advertised outputSchema), and a fake Snap router.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../app.js";
import { MemoryStore } from "../store/memory.js";
import { MemoryRunStore } from "./store.js";
import type { Router, RuntimeDeps } from "./types.js";

const store = new MemoryStore();
const runs = new MemoryRunStore();
const route = vi.fn<Router["route"]>(async (_task, candidates) => ({
  choices: candidates.map((c) => ({ asset_id: c.id, p: c.id === "github.search_code" ? 0.88 : 0.07 })),
  ms: 3,
  usage: { input_tokens: 900, output_tokens: 0 },
}));
const runtime: RuntimeDeps = { runs, router: { label: "SubQ Snap (test)", route }, auditor: null, diags: [], payments: null };
let server: { listen: (p: number) => Promise<{ port: number }>; close: () => Promise<void> };
let url = "";
let client: any;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("RUNTIME_ACCESS_KEY", "e2e-key");
  vi.stubEnv("MCP_USE_PHASE", "");
  server = createServer({ store, paywall: null, runtime }) as never;
  url = `http://localhost:${(await server.listen(0)).port}/mcp`;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
}, 20_000);

afterAll(async () => {
  await client?.close();
  await server?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("agent_run over MCP", () => {
  it("lists agent_run with an output schema", async () => {
    const t = (await client.listTools()).tools.find((x: { name: string }) => x.name === "agent_run");
    expect(t.outputSchema?.properties).toHaveProperty("chosen");
    expect(t.inputSchema.required).toEqual(expect.arrayContaining(["task", "tools", "access_key"]));
  });

  it("requires the access key", async () => {
    const r = await client.callTool({ name: "agent_run", arguments: { task: "t", tools: [{ name: "a", description: "b" }], access_key: "wrong" } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.code).toBe("unauthorized");
    expect(route).not.toHaveBeenCalled();
  });

  it("files a note, then returns Snap's pick with that note as an advisory (schema-valid), and logs the run", async () => {
    const filed = await client.callTool({ name: "notes_file", arguments: {
      kind: "barrier", category: "rate-limit", surface: "GitHub", tool: "github.search_code", what: "Code search returns 403 after a few unauthenticated calls",
    } });
    const note_id = filed.structuredContent.note_id;
    expect(note_id).toBeTruthy();

    const r = await client.callTool({ name: "agent_run", arguments: {
      task: "Find where the retry logic lives in a public repository",
      surface: "GitHub",
      tools: [
        { name: "github.search_code", description: "Search code across public GitHub repositories." },
        { name: "calendar.create_event", description: "Create an event on the user's calendar.", surface: "Google Calendar" },
      ],
      access_key: "e2e-key",
    } });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent;
    expect(out).toMatchObject({
      status: "done", decided_by: "SubQ Snap (test)", chosen: [{ tool: "github.search_code", p: 0.88 }],
      scores: [{ tool: "github.search_code", p: 0.88 }, { tool: "calendar.create_event", p: 0.07 }],
      advisories: [{ note_id, surface: "github", tool: "github.search_code", kind: "barrier" }],
      cost_micro_usd: { snap: 45 }, error: null,
    });
    expect(out.next).toMatch(/^Aze does not run tools: call github\.search_code yourself/);
    expect(Object.keys(out)).not.toContain("answer");
    const [rec] = await runs.listRuns({ limit: 1 });
    expect(rec).toMatchObject({ id: out.run_id, status: "done", surface: "GitHub", assets: [{ asset_id: "github.search_code", p: 0.88 }], answer: null });
  }, 20_000);
});
