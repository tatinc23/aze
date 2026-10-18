// notes_file's Snap audit is a paid call on a public tool: a server-wide cap, and over it nothing is stored unaudited.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "./app.js";
import { MemoryStore } from "./store/memory.js";
import { MemoryRunStore } from "./runtime/store.js";
import { callTool, closeAll } from "./runtime/mcp-client.js";
import type { RuntimeDeps } from "./runtime/types.js";

const store = new MemoryStore();
const audit = vi.fn(async () => ({ status: "ok" as const, p_private: 0, p_real_issue: 1, category: "docs", severity: 1, model: "fake", ms: 1, reason: null }));
const runtime: RuntimeDeps = {
  runs: new MemoryRunStore(), router: null, args: null, distiller: null, noteWriter: null, renderer: null,
  auditor: { audit }, executors: {}, diags: [], payments: null,
};
let server: { listen: (p: number) => Promise<{ port: number }>; close: () => Promise<void> };
let url = "";

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("MCP_USE_PHASE", "");
  server = createServer({ store, paywall: null, runtime, auditsPerMinute: 2 }) as never;
  url = `http://localhost:${(await server.listen(0)).port}/mcp`;
}, 20_000);
afterAll(async () => {
  await closeAll();
  await server?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("notes_file audit limit", () => {
  it("audits up to the cap, then refuses with busy and stores nothing", async () => {
    const note = (i: number) => ({ kind: "friction", category: "docs", surface: "GitHub", what: `docs page slow to load, case ${i}` });
    const ok1 = await callTool(url, "notes_file", note(1), { idempotent: false });
    const ok2 = await callTool(url, "notes_file", note(2), { idempotent: false });
    expect([ok1.isError, ok2.isError]).toEqual([false, false]);
    expect((await store.stats()).notes).toBe(2);
    const third = await callTool(url, "notes_file", note(3), { idempotent: false });
    expect(third.isError).toBe(true);
    expect(third.data).toMatchObject({ ok: false, code: "busy" });
    expect(audit).toHaveBeenCalledTimes(2);
    expect((await store.stats()).notes).toBe(2);
  }, 20_000);
});
