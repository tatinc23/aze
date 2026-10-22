import { describe, expect, it, vi } from "vitest";
import { defaultAssets } from "./catalog.js";
import { applicableAdvisories, createPipeline, MAX_CANDIDATES, MAX_SURFACES, nextStep, snapCost, usageOf } from "./pipeline.js";
import { MemoryRunStore } from "./store.js";
import { MemoryStore } from "../store/memory.js";
import { gate } from "../gate/index.js";
import type { AgentContext, Candidate, Router, RunStore, ToolAdvisory } from "./types.js";
import type { Advisory, Envelope } from "../types.js";

const ctx: AgentContext = { agent_id: "agent_run", swarm_id: null, attestation: "unverified", payout_address: null, machine: null, identity: null };
const U = (i: number, o: number) => ({ input_tokens: i, output_tokens: o });
const TOOLS: Candidate[] = [
  { id: "github.search_code", description: "Search code across public GitHub repositories.", surface: "GitHub" },
  { id: "web_fetch", description: "Fetch one public web page and return its text." },
  { id: "calendar.create_event", description: "Create an event on the user's calendar.", surface: "Google Calendar" },
];

async function file(store: MemoryStore, input: Record<string, unknown>) {
  const g = gate(input);
  if (!g.ok) throw new Error(`test note rejected: ${JSON.stringify(g.problems)}`);
  return store.insertNote(g.note, { attestation: "unverified", payout_address: null });
}

function routerOf(choices: Array<{ asset_id: string; p: number }>, usage = U(1200, 0)): Router & { route: ReturnType<typeof vi.fn> } {
  return { label: "SubQ Snap (test)", route: vi.fn(async () => ({ choices, ms: 5, usage })) } as never;
}

async function setup(opts: { router?: Router | null; runs?: RunStore; store?: MemoryStore } = {}) {
  const store = opts.store ?? new MemoryStore();
  const runs = opts.runs ?? new MemoryRunStore();
  const router = opts.router === undefined
    ? routerOf([{ asset_id: "github.search_code", p: 0.91 }, { asset_id: "web_fetch", p: 0.62 }, { asset_id: "calendar.create_event", p: 0.03 }, { asset_id: "unknown", p: 0.99 }])
    : opts.router;
  return { store, runs, router, pipeline: createPipeline({ store, runs, router }, { env: {} }) };
}

describe("decide-only pipeline", () => {
  it("checks the map, lets Snap pick from the caller's tools, and returns decisions + applicable advisories", async () => {
    const store = new MemoryStore();
    const own = await file(store, { kind: "barrier", category: "rate-limit", surface: "GitHub", tool: "github.search_code", what: "Code search returns 403 after a few unauthenticated calls" });
    const whole = await file(store, { kind: "friction", category: "auth", surface: "GitHub", what: "Fine-grained tokens cannot read public repositories of other owners" });
    await file(store, { kind: "friction", category: "docs", surface: "GitHub", tool: "github.create_issue", what: "Issue templates are not applied through the API" });
    await file(store, { kind: "friction", category: "auth", surface: "Google Calendar", what: "OAuth consent screen blocks unattended agents" });
    const { runs, router, pipeline } = await setup({ store });

    const r = await pipeline.run("Find where the rate limiter is defined in a public repository", "GitHub", ctx, TOOLS);

    expect(r.status).toBe("done");
    expect(r.error).toBeNull();
    expect(router!.route).toHaveBeenCalledWith("Find where the rate limiter is defined in a public repository", TOOLS);
    // p >= 0.5 only, best first; ids Snap made up are dropped.
    expect(r.assets).toEqual([{ asset_id: "github.search_code", p: 0.91 }, { asset_id: "web_fetch", p: 0.62 }]);
    expect(r.decision.decided_by).toBe("SubQ Snap (test)");
    expect(r.decision.scores).toEqual([{ tool: "github.search_code", p: 0.91 }, { tool: "web_fetch", p: 0.62 }, { tool: "calendar.create_event", p: 0.03 }]);
    // GitHub's whole-service note and the search_code note apply; the create_issue note does not; the calendar tool
    // was not chosen, so its service's note is not returned.
    expect(r.decision.advisories.map((a) => a.note_id).sort()).toEqual([own.id, whole.id].sort());
    expect(r.decision.advisories.every((a) => a.surface === "github")).toBe(true);
    expect(r.decision.next).toMatch(/^Aze does not run tools: call github\.search_code and web_fetch yourself/);
    expect(r.decision.next).toContain("notes_file");
    // Nothing is filled, run, distilled, answered or filed.
    expect(r).toMatchObject({ answer: null, raw_bytes: null, distilled_bytes: null, notes_filed: [] });
    expect(r.timings.map((t) => t.tier)).toEqual(["notes", "snap"]);
    expect(r.timings[0].detail).toMatch(/^map check: 4 advisories across 2 services/);
    // The run log is public: caller tool names stay out of the details (they are in assets, masked publicly).
    expect(r.timings[1].detail).toBe("chose 2 of 3 tools (p=0.91, 0.62)");
    expect(r.cost_micro_usd).toEqual({ snap: 60 }); // 1200 input tokens * $0.05/M
    const [rec] = await runs.listRuns({ limit: 1 });
    expect(rec).toMatchObject({ id: r.id, status: "done", assets: r.assets, answer: null });
    expect(rec).not.toHaveProperty("decision");
  });

  it("free mode: advisories carry the full workaround, as in notes_query", async () => {
    const store = new MemoryStore();
    const n = await file(store, { kind: "workaround", category: "rate-limit", surface: "GitHub", tool: "github.search_code", what: "Code search limits unauthenticated callers", workaround: "Pause a minute between searches." });
    const runs = new MemoryRunStore();
    const router = routerOf([{ asset_id: "github.search_code", p: 0.9 }]);
    const paid = await createPipeline({ store, runs, router }, { env: {} }).run("Find a function", "GitHub", ctx, TOOLS);
    expect(paid.decision.advisories[0]).not.toHaveProperty("workaround");
    const free = await createPipeline({ store, runs, router, free: true }, { env: {} }).run("Find a function", "GitHub", ctx, TOOLS);
    expect(free.decision.advisories[0]).toMatchObject({ note_id: n.id, workaround: "Pause a minute between searches.", price_usdc: null, teaser: null });
    expect(free.decision.next).toContain("workarounds are included");
  });

  it("logs each map check as a query, like notes_query", async () => {
    const store = new MemoryStore();
    const spy = vi.spyOn(store, "logQuery");
    const { pipeline } = await setup({ store });
    await pipeline.run("Find a function in a public repository", "GitHub", ctx, TOOLS);
    expect(spy.mock.calls.map((c) => c[0].surface).sort()).toEqual(["github", "google calendar"]);
  });

  it("without Snap: status failed, nothing ranked, advisories for every candidate's service, a pick-yourself next step", async () => {
    const store = new MemoryStore();
    await file(store, { kind: "friction", category: "auth", surface: "Google Calendar", what: "OAuth consent screen blocks unattended agents" });
    const { pipeline, runs } = await setup({ store, router: null });
    const r = await pipeline.run("Book a meeting", null, ctx, TOOLS);
    expect(r.status).toBe("failed");
    expect(r.error).toBe("SubQ Snap unavailable: no tool was ranked");
    expect(r.decision).toMatchObject({ decided_by: null, scores: [] });
    expect(r.decision.advisories.map((a) => a.surface)).toEqual(["google calendar"]);
    expect(r.decision.next).toMatch(/^Snap was unavailable, so no tool was ranked/);
    expect(r.cost_micro_usd).toEqual({});
    expect((await runs.listRuns({ limit: 1 }))[0].status).toBe("failed");
  });

  it("a Snap failure keeps the billed tokens and still returns advisories", async () => {
    const err = Object.assign(new Error("snap route failed for 1/1 calls"), { usage: U(800, 0) });
    const { pipeline } = await setup({ router: { route: vi.fn(async () => { throw err; }) } });
    const r = await pipeline.run("Find a function", "GitHub", ctx, TOOLS);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/^SubQ Snap failed: snap route failed/);
    expect(r.timings[1]).toMatchObject({ tier: "snap", ok: false, usage: U(800, 0) });
    expect(r.cost_micro_usd).toEqual({ snap: 40 });
  });

  it("nothing at p >= 0.5: done, no tools chosen, scores still returned", async () => {
    const { pipeline } = await setup({ router: routerOf([{ asset_id: "web_fetch", p: 0.2 }]) });
    const r = await pipeline.run("Say hello", null, ctx, TOOLS);
    expect(r.status).toBe("done");
    expect(r.assets).toEqual([]);
    expect(r.decision.scores).toEqual([{ tool: "web_fetch", p: 0.2 }]);
    expect(r.decision.advisories).toEqual([]);
    expect(r.decision.next).toMatch(/^Snap found no candidate tool needed/);
  });

  it("caps chosen tools at 3 and candidates at MAX_CANDIDATES", async () => {
    const many: Candidate[] = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => ({ id: `t${i}`, description: `tool ${i}` }));
    const router = routerOf(many.map((t, i) => ({ asset_id: t.id, p: 0.9 - i * 0.01 })));
    const { pipeline } = await setup({ router });
    const r = await pipeline.run("Do many things", null, ctx, many);
    expect((router.route.mock.calls[0][1] as Candidate[]).length).toBe(MAX_CANDIDATES);
    expect(r.assets.map((a) => a.asset_id)).toEqual(["t0", "t1", "t2"]);
    expect(r.decision.scores.length).toBe(MAX_CANDIDATES);
  });

  it(`checks at most ${MAX_SURFACES} services per run and says how many were left out`, async () => {
    const tools: Candidate[] = Array.from({ length: MAX_SURFACES + 2 }, (_, i) => ({ id: `t${i}`, description: `tool ${i}`, surface: `Service ${i}` }));
    const { pipeline } = await setup({ router: routerOf([]) });
    const r = await pipeline.run("Do it", null, ctx, tools);
    expect(r.timings[0].detail).toBe(`map check: 0 advisories across ${MAX_SURFACES} services; 2 more not checked`);
  });

  it("no service anywhere: the map check is skipped and says so", async () => {
    const { pipeline } = await setup({ router: routerOf([]) });
    const r = await pipeline.run("Do it", null, ctx, [{ id: "a", description: "x" }]);
    expect(r.timings[0]).toMatchObject({ tier: "notes", ok: false, detail: "map check skipped: no service given" });
  });

  it("runs without tools (swarm, /admin/run) pick from the warehouse catalog, never the notes tools", async () => {
    const runs = new MemoryRunStore();
    await runs.upsertAssets(defaultAssets({}, {}));
    const router = routerOf([{ asset_id: "web_fetch", p: 0.8 }]);
    const { pipeline } = await setup({ runs, router });
    const r = await pipeline.run("Is GitHub up?", "GitHub", ctx);
    const ids = (router.route.mock.calls[0][1] as Candidate[]).map((c) => c.id);
    expect(ids).toContain("web_fetch");
    expect(ids.some((id) => id.startsWith("notes_"))).toBe(false);
    expect(r.assets).toEqual([{ asset_id: "web_fetch", p: 0.8 }]);
  });

  it("refuses before Snap is called when the run log is unavailable, and never throws", async () => {
    const runs = new MemoryRunStore();
    runs.insertRun = async () => { throw new Error("db down"); };
    const { pipeline, router } = await setup({ runs });
    const r = await pipeline.run("t", null, ctx, TOOLS);
    expect(r).toMatchObject({ status: "failed", error: "run store unavailable: db down", decision: { decided_by: null, advisories: [] } });
    expect(r.id).toMatch(/^unsaved-/);
    expect(router!.route).not.toHaveBeenCalled();
    const bad = await pipeline.run("t", null, null as never, TOOLS);
    expect(bad).toMatchObject({ status: "failed", error: expect.stringMatching(/^pipeline error/) });
  });

  it("a store failure in the map check degrades the check, not the run", async () => {
    const store = new MemoryStore();
    store.findMatches = async () => { throw new Error("db down"); };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { pipeline } = await setup({ store });
    const r = await pipeline.run("Find a function", "GitHub", ctx, TOOLS);
    expect(r.status).toBe("done");
    expect(r.timings[0]).toMatchObject({ tier: "notes", ok: false, detail: "map check: 0 advisories across 2 services (2 degraded)" });
    vi.restoreAllMocks();
  });

  it("Snap answering with no reported tokens makes the cost unknown (null), never $0", async () => {
    const { pipeline } = await setup({ router: routerOf([{ asset_id: "web_fetch", p: 0.7 }], U(0, 0)) });
    expect((await pipeline.run("t", null, ctx, TOOLS)).cost_micro_usd).toEqual({ snap: null });
  });
});

describe("helpers", () => {
  const adv = (over: Partial<Advisory>): Advisory => ({
    note_id: "n", kind: "friction", what: "w", tool: null, reports: 1, verified: false, label: "UNVERIFIED", has_workaround: false, teaser: null, price_usdc: null, ...over,
  });
  const env = (surface: string, advisories: Advisory[]): Envelope => ({ surface, advisories, score: null, next: "" });

  it("applicableAdvisories: whole-service notes and the tool's own notes, deduped, case-insensitive tool match", () => {
    const envs = new Map([["github", env("github", [adv({ note_id: "a" }), adv({ note_id: "b", tool: "Search_Code" }), adv({ note_id: "c", tool: "other" })])]]);
    const tools: Candidate[] = [{ id: "search_code", description: "", surface: "GitHub" }, { id: "x", description: "" }];
    expect(applicableAdvisories(tools, envs, "GitHub").map((a) => a.note_id)).toEqual(["a", "b"]);
    expect(applicableAdvisories(tools, envs, null).map((a) => a.note_id)).toEqual(["a", "b"]);
    expect(applicableAdvisories([], envs, "GitHub")).toEqual([]);
  });

  it("nextStep names the tools, the known issues and notes_unlock when a workaround is for sale", () => {
    const paid = [adv({ has_workaround: true, price_usdc: "0.05" }) as ToolAdvisory];
    expect(nextStep({ decided_by: "SubQ Snap", chosen: ["a"], advisories: [] })).toBe("Aze does not run tools: call a yourself with your own inputs, then write the answer. If a tool blocks or slows you, file one note with notes_file.");
    expect(nextStep({ decided_by: "SubQ Snap", chosen: ["a", "b", "c"], advisories: paid })).toContain("call a, b and c yourself");
    expect(nextStep({ decided_by: "SubQ Snap", chosen: ["a"], advisories: paid })).toContain("Read the 1 known issue below first; notes_unlock returns a paid workaround by note_id.");
  });

  it("snapCost bills input tokens only; usageOf reads billed usage off an error", () => {
    expect(snapCost([], 0.05)).toBeUndefined();
    expect(snapCost([U(1000, 500), U(200, 0)], 0.05)).toBe(60);
    expect(usageOf(Object.assign(new Error("x"), { usage: U(5, 0) }))).toEqual(U(5, 0));
    expect(usageOf(new Error("x"))).toBeUndefined();
  });
});
