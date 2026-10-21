// Free mode (PAID_UNLOCKS not on): workarounds ride on notes_query, notes_unlock needs no paywall.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "./app.js";
import { MemoryStore } from "./store/memory.js";

const store = new MemoryStore();
let server: { listen: (p: number) => Promise<{ port: number }>; close: () => Promise<void> };
let paid: typeof server;
let url = "";
let paidUrl = "";
let noteId = "";
const WORKAROUND = "Poll the inbox every five seconds instead of one second.";

async function connect(u: string) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(u)));
  return client;
}
const sc = (r: unknown) => (r as { structuredContent: any }).structuredContent;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("MCP_USE_PHASE", "");
  server = createServer({ store, paywall: null, freeUnlocks: true }) as never;
  paid = createServer({ store, paywall: null }) as never;
  url = `http://localhost:${(await server.listen(0)).port}/mcp`;
  paidUrl = `http://localhost:${(await paid.listen(0)).port}/mcp`;
  const c = await connect(url);
  const f = await c.callTool({ name: "notes_file", arguments: { kind: "workaround", category: "rate-limit", surface: "Inkbox", what: "Polling the inbox too fast hit a rate limit.", workaround: WORKAROUND } });
  noteId = sc(f).note_id;
  expect(sc(f).earns).toMatch(/shared free/);
  await c.close();
}, 30_000);
afterAll(async () => {
  await server?.close();
  await paid?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("free mode over MCP", () => {
  it("notes_query returns the full workaround, teaser and price null", async () => {
    const c = await connect(url);
    try {
      const q = sc(await c.callTool({ name: "notes_query", arguments: { surface: "Inkbox" } }));
      const a = q.advisories.find((x: any) => x.note_id === noteId);
      expect(a).toMatchObject({ workaround: WORKAROUND, teaser: null, price_usdc: null, has_workaround: true });
      expect(q.next).toContain("free");
    } finally { await c.close(); }
  }, 20_000);

  it("notes_unlock returns the workaround with no payment and no paywall", async () => {
    const c = await connect(url);
    try {
      const r = await c.callTool({ name: "notes_unlock", arguments: { note_id: noteId } });
      expect(r.isError).toBeFalsy();
      expect(sc(r)).toMatchObject({ ok: true, note_id: noteId, workaround: WORKAROUND });
    } finally { await c.close(); }
  }, 20_000);

  it("tools/list shows notes_unlock as a read-only, free tool", async () => {
    const c = await connect(url);
    try {
      const t = (await c.listTools()).tools.find((x) => x.name === "notes_unlock")!;
      expect(t.title).toBe("Get a note's workaround");
      expect(t.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
      expect(t.description).toMatch(/^Free/);
    } finally { await c.close(); }
  }, 20_000);

  it("every free-mode result, errors included, passes the served output schemas (the SDK validates after listTools)", async () => {
    const c = await connect(url);
    try {
      await c.listTools(); // caches the validators, so each callTool below is checked against its outputSchema
      const q = await c.callTool({ name: "notes_query", arguments: { surface: "Inkbox" } });
      expect(q.isError).toBeFalsy();
      const ok = await c.callTool({ name: "notes_unlock", arguments: { note_id: noteId } });
      expect(sc(ok)).toMatchObject({ ok: true, workaround: WORKAROUND });
      const missing = await c.callTool({ name: "notes_unlock", arguments: { note_id: "no-such-note" } });
      expect(missing.isError).toBe(true);
      expect(sc(missing)).toMatchObject({ ok: false, code: "not_found" });
    } finally { await c.close(); }
  }, 20_000);

  it("paid mode never returns the full workaround from notes_query", async () => {
    const c = await connect(paidUrl);
    try {
      const q = await c.callTool({ name: "notes_query", arguments: { surface: "Inkbox" } });
      const a = sc(q).advisories.find((x: any) => x.note_id === noteId);
      expect("workaround" in a).toBe(false);
      expect(JSON.stringify(sc(q))).not.toContain(WORKAROUND);
      const u = (await c.listTools()).tools.find((x) => x.name === "notes_unlock")!;
      expect(u.annotations?.readOnlyHint).toBe(false);
    } finally { await c.close(); }
  }, 20_000);
});
