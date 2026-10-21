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

describe("tool metadata", () => {
  it("serves the new title, a /docs websiteUrl, annotations and output schemas over tools/list", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      const info = client.getServerVersion() as Record<string, unknown>;
      expect(info.title).toBe("Aze: the bottleneck map for AI agents");
      expect(String(info.websiteUrl)).toMatch(/\/docs$/);
      const tools = (await client.listTools()).tools;
      for (const n of ["notes_file", "notes_query", "notes_unlock", "notes_score"]) {
        const t = tools.find((x) => x.name === n)!;
        expect(t, n).toBeDefined();
        expect(t.annotations?.idempotentHint, n).toBeDefined();
        expect(t.outputSchema, n).toBeDefined();
      }
      expect(tools.find((x) => x.name === "notes_unlock")!.annotations?.readOnlyHint).toBe(false);
      // success output must validate against the declared schemas (the SDK throws otherwise)
      const q = await client.callTool({ name: "notes_query", arguments: { surface: "GitHub" } });
      expect(q.isError).toBeFalsy();
      const s = await client.callTool({ name: "notes_score", arguments: {} });
      expect(s.isError).toBeFalsy();
      // SDK clients validate isError results too: every error shape a tool can return must pass its schema,
      // including x402's payment-required object, or SDK clients reject the 402 and can't pay.
      const { AjvJsonSchemaValidator } = await import("@modelcontextprotocol/sdk/validation/ajv");
      const ajv = new AjvJsonSchemaValidator();
      const ok = (tool: string, data: unknown) =>
        ajv.getValidator(tools.find((x) => x.name === tool)!.outputSchema as never)(data).valid;
      const fail = { ok: false, code: "store_unavailable", hint: "Try again." };
      expect(ok("notes_unlock", fail)).toBe(true);
      expect(ok("notes_unlock", { x402Version: 2, error: "Payment required", resource: { url: "mcp://tool/notes_unlock" }, accepts: [{ scheme: "exact" }] })).toBe(true);
      expect(ok("notes_score", fail)).toBe(true);
      expect(ok("notes_file", { ok: false, code: "rejected_by_privacy_gate", problems: [{ field: "what", rule: "email", hint: "x" }], hint: "Fix." })).toBe(true);
      const unpaid = await client.callTool({ name: "notes_unlock", arguments: { note_id: "x" } });
      expect(unpaid.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 20_000);
});
