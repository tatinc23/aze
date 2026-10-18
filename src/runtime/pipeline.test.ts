import { describe, expect, it, vi } from "vitest";
import { defaultAssets } from "./catalog.js";
import { createPipeline, fallbackRoute, isOwnFailure, NOTHING_TO_DO, sanitizeNote, tierCost, urlFromTask, usageOf } from "./pipeline.js";
import { MemoryRunStore } from "./store.js";
import { MemoryStore } from "../store/memory.js";
import type {
  AgentContext, ArgFiller, Asset, Distiller, Executor, ExecutorKind, NoteWriter, Renderer, Router, RunStore, RuntimeDeps, StepResult,
} from "./types.js";

const ctx: AgentContext = { agent_id: "swarm-007", swarm_id: "s1", attestation: "unverified", payout_address: "0x4444444444444444444444444444444444444444", machine: null, identity: "secret-handle" };
const U = (i: number, o: number) => ({ input_tokens: i, output_tokens: o });
const ENVELOPE = JSON.stringify({ surface: "github", advisories: [{ note_id: "n0", what: "known issue" }], score: null, next: "..." });

/** A fake aze executor: answers notes_query with ENVELOPE and notes_file with a note id. Records calls. */
function fakeAze(fileResult: (args: Record<string, unknown>) => StepResult | Promise<StepResult> = (a) => ({ asset_id: "notes_file", ok: true, output: JSON.stringify({ ok: true, note_id: `note-${String(a.what).slice(0, 4)}`, audit: { status: "ok" } }), ms: 3, error: null, friction: false })) {
  const calls: Array<{ id: string; args: Record<string, unknown>; ctx: AgentContext }> = [];
  const ex: Executor = {
    async execute(asset, args, c) {
      calls.push({ id: asset.id, args, ctx: c });
      if (asset.id === "notes_query") return { asset_id: asset.id, ok: true, output: ENVELOPE, ms: 2, error: null, friction: false };
      return fileResult(args);
    },
  };
  return { ex, calls };
}

function fakeFetch(result: Partial<StepResult> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const ex: Executor = {
    async execute(asset, args) {
      calls.push(args);
      return { asset_id: asset.id, ok: true, output: `GET ${String(args.url)} -> 200\n\nrate limit is 60/hour`, ms: 5, error: null, friction: false, ...result };
    },
  };
  return { ex, calls };
}

interface Fakes {
  router?: Router | null; args?: ArgFiller | null; distiller?: Distiller | null; renderer?: Renderer | null; noteWriter?: NoteWriter | null;
  executors?: Partial<Record<ExecutorKind, Executor>>; runs?: RunStore; assets?: Asset[];
}
async function setup(f: Fakes = {}) {
  const runs = f.runs ?? new MemoryRunStore();
  if (!f.runs) await runs.upsertAssets(f.assets ?? defaultAssets({}, {}));
  const aze = fakeAze();
  const fetch = fakeFetch();
  const router: Router = { route: vi.fn(async (_t: string, assets: Asset[]) => ({ choices: [{ asset_id: "web_fetch", p: 0.92 }, { asset_id: "nope", p: 0.99 }, { asset_id: "notes_file", p: 0.99 }], ms: 4, usage: U(1000, 2), _seen: assets.map((a) => a.id) })) as never };
  const args: ArgFiller = { fill: vi.fn(async () => ({ args: { url: "https://api.github.com/rate_limit" }, ms: 3, usage: U(200, 20) })) };
  const distiller: Distiller = { distill: vi.fn(async (_t: string, raw: string) => ({ facts: `FACTS(${raw.length})`, ms: 3, usage: U(500, 50) })) };
  const renderer: Renderer = { render: vi.fn(async (_t: string, facts: string) => ({ text: `ANSWER from ${facts}`, model: "@cf/zai-org/glm-5.3-flash", fallback_used: false, ms: 3, usage: U(80, 40) })) };
  const noteWriter: NoteWriter = { write: vi.fn(async (_t: string, surface: string) => ({ note: { kind: "friction", category: "rate-limit", surface, what: "blocked fetch", payout_address: "0x9999999999999999999999999999999999999999", proof: "p", junk: "x" }, ms: 3, usage: U(300, 30) })) };
  const runtime: RuntimeDeps = {
    runs,
    router: f.router === undefined ? router : f.router,
    args: f.args === undefined ? args : f.args,
    distiller: f.distiller === undefined ? distiller : f.distiller,
    noteWriter: f.noteWriter === undefined ? noteWriter : f.noteWriter,
    renderer: f.renderer === undefined ? renderer : f.renderer,
    auditor: null,
    executors: f.executors ?? { aze: aze.ex, http_fetch: fetch.ex },
    diags: [],
    payments: null,
  };
  return { runs, runtime, aze, fetch, router, args, distiller, renderer, noteWriter };
}

describe("pipeline happy path", () => {
  it("checks Aze first, routes, fills args, executes, distills, renders, and logs the run", async () => {
    const s = await setup();
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("What is GitHub's unauthenticated API rate limit?", "GitHub", ctx);

    expect(r.status).toBe("done");
    expect(r.error).toBeNull();
    expect(r.answer).toMatch(/^ANSWER from FACTS\(\d+\)$/);
    expect(r.assets).toEqual([{ asset_id: "web_fetch", p: 0.92 }]); // unknown + notes_* choices dropped
    expect(r.timings.map((t) => t.tier)).toEqual(["notes", "snap", "args", "execute", "distill", "render"]);
    expect(r.timings.every((t) => t.ok)).toBe(true);
    expect(r.timings[0].detail).toBe("pre-check: 1 advisories");
    expect(r.timings[1].usage).toEqual(U(1000, 2));
    expect(r.notes_filed).toEqual([]);

    // The router never sees notes_* assets or inactive ones.
    const seen = (s.router.route as ReturnType<typeof vi.fn>).mock.calls[0][1].map((a: Asset) => a.id);
    expect(seen).toEqual(["web_fetch"]);
    expect(s.aze.calls[0]).toMatchObject({ id: "notes_query", args: { surface: "GitHub" } });
    expect(s.fetch.calls).toEqual([{ url: "https://api.github.com/rate_limit" }]);

    // The distiller gets the advisories and the step output; bytes are recorded.
    const raw = (s.distiller.distill as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(raw).toContain('## Aze known issues for "GitHub"');
    expect(raw).toContain("known issue");
    expect(raw).toContain("rate limit is 60/hour");
    expect(r.raw_bytes).toBe(Buffer.byteLength(raw));
    expect(r.distilled_bytes).toBe(Buffer.byteLength(`FACTS(${raw.length})`));
    expect(raw).not.toContain("secret-handle");

    // Snap cost from tokens; SubQ chat + render prices unknown → null, never invented.
    expect(r.cost_micro_usd).toEqual({ snap: 50, args: null, distill: null, render: null });

    const [stored] = await s.runs.listRuns({ limit: 1 });
    expect(stored).toMatchObject({ id: r.id, status: "done", answer: r.answer, agent_id: "swarm-007", swarm_id: "s1" });
    expect(JSON.stringify(stored)).not.toContain("0x4444");
    expect(JSON.stringify(stored)).not.toContain("secret-handle");
  });

  it("prices SubQ chat and render tiers when the env sets prices", async () => {
    const s = await setup();
    const r = await createPipeline(s.runs, s.runtime, { env: { SUBQ_CHAT_PRICE_IN_PER_M: "0.2", SUBQ_CHAT_PRICE_OUT_PER_M: "0.8", RENDER_PRICE_IN_PER_M: "0.1", RENDER_PRICE_OUT_PER_M: "0.5" } })
      .run("Check https://api.github.com/rate_limit", "GitHub", ctx);
    expect(r.cost_micro_usd).toEqual({ snap: 50, args: 200 * 0.2 + 20 * 0.8, distill: 500 * 0.2 + 50 * 0.8, render: 80 * 0.1 + 40 * 0.5 });
  });

  it("a real call that reports no tokens makes that tier's cost null (unknown), never $0", async () => {
    const s = await setup({
      router: { route: async () => ({ choices: [{ asset_id: "web_fetch", p: 0.9 }], ms: 120, usage: U(0, 0) }) },
      renderer: { render: async () => ({ text: "A", model: "m", fallback_used: false, ms: 900, usage: U(0, 0) }) },
    });
    const env = { SUBQ_CHAT_PRICE_IN_PER_M: "1", SUBQ_CHAT_PRICE_OUT_PER_M: "1", RENDER_PRICE_IN_PER_M: "1", RENDER_PRICE_OUT_PER_M: "1" };
    const r = await createPipeline(s.runs, s.runtime, { env }).run("https://example.com", "Example", ctx);
    expect(r.cost_micro_usd).toEqual({ snap: null, args: 220, distill: 550, render: null });
    expect(r.timings.find((t) => t.tier === "snap")).not.toHaveProperty("usage");
    // No call made (ms 0, zero usage, e.g. nothing to route): the tier is simply absent.
    const s2 = await setup({ router: { route: async () => ({ choices: [], ms: 0, usage: U(0, 0) }) } });
    const r2 = await createPipeline(s2.runs, s2.runtime, { env: {} }).run("Tell me a joke", "Example", ctx);
    expect(r2.cost_micro_usd).not.toHaveProperty("snap");
  });

  it("keeps at most 3 assets with p >= 0.5, highest first", async () => {
    const assets = defaultAssets({ INSTABOX_API_KEY: "k", INKBOX_API_KEY: "k" }, {});
    const router: Router = { route: async () => ({ choices: [{ asset_id: "inkbox_inbox", p: 0.6 }, { asset_id: "web_fetch", p: 0.9 }, { asset_id: "instabox_exec", p: 0.7 }, { asset_id: "inkbox_send", p: 0.55 }, { asset_id: "web_fetch", p: 0.8 }], ms: 1, usage: U(10, 0) }) };
    const noop: Executor = { execute: async (a) => ({ asset_id: a.id, ok: true, output: "ok", ms: 1, error: null, friction: false }) };
    const s = await setup({ assets, router, args: { fill: async (_t, a) => ({ args: a.id === "web_fetch" ? { url: "https://x.example.com" } : a.id === "instabox_exec" ? { command: "ls" } : { to: "a", body: "b" }, ms: 1, usage: U(1, 1) }) }, executors: { aze: fakeAze().ex, http_fetch: noop, instabox: noop, inkbox: noop } });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("t", null, ctx);
    expect(r.assets).toEqual([{ asset_id: "web_fetch", p: 0.9 }, { asset_id: "instabox_exec", p: 0.7 }, { asset_id: "inkbox_inbox", p: 0.6 }]);
  });

  it("skips the pre-check and notes without a surface", async () => {
    const s = await setup({ executors: { aze: fakeAze().ex, http_fetch: fakeFetch({ ok: false, friction: true, error: "HTTP 429" }).ex } });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("Fetch https://example.com", null, ctx);
    expect(r.timings[0].tier).toBe("snap");
    expect(r.timings.at(-1)).toMatchObject({ tier: "notes", ok: false, detail: "friction not filed: no surface" });
    expect(s.noteWriter.write).not.toHaveBeenCalled();
  });
});

describe("pipeline with null providers", () => {
  it("router null: deterministic web_fetch fallback when the task has a URL or domain", async () => {
    const s = await setup({ router: null });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("What does status.github.com say right now?", "GitHub", ctx);
    expect(r.assets).toEqual([{ asset_id: "web_fetch", p: 1 }]);
    expect(r.timings.find((t) => t.tier === "snap")!.detail).toMatch(/^router unavailable: fallback/);
    expect(r.status).toBe("done");
    expect(r.cost_micro_usd).not.toHaveProperty("snap");
  });

  it("router null and no URL: nothing chosen; with no surface either, an honest no-op answer and no render call", async () => {
    const s = await setup({ router: null });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("Tell me a joke", null, ctx);
    expect(r.assets).toEqual([]);
    expect(r.answer).toBe(NOTHING_TO_DO);
    expect(s.distiller.distill).not.toHaveBeenCalled();
    expect(s.renderer.render).not.toHaveBeenCalled();
    expect(r.raw_bytes).toBe(0);
  });

  it("args null: web_fetch takes the URL from the task; assets that need args without a fallback are skipped", async () => {
    const assets = defaultAssets({ INSTABOX_API_KEY: "k" }, {});
    const router: Router = { route: async () => ({ choices: [{ asset_id: "web_fetch", p: 0.9 }, { asset_id: "instabox_exec", p: 0.8 }], ms: 1, usage: U(10, 0) }) };
    const instabox = { execute: vi.fn() } as unknown as Executor;
    const fetch = fakeFetch();
    const s = await setup({ assets, router, args: null, executors: { aze: fakeAze().ex, http_fetch: fetch.ex, instabox } });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("Read https://docs.github.com/en/rest.", "GitHub", ctx);
    expect(fetch.calls).toEqual([{ url: "https://docs.github.com/en/rest" }]);
    expect(instabox.execute).not.toHaveBeenCalled();
    const argT = r.timings.filter((t) => t.tier === "args").map((t) => t.detail);
    expect(argT).toEqual(["web_fetch: arg filler unavailable; url taken from task", "instabox_exec: skipped (arg filler unavailable)"]);
  });

  it("args returned without a required key: fallback for web_fetch", async () => {
    const fetch = fakeFetch();
    const s = await setup({ args: { fill: async () => ({ args: { other: 1 }, ms: 1, usage: U(5, 5) }) }, executors: { aze: fakeAze().ex, http_fetch: fetch.ex } });
    await createPipeline(s.runs, s.runtime, { env: {} }).run("see api.github.com/meta", "GitHub", ctx);
    expect(fetch.calls).toEqual([{ other: 1, url: "https://api.github.com/meta" }]);
  });

  it("distiller null: facts are the raw output truncated to 4 KB, distilled_bytes stays null", async () => {
    const big = fakeFetch({ output: "x".repeat(10_000) });
    const s = await setup({ distiller: null, executors: { aze: fakeAze().ex, http_fetch: big.ex } });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("https://example.com", "Example", ctx);
    const facts = (s.renderer.render as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(Buffer.byteLength(facts)).toBe(4096);
    expect(r.distilled_bytes).toBeNull();
    expect(r.raw_bytes).toBeGreaterThan(10_000);
    expect(r.timings.find((t) => t.tier === "distill")!.detail).toBe("distiller unavailable: raw truncated to 4 KB");
  });

  it("renderer null: the answer is the facts", async () => {
    const s = await setup({ renderer: null });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("https://example.com", "Example", ctx);
    expect(r.answer).toMatch(/^FACTS\(\d+\)$/);
    expect(r.timings.find((t) => t.tier === "render")!.detail).toBe("renderer unavailable: facts returned");
    expect(r.status).toBe("done");
  });

  it("noteWriter null: friction is reported in timings, nothing filed", async () => {
    const s = await setup({ noteWriter: null, executors: { aze: fakeAze().ex, http_fetch: fakeFetch({ ok: false, friction: true, error: "HTTP 403" }).ex } });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("https://example.com", "Example", ctx);
    expect(r.notes_filed).toEqual([]);
    expect(r.timings.at(-1)).toMatchObject({ tier: "notes", ok: false, detail: "friction not filed: note writer unavailable" });
  });

  it("everything null and no aze executor: still completes", async () => {
    const s = await setup({ router: null, args: null, distiller: null, renderer: null, noteWriter: null, executors: { http_fetch: fakeFetch().ex } });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("https://example.com", "Example", ctx);
    expect(r.status).toBe("done");
    expect(r.answer).toContain("rate limit is 60/hour");
    expect(r.timings[0]).toMatchObject({ tier: "notes", ok: false, detail: "pre-check skipped: aze executor unavailable" });
  });
});

describe("pipeline failures", () => {
  it("executor failure → a note is filed through notes_file with a whitelisted body", async () => {
    const aze = fakeAze();
    const s = await setup({ executors: { aze: aze.ex, http_fetch: fakeFetch({ ok: false, friction: true, error: "HTTP 429", output: "GET ... -> 429" }).ex } });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("https://api.github.com/rate_limit", "GitHub", ctx);
    expect(r.status).toBe("done");
    expect(r.notes_filed).toEqual(["note-bloc"]);
    const file = aze.calls.find((c) => c.id === "notes_file")!;
    expect(file.args).toEqual({ kind: "friction", category: "rate-limit", surface: "GitHub", what: "blocked fetch" }); // no payout/proof/junk from the writer
    expect(file.ctx).toBe(ctx); // the aze executor injects ctx.payout_address itself
    expect(r.timings.at(-1)).toMatchObject({ tier: "notes", ok: true, detail: "web_fetch: filed note-bloc (audit ok)", usage: U(300, 30) });
    const step = (s.noteWriter.write as ReturnType<typeof vi.fn>).mock.calls[0][2] as StepResult;
    expect(step).toMatchObject({ asset_id: "web_fetch", ok: false, friction: true });
    expect(r.cost_micro_usd.notes).toBeNull();
  });

  it("a gate rejection is logged by code and rule names only (never the note text)", async () => {
    const aze = fakeAze(() => ({ asset_id: "notes_file", ok: false, output: JSON.stringify({ ok: false, code: "rejected_by_privacy_gate", problems: [{ field: "what", rule: "email", hint: "h" }, { field: "what", rule: "url", hint: "h" }] }), ms: 1, error: "rejected_by_privacy_gate", friction: false }));
    const s = await setup({ executors: { aze: aze.ex, http_fetch: fakeFetch({ ok: false, friction: true, error: "HTTP 403" }).ex } });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("https://example.com", "Example", ctx);
    expect(r.notes_filed).toEqual([]);
    const d = r.timings.at(-1)!.detail!;
    expect(d).toBe("web_fetch: not filed (rejected_by_privacy_gate: email, url)");
    expect(JSON.stringify(r.timings)).not.toContain("blocked fetch");
  });

  it("files at most 2 notes", async () => {
    const assets = defaultAssets({ INSTABOX_API_KEY: "k", INKBOX_API_KEY: "k" }, {});
    const router: Router = { route: async () => ({ choices: [{ asset_id: "web_fetch", p: 0.9 }, { asset_id: "instabox_exec", p: 0.8 }, { asset_id: "inkbox_inbox", p: 0.7 }], ms: 1, usage: U(1, 0) }) };
    const fail: Executor = { execute: async (a) => ({ asset_id: a.id, ok: false, output: "", ms: 1, error: "boom", friction: true }) };
    const s = await setup({ assets, router, args: { fill: async () => ({ args: { url: "https://x.example.com", command: "ls" }, ms: 1, usage: U(1, 1) }) }, executors: { aze: fakeAze().ex, http_fetch: fail, instabox: fail, inkbox: fail } });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("t", "Example", ctx);
    expect(s.noteWriter.write).toHaveBeenCalledTimes(2);
    expect(r.notes_filed).toHaveLength(2);
  });

  it("an executor that throws becomes a failed step; a missing executor too", async () => {
    const boom: Executor = { execute: async () => { throw new Error("kaput"); } };
    const s = await setup({ noteWriter: null, executors: { aze: fakeAze().ex, http_fetch: boom } });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("https://example.com", "Example", ctx);
    expect(r.timings.find((t) => t.tier === "execute")).toMatchObject({ ok: false, detail: "web_fetch: executor threw: kaput" });
    const s2 = await setup({ noteWriter: null, executors: { aze: fakeAze().ex } });
    const r2 = await createPipeline(s2.runs, s2.runtime, { env: {} }).run("https://example.com", "Example", ctx);
    expect(r2.timings.find((t) => t.tier === "execute")).toMatchObject({ ok: false, detail: "web_fetch: no http_fetch executor" });
    expect(r2.status).toBe("done");
  });

  it("router/args/distiller/renderer/noteWriter that throw degrade to fallbacks", async () => {
    const boom = async () => { throw new Error("provider down"); };
    const s = await setup({
      router: { route: boom }, args: { fill: boom }, distiller: { distill: boom }, renderer: { render: boom }, noteWriter: { write: boom },
      executors: { aze: fakeAze().ex, http_fetch: fakeFetch({ ok: false, friction: true, error: "HTTP 503" }).ex },
    });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("https://example.com", "Example", ctx);
    expect(r.status).toBe("done");
    const d = (tier: string) => r.timings.filter((t) => t.tier === tier).map((t) => t.detail);
    expect(d("snap")).toEqual(["router failed (provider down): fallback web_fetch"]);
    expect(d("args")[0]).toBe("web_fetch: arg filler failed (provider down)");
    expect(d("distill")).toEqual(["distiller failed (provider down): raw truncated to 4 KB"]);
    expect(d("render")).toEqual(["renderer failed (provider down): facts returned"]);
    expect(d("notes").at(-1)).toBe("web_fetch: note writer failed (provider down)");
    expect(r.answer).toContain("HTTP 503");
  });

  it("counts tokens a failed provider call reports on its error (billed spend is never dropped)", async () => {
    const billed = (u: ReturnType<typeof U>) => async () => { throw Object.assign(new Error("bad_output"), { usage: u }); };
    const s = await setup({
      router: { route: billed(U(400, 0)) }, args: { fill: billed(U(100, 10)) }, distiller: { distill: billed(U(0, 0)) }, renderer: { render: billed(U(50, 5)) },
      noteWriter: { write: billed(U(30, 3)) }, executors: { aze: fakeAze().ex, http_fetch: fakeFetch({ ok: false, friction: true, error: "HTTP 429" }).ex },
    });
    const r = await createPipeline(s.runs, s.runtime, { env: { SUBQ_CHAT_PRICE_IN_PER_M: "1", SUBQ_CHAT_PRICE_OUT_PER_M: "2" } }).run("https://example.com", "Example", ctx);
    expect(r.cost_micro_usd).toEqual({ snap: 400 * 0.05, args: 100 + 20, notes: 30 + 6, render: null }); // zero usage = no tier entry
    expect(r.timings.find((t) => t.tier === "snap")).toMatchObject({ ok: false, usage: U(400, 0) });
    expect(r.timings.filter((t) => t.tier === "notes").at(-1)).toMatchObject({ ok: false, usage: U(30, 3) });
  });

  it("never files notes about the runtime's own failures (placeholder executor, SSRF refusal, bad args)", async () => {
    const assets = defaultAssets({ INSTABOX_API_KEY: "k" }, {});
    const router: Router = { route: async () => ({ choices: [{ asset_id: "web_fetch", p: 0.9 }, { asset_id: "instabox_exec", p: 0.8 }], ms: 1, usage: U(1, 0) }) };
    const instabox: Executor = { execute: async (a) => ({ asset_id: a.id, ok: false, output: "", ms: 0, error: "not configured", friction: false }) };
    const refused = fakeFetch({ ok: false, friction: false, error: "refused: only https URLs are fetched (got http)", output: "" });
    const s = await setup({ assets, router, args: { fill: async () => ({ args: { url: "http://x.example.com", command: "ls" }, ms: 1, usage: U(1, 1) }) }, executors: { aze: fakeAze().ex, http_fetch: refused.ex, instabox } });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("t", "Example", ctx);
    expect(s.noteWriter.write).not.toHaveBeenCalled();
    expect(r.notes_filed).toEqual([]);
    expect(r.timings.at(-1)).toMatchObject({ tier: "notes", ok: true, detail: "not filed: web_fetch, instabox_exec failed on the runtime's side, not the service's" });
    // A real service failure in the same run is still filed.
    const s2 = await setup({ assets, router, args: { fill: async () => ({ args: { url: "https://x.example.com", command: "ls" }, ms: 1, usage: U(1, 1) }) }, executors: { aze: fakeAze().ex, http_fetch: fakeFetch({ ok: false, friction: true, error: "HTTP 403" }).ex, instabox } });
    const r2 = await createPipeline(s2.runs, s2.runtime, { env: {} }).run("t", "Example", ctx);
    expect(s2.noteWriter.write).toHaveBeenCalledTimes(1);
    expect((s2.noteWriter.write as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatchObject({ asset_id: "web_fetch" });
    expect(r2.notes_filed).toHaveLength(1);
  });

  it("soft deadline: a hung provider fails the run with a partial answer, never hangs", async () => {
    const s = await setup({ renderer: { render: () => new Promise(() => {}) } });
    const t0 = Date.now();
    const r = await createPipeline(s.runs, s.runtime, { env: {}, deadlineMs: 60 }).run("https://example.com", "Example", ctx);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.status).toBe("failed");
    expect(r.error).toBe("soft deadline (0 s) exceeded at render");
    expect(r.answer).toMatch(/^FACTS/);
    expect((await s.runs.listRuns({ limit: 1 }))[0].status).toBe("failed");
  });

  it("run store down at insert: refuses before spending anything", async () => {
    const runs = new MemoryRunStore();
    runs.insertRun = async () => { throw new Error("relation runs does not exist"); };
    const s = await setup({ runs });
    const r = await createPipeline(runs, s.runtime, { env: {} }).run("https://example.com", "Example", ctx);
    expect(r).toMatchObject({ status: "failed", error: "run store unavailable: relation runs does not exist" });
    expect(r.id).toMatch(/^unsaved-/);
    expect(s.router.route).not.toHaveBeenCalled();
    expect(s.aze.calls).toEqual([]);
  });

  it("a hung run store never hangs the run: insert refuses, listAssets falls back, finishRun is abandoned", async () => {
    const hang = () => new Promise<never>(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r1 = new MemoryRunStore();
    r1.insertRun = hang;
    const s1 = await setup({ runs: r1 });
    const t0 = Date.now();
    const a = await createPipeline(r1, s1.runtime, { env: {}, storeTimeoutMs: 30 }).run("https://example.com", "Example", ctx);
    expect(a).toMatchObject({ status: "failed", error: "run store unavailable: insertRun timed out after 0.03 s" });
    expect(s1.aze.calls).toEqual([]);
    const r2 = new MemoryRunStore();
    r2.listAssets = hang;
    r2.finishRun = hang;
    const s2 = await setup({ runs: r2 });
    const b = await createPipeline(r2, s2.runtime, { env: {}, storeTimeoutMs: 30 }).run("https://example.com", "Example", ctx);
    expect(b.status).toBe("done");
    expect(b.timings.find((t) => t.tier === "snap")!.detail).toContain("catalog unavailable (listAssets timed out after 0.03 s): default assets");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("finishRun failed"));
    expect(Date.now() - t0).toBeLessThan(2000);
    err.mockRestore();
  });

  it("finishRun failing still returns the record; listAssets failing uses defaults", async () => {
    const runs = new MemoryRunStore();
    runs.finishRun = async () => { throw new Error("db down"); };
    runs.listAssets = async () => { throw new Error("no table"); };
    const s = await setup({ runs });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await createPipeline(runs, s.runtime, { env: {} }).run("https://example.com", "Example", ctx);
    spy.mockRestore();
    expect(r.status).toBe("done");
    expect(r.timings.find((t) => t.tier === "snap")!.detail).toContain("catalog unavailable (no table): default assets");
  });

  it("never throws, even with a malformed context", async () => {
    const s = await setup();
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("https://example.com", "Example", null as unknown as AgentContext);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/^pipeline error: /);
  });

  it("caps the answer at 4 KB", async () => {
    const s = await setup({ renderer: { render: async () => ({ text: "é".repeat(5000), model: "m", fallback_used: true, ms: 1, usage: U(1, 1) }) } });
    const r = await createPipeline(s.runs, s.runtime, { env: {} }).run("https://example.com", "Example", ctx);
    expect(Buffer.byteLength(r.answer!)).toBeLessThanOrEqual(4096);
    expect(r.timings.find((t) => t.tier === "render")!.detail).toBe("m (fallback)");
  });

  it("accepts the notes Store as the first argument (uses runtime.runs)", async () => {
    const s = await setup();
    const r = await createPipeline(new MemoryStore(), s.runtime, { env: {} }).run("https://example.com", "Example", ctx);
    expect((await s.runs.listRuns({ limit: 1 }))[0].id).toBe(r.id);
  });
});

describe("pipeline helpers", () => {
  it("urlFromTask finds URLs and bare public domains, not emails or file names", () => {
    expect(urlFromTask("Check https://status.github.com/api, please.")).toBe("https://status.github.com/api");
    expect(urlFromTask("see http://example.com/x")).toBe("https://example.com/x");
    expect(urlFromTask("What does api.github.com/rate_limit return?")).toBe("https://api.github.com/rate_limit");
    expect(urlFromTask("Is stripe.com up?")).toBe("https://stripe.com");
    expect(urlFromTask("mail ops@example.com about Node.js")).toBeNull();
    expect(urlFromTask("Find GitHub's public API rate limit")).toBeNull();
  });

  it("fallbackRoute only picks an active web_fetch", () => {
    const assets = defaultAssets({}, {});
    expect(fallbackRoute("stripe.com", assets)).toEqual([{ asset_id: "web_fetch", p: 1 }]);
    expect(fallbackRoute("stripe.com", assets.filter((a) => a.id !== "web_fetch"))).toEqual([]);
  });

  it("sanitizeNote keeps NoteInput fields only and fills the surface", () => {
    expect(sanitizeNote({ kind: " friction ", what: "w", payout_address: "0x1", proof: "p", tokens_spent: 5, wish: "", extra: 1 }, "GitHub"))
      .toEqual({ kind: "friction", what: "w", tokens_spent: 5, surface: "GitHub" });
  });

  it("usageOf reads provider-reported usage from errors; isOwnFailure spots runtime-side failures only", () => {
    expect(usageOf(Object.assign(new Error("x"), { usage: U(5, 1) }))).toEqual(U(5, 1));
    expect(usageOf(Object.assign(new Error("x"), { usage: U(0, 0) }))).toBeUndefined();
    expect(usageOf(Object.assign(new Error("x"), { usage: { input_tokens: "lots" } }))).toBeUndefined();
    expect(usageOf(new Error("x"))).toBeUndefined();
    expect(usageOf(null)).toBeUndefined();
    const st = (error: string, friction = false, ok = false): StepResult => ({ asset_id: "a", ok, output: "", ms: 0, error, friction });
    for (const e of ["not configured", "missing url argument", "asset has no valid https MCP endpoint", "no instabox executor", "executor threw: x", "notes_unlock is not callable by the runtime", "refused: non-standard port", "invalid URL"]) {
      expect(isOwnFailure(st(e)), e).toBe(true);
    }
    for (const e of ["HTTP 404", "HTTP 503", "dns lookup failed (ENOTFOUND)", "timed out after 10 s", "rejected_by_privacy_gate"]) expect(isOwnFailure(st(e)), e).toBe(false);
    expect(isOwnFailure(st("refused: x", true))).toBe(false); // the executor called it friction: its judgment wins
  });

  it("tierCost: undefined when nothing ran, null when the price is unknown", () => {
    expect(tierCost([], 1, 1)).toBeUndefined();
    expect(tierCost([U(10, 10)], null, 1)).toBeNull();
    expect(tierCost([U(10, 10)], 1, null)).toBeNull();
    expect(tierCost([U(10, 10)], 0.05, null, true)).toBe(0.5);
    expect(tierCost([U(1_000_000, 0)], 0.05, null, true)).toBe(50_000); // $0.05 per 1M = 50,000 micro-USD
  });
});
