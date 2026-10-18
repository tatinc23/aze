// The MCP client's retry policy against a tiny fake Streamable HTTP server: a non-idempotent call (notes_file) must
// never be resent when the server may already have run it, or the swarm files duplicate notes.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callTool, classifyError, closeAll } from "./mcp-client.js";

type Reply = { status: number; body?: unknown };
let script: (n: number) => Reply = () => ({ status: 200 });
let calls = 0;
let inits = 0;
let server: http.Server;
let url = "";

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.method === "GET") { res.writeHead(405); return res.end(); } // no standalone SSE stream
    if (req.method === "DELETE") { res.writeHead(200); return res.end(); }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (msg.method === "initialize") {
      inits++;
      return send(200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }, { "mcp-session-id": `s${inits}` });
    }
    if (msg.id === undefined) { res.writeHead(202); return res.end(); } // notifications
    if (msg.method === "tools/call") {
      calls++;
      const r = script(calls);
      if (r.status === 0) return void req.socket.destroy(); // connection reset mid-request
      if (r.status !== 200) return send(r.status, r.body ?? { error: "boom" });
      return send(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: '{"ok":true}' }], structuredContent: { ok: true, n: calls } } });
    }
    return send(200, { jsonrpc: "2.0", id: msg.id, result: {} });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterEach(async () => { await closeAll(); calls = 0; inits = 0; script = () => ({ status: 200 }); });
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("callTool retry policy", () => {
  it("returns structuredContent on success and reuses one connection", async () => {
    expect(await callTool(url, "t", {})).toMatchObject({ ok: true, isError: false, data: { ok: true, n: 1 }, error: null });
    expect((await callTool(url, "t", {})).ok).toBe(true);
    expect(inits).toBe(1);
  });

  it("never resends a non-idempotent call after a 5xx (the tool may have run)", async () => {
    script = () => ({ status: 500 });
    const r = await callTool(url, "notes_file", {}, { idempotent: false });
    expect(r).toMatchObject({ ok: false, isError: true, data: null });
    expect(r.error).toMatch(/500|boom/);
    expect(calls).toBe(1);
  });

  it("never resends a non-idempotent call after a reset mid-request; an idempotent one reconnects and resends", async () => {
    script = (n) => (n === 1 ? { status: 0 } : { status: 200 });
    expect((await callTool(url, "notes_file", {}, { idempotent: false })).ok).toBe(false);
    expect(calls).toBe(1);
    calls = 0;
    expect((await callTool(url, "notes_query", {})).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("resends an idempotent call once after a 5xx, on the same session", async () => {
    script = (n) => (n === 1 ? { status: 502 } : { status: 200 });
    expect((await callTool(url, "notes_query", {})).ok).toBe(true);
    expect(calls).toBe(2);
    expect(inits).toBe(1); // an HTTP error does not drop the shared connection
  });

  it("reconnects and resends even a non-idempotent call after 'Session not found' (404: the server did not run it)", async () => {
    script = (n) => (n === 1 ? { status: 404, body: { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null } } : { status: 200 });
    const r = await callTool(url, "notes_file", {}, { idempotent: false });
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(inits).toBe(2);
  });

  it("gives up after two attempts (bounded)", async () => {
    script = () => ({ status: 404 });
    expect((await callTool(url, "t", {})).ok).toBe(false);
    expect(calls).toBe(2);
  });
});

describe("classifyError", () => {
  const httpErr = (code: number, message: string) => Object.assign(new Error(`Streamable HTTP error: ${message}`), { code });
  it.each([
    [Object.assign(new Error("Request timed out"), { code: -32001 }), "timeout"],
    [Object.assign(new Error("MCP error -32602: Invalid params"), { code: -32602 }), "protocol"],
    [httpErr(404, "Error POSTing to endpoint: Session not found"), "stale_session"],
    [httpErr(400, "Bad Request: No valid session ID provided"), "stale_session"],
    [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), "not_delivered"],
    [new Error("Not connected"), "not_delivered"],
    [httpErr(500, "Error POSTing to endpoint: internal"), "http"],
    [httpErr(400, "Bad Request: bad body"), "http"],
    [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }), "connection"],
    [Object.assign(new Error("Connection closed"), { code: -32000 }), "connection"],
  ] as const)("%s -> %s", (e, kind) => expect(classifyError(e)).toBe(kind));
});
