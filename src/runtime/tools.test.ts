import { describe, expect, it, vi } from "vitest";
import { createLimiter, registerRuntimeTools, RUNS_PER_HOUR, safeEqual, seedOnce } from "./tools.js";
import { MemoryRunStore } from "./store.js";
import { MemoryStore } from "../store/memory.js";
import type { AgentContext, Pipeline, RunRecord, RuntimeDeps } from "./types.js";

function fakeServer() {
  const tools = new Map<string, { def: any; cb: (args: any, ctx?: unknown) => Promise<any> }>();
  return { tools, tool: (def: any, cb: any) => { tools.set(def.name, { def, cb }); return {}; } };
}
const runtimeWith = (runs = new MemoryRunStore()): RuntimeDeps => ({
  runs, router: null, args: null, distiller: null, noteWriter: null, renderer: null, auditor: null, executors: {}, diags: [], payments: null,
});
function fakePipeline(status: RunRecord["status"] = "done") {
  const calls: Array<{ task: string; surface: string | null; ctx: AgentContext }> = [];
  const pipeline: Pipeline = {
    async run(task, surface, ctx) {
      calls.push({ task, surface, ctx });
      return {
        id: "run-1", created_at: "", agent_id: ctx.agent_id, swarm_id: null, task, surface, status, attestation: "unverified", assets: [],
        timings: [{ tier: "render", ms: 1, ok: true }], raw_bytes: 1, distilled_bytes: 1, cost_micro_usd: {}, answer: "42", notes_filed: ["n1"],
        error: status === "failed" ? "boom" : null, finished_at: "",
      };
    },
  };
  return { pipeline, calls };
}
function setup(env: NodeJS.ProcessEnv, status: RunRecord["status"] = "done", now?: () => number) {
  const server = fakeServer();
  const p = fakePipeline(status);
  registerRuntimeTools(server, { store: new MemoryStore(), runtime: runtimeWith(), env: { MCP_USE_PHASE: "build", ...env }, pipeline: p.pipeline, now });
  return { call: server.tools.get("agent_run")!.cb, def: server.tools.get("agent_run")!.def, calls: p.calls };
}

describe("agent_run tool", () => {
  it("declares a bounded input schema and honest annotations", () => {
    const { def } = setup({});
    expect(def.inputSchema.safeParse({ task: "x".repeat(501), access_key: "k" }).success).toBe(false);
    expect(def.inputSchema.safeParse({ task: "ok", surface: "s".repeat(61), access_key: "k" }).success).toBe(false);
    expect(def.inputSchema.safeParse({ task: "ok", access_key: "k" }).success).toBe(true);
    expect(def.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });

  it("is disabled (structured error) when no access key is configured", async () => {
    const { call, calls } = setup({});
    const r = await call({ task: "t", access_key: "" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ ok: false, code: "disabled" });
    expect(calls).toEqual([]);
  });

  it("rejects a wrong key and accepts RUNTIME_ACCESS_KEY or ADMIN_KEY", async () => {
    const { call, calls } = setup({ RUNTIME_ACCESS_KEY: "run-key", ADMIN_KEY: "admin-key" });
    expect((await call({ task: "t", access_key: "nope" })).structuredContent.code).toBe("unauthorized");
    expect((await call({ task: "t", access_key: "run-key-and-more" })).structuredContent.code).toBe("unauthorized");
    expect((await call({ task: "t" })).structuredContent.code).toBe("unauthorized");
    expect(calls).toEqual([]);
    const ok = await call({ task: "  Is stripe.com up?  ", surface: " Stripe ", access_key: "run-key" });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toEqual({ run_id: "run-1", status: "done", answer: "42", timings: [{ tier: "render", ms: 1, ok: true }], notes_filed: ["n1"], cost_micro_usd: {}, error: null });
    expect(JSON.parse(ok.content[0].text)).toEqual(ok.structuredContent);
    expect((await call({ task: "t", access_key: "admin-key" })).structuredContent.status).toBe("done");
    expect(calls[0]).toMatchObject({ task: "Is stripe.com up?", surface: "Stripe", ctx: { agent_id: "agent_run", payout_address: null, identity: null } });
  });

  it("a pipeline that throws becomes a structured tool error, never a thrown handler", async () => {
    const server = fakeServer();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const pipeline: Pipeline = { run: async () => { throw new Error("kaput"); } };
    registerRuntimeTools(server, { store: new MemoryStore(), runtime: runtimeWith(), env: { MCP_USE_PHASE: "build", RUNTIME_ACCESS_KEY: "k" }, pipeline });
    const r = await server.tools.get("agent_run")!.cb({ task: "t", access_key: "k" });
    err.mockRestore();
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ ok: false, code: "run_failed", hint: "The run failed before it could be logged." });
  });

  it("marks a failed run as a tool error", async () => {
    const { call } = setup({ RUNTIME_ACCESS_KEY: "k" }, "failed");
    const r = await call({ task: "t", access_key: "k" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ status: "failed", error: "boom" });
  });

  it(`allows ${RUNS_PER_HOUR} runs per hour, then rate-limits (wrong keys don't use the budget)`, async () => {
    let t = 1_000_000;
    const { call, calls } = setup({ RUNTIME_ACCESS_KEY: "k" }, "done", () => t);
    for (let i = 0; i < 5; i++) await call({ task: "t", access_key: "bad" });
    for (let i = 0; i < RUNS_PER_HOUR; i++) expect((await call({ task: "t", access_key: "k" })).structuredContent.status).toBe("done");
    const limited = await call({ task: "t", access_key: "k" });
    expect(limited.structuredContent).toMatchObject({ code: "rate_limited", retry_after_s: 3600 });
    expect(calls).toHaveLength(RUNS_PER_HOUR);
    t += 3_600_000;
    expect((await call({ task: "t", access_key: "k" })).structuredContent.status).toBe("done");
  });
});

describe("helpers", () => {
  it("safeEqual compares in constant time across lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("createLimiter is a sliding window", () => {
    let t = 0;
    const l = createLimiter(2, 1000, () => t);
    expect(l.tryAcquire().ok).toBe(true);
    t = 500;
    expect(l.tryAcquire().ok).toBe(true);
    expect(l.tryAcquire()).toEqual({ ok: false, retry_after_s: 1 });
    t = 1000;
    expect(l.tryAcquire().ok).toBe(true);
  });

  it("seedOnce seeds a store once, and never during mcp-use build", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const built = new MemoryRunStore();
    seedOnce(built, { MCP_USE_PHASE: "build" });
    await new Promise((r) => setTimeout(r, 0));
    expect(await built.listAssets()).toEqual([]);
    const runs = new MemoryRunStore();
    const up = vi.spyOn(runs, "upsertAssets");
    seedOnce(runs, {});
    seedOnce(runs, {});
    await new Promise((r) => setTimeout(r, 0));
    expect(up).toHaveBeenCalledTimes(1);
    expect((await runs.listAssets()).length).toBeGreaterThan(0);
    log.mockRestore();
  });

  it("seedOnce logs (never throws) when the store is down, and retries on the next registration", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const runs = new MemoryRunStore();
    let fail = true;
    runs.upsertAssets = async () => { if (fail) throw new Error("no table"); };
    seedOnce(runs, {});
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalledWith("[runtime] catalog seed failed:", "no table");
    fail = false;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    seedOnce(runs, {});
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toHaveBeenCalled();
    err.mockRestore();
    log.mockRestore();
  });
});
