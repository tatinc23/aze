// End to end over the real MCP surface: a real mcp-use server (Aze's createServer, memory store) on an ephemeral
// port, the runtime's MCP client + executors calling it, and agent_run invoked as an MCP tool.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../app.js";
import { MemoryStore } from "../store/memory.js";
import { allowedEndpoint, createExecutors, createMcpExecutor, selfMcpUrl, warehouseDetail } from "./executors.js";
import { callTool, closeAll, listTools } from "./mcp-client.js";
import { MemoryRunStore } from "./store.js";
import type { AgentContext, Asset, RuntimeDeps } from "./types.js";
import { DEFAULT_ASSETS } from "./catalog.js";

const PAYOUT = "0x4444444444444444444444444444444444444444";
const ctx: AgentContext = { agent_id: "swarm-001", swarm_id: "e2e", attestation: "unverified", payout_address: PAYOUT, machine: null, identity: null };
const asset = (id: string) => DEFAULT_ASSETS.find((a) => a.id === id)! as Asset;

let server: { listen: (p: number) => Promise<{ port: number; url: string }>; close: () => Promise<void> };
let port = 0;
const store = new MemoryStore();
const runs = new MemoryRunStore();
const runtime: RuntimeDeps = { runs, router: null, args: null, distiller: null, noteWriter: null, renderer: null, auditor: null, executors: {}, diags: [], payments: null };
let built: ReturnType<typeof createExecutors>;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("RUNTIME_ACCESS_KEY", "e2e-key");
  vi.stubEnv("MCP_USE_PHASE", "");
  server = createServer({ store, paywall: null, runtime }) as never;
  port = (await server.listen(0)).port;
  built = createExecutors({ PORT: String(port) }, store);
  runtime.executors = built.executors;
}, 20_000);

afterAll(async () => {
  await closeAll();
  await server?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("createExecutors", () => {
  it("is side-effect free and wires every executor kind", () => {
    const e = createExecutors({}, store);
    expect(Object.keys(e.executors).sort()).toEqual(["aze", "http_fetch", "inkbox", "instabox", "mcp"]);
    expect(e.diags.map((d) => d.name)).toEqual(["aze-mcp-self", "http-fetch"]);
    expect(selfMcpUrl({})).toBe("http://localhost:3000/mcp");
    expect(createExecutors({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, store).diags.map((d) => d.name)).toContain("supabase-warehouse");
  });

  it("supabase-warehouse diag detail reports counts and the jsonb wire types of the newest run", () => {
    expect(warehouseDetail(
      { data: [{ id: "notes_query" }, { id: "web_fetch" }], error: null, count: 2 },
      { data: [{ status: "done", timings: [], cost_micro_usd: "{}", notes_filed: null }], error: null, count: 7 },
    )).toEqual({
      warehouse_assets: { count: 2, ids: ["notes_query", "web_fetch"] },
      runs: { count: 7, newest: { status: "done", timings: "array", cost_micro_usd: "string", notes_filed: "null" } },
    });
    expect(warehouseDetail({ data: null, error: { message: 'relation "warehouse_assets" does not exist' } }, { data: [], error: null, count: 0 }))
      .toEqual({ warehouse_assets: { error: 'relation "warehouse_assets" does not exist' }, runs: { count: 0, newest: null } });
  });

  it("instabox/inkbox say 'not configured' without friction", async () => {
    for (const k of ["instabox", "inkbox"] as const) {
      expect(await built.executors[k]!.execute(asset(k === "instabox" ? "instabox_exec" : "inkbox_send"), {}, ctx)).toMatchObject({ ok: false, error: "not configured", friction: false });
    }
  });
});

describe("aze executor over MCP (real mcp-use server)", () => {
  it("diag aze-mcp-self lists the tools", async () => {
    const r = await built.diags.find((d) => d.name === "aze-mcp-self")!.check();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("notes_query");
    expect(r.detail).toContain("agent_run");
    expect(r.detail.length).toBeLessThanOrEqual(500);
  });

  it("files a note with the agent's payout address from ctx (never from args), and never returns it", async () => {
    const note = {
      kind: "barrier", category: "signup", surface: "Inkbox", what: "Signup waits on a code sent to a human inbox, so an unattended agent cannot finish.",
      payout_address: "0x9999999999999999999999999999999999999999", proof: "forged",
    };
    const s = await built.executors.aze!.execute(asset("notes_file"), note, ctx);
    expect(s.ok).toBe(true);
    const body = JSON.parse(s.output);
    expect(body.note_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((store as unknown as { payouts: Map<string, string> }).payouts.get(body.note_id)).toBe(PAYOUT);
    expect(s.output).not.toContain(PAYOUT);
    expect(s.output).not.toContain("0x9999");
  });

  it("queries known issues", async () => {
    const s = await built.executors.aze!.execute(asset("notes_query"), { surface: "Inkbox" }, ctx);
    expect(s.ok).toBe(true);
    expect(JSON.parse(s.output).advisories.length).toBeGreaterThanOrEqual(1);
  });

  it("reports gate rejections as a failed step with the code only", async () => {
    const s = await built.executors.aze!.execute(asset("notes_file"), { kind: "friction", category: "auth", surface: "GitHub", what: "mail jane.doe@example.com failed" }, ctx);
    expect(s).toMatchObject({ ok: false, error: "rejected_by_privacy_gate", friction: false });
  });

  it("refuses notes_unlock and agent_run", async () => {
    for (const id of ["notes_unlock", "agent_run"]) {
      const s = await built.executors.aze!.execute({ ...asset("notes_query"), id }, {}, ctx);
      expect(s).toMatchObject({ ok: false, error: `${id} is not callable by the runtime` });
    }
  });

  it("mcp executor calls asset.endpoint with tool_name; refuses non-https, private and (in production) localhost endpoints", async () => {
    const local = { ...asset("notes_score"), id: "other_score", executor: "mcp" as const, endpoint: `http://localhost:${port}/mcp`, tool_name: "notes_score" };
    const ok = await createMcpExecutor({ allowLocalhostForTests: true }).execute(local, {}, ctx);
    expect(ok.ok).toBe(true);
    expect(JSON.parse(ok.output)).toHaveProperty("scores");
    // The production executor (createExecutors) never calls localhost: no back door to Aze's own agent_run/notes_unlock.
    expect(await built.executors.mcp!.execute(local, {}, ctx)).toMatchObject({ ok: false, error: "asset has no valid https MCP endpoint" });
    for (const endpoint of ["http://203.0.113.5/mcp", "https://169.254.169.254/mcp", "https://[fd00::1]/mcp", "https://10.0.0.8/mcp", "https://user:pw@mcp.example.com/mcp", "https://mcp.internal/mcp", "https://intranet/mcp", "not a url", null]) {
      expect(await built.executors.mcp!.execute({ ...asset("notes_score"), executor: "mcp", endpoint }, {}, ctx), String(endpoint)).toMatchObject({ ok: false, error: "asset has no valid https MCP endpoint" });
    }
    expect(allowedEndpoint("https://mcp.example.com/mcp")?.toString()).toBe("https://mcp.example.com/mcp");
  });
});

describe("mcp-client", () => {
  it("never throws on a dead server and reconnects lazily after the pool is closed", async () => {
    const dead = await callTool("http://localhost:1/mcp", "notes_score", {}, { timeoutMs: 3000 });
    expect(dead).toMatchObject({ ok: false, isError: true, data: null });
    expect(dead.error).toBeTruthy();
    const url = `http://localhost:${port}/mcp`;
    expect((await callTool(url, "notes_score", {})).ok).toBe(true);
    await closeAll();
    expect((await callTool(url, "notes_score", {})).ok).toBe(true);
    expect((await listTools(url)).names).toContain("notes_file");
  });

  it("returns tool errors (isError) with parsed structured content", async () => {
    const r = await callTool(`http://localhost:${port}/mcp`, "notes_unlock", { note_id: "x" });
    expect(r).toMatchObject({ ok: false, isError: true, error: null });
    expect((r.data as { code: string }).code).toBe("paywall_unavailable");
  });
});

describe("agent_run over MCP", () => {
  it("requires the access key", async () => {
    const r = await callTool(`http://localhost:${port}/mcp`, "agent_run", { task: "t", access_key: "wrong" });
    expect((r.data as { code: string }).code).toBe("unauthorized");
  });

  it("runs the pipeline end to end: checks Aze over MCP, answers from facts, logs the run", async () => {
    const r = await callTool(`http://localhost:${port}/mcp`, "agent_run", { task: "Can an unattended agent finish signup?", surface: "Inkbox", access_key: "e2e-key" }, { timeoutMs: 20_000 });
    expect(r.ok).toBe(true);
    const out = r.data as { run_id: string; status: string; answer: string; timings: Array<{ tier: string; detail: string }> };
    expect(out.status).toBe("done");
    expect(out.timings[0]).toMatchObject({ tier: "notes", detail: expect.stringMatching(/^pre-check: \d+ advisories/) });
    expect(out.answer).toContain("Aze known issues");
    const [rec] = await runs.listRuns({ limit: 1 });
    expect(rec).toMatchObject({ id: out.run_id, status: "done", surface: "Inkbox" });
    expect((await runs.listAssets()).map((a) => a.id)).toContain("web_fetch"); // catalog seeded at registration
  });
});
