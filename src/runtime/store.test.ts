import { describe, expect, it, vi } from "vitest";
import { computeRunStats, createRunStore, MemoryRunStore, SupabaseRunStore, toRun } from "./store.js";
import { DEFAULT_ASSETS } from "./catalog.js";
import type { RunRecord } from "./types.js";

const newRun = (over: Partial<RunRecord> = {}) => ({ agent_id: "swarm-001", swarm_id: "s1", task: "t", surface: "GitHub", attestation: "unverified" as const, ...over });

describe("MemoryRunStore", () => {
  it("inserts a running record and finishes it with a whitelisted patch", async () => {
    const s = new MemoryRunStore();
    const r = await s.insertRun(newRun());
    expect(r).toMatchObject({ agent_id: "swarm-001", swarm_id: "s1", status: "running", assets: [], timings: [], notes_filed: [], answer: null, finished_at: null });
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    await s.finishRun(r.id, { status: "done", answer: "a", notes_filed: ["n1"], id: "hijack", created_at: "x", payout_address: "0xabc" } as never);
    const [got] = await s.listRuns({ limit: 10 });
    expect(got).toMatchObject({ id: r.id, created_at: r.created_at, status: "done", answer: "a", notes_filed: ["n1"] });
    expect(got).not.toHaveProperty("payout_address");
    await s.finishRun("missing", { status: "failed" }); // unknown id: no-op
  });

  it("lists newest first, filters by swarm, clamps the limit, and returns copies", async () => {
    const s = new MemoryRunStore();
    const a = await s.insertRun(newRun({ swarm_id: "s1" }));
    const b = await s.insertRun(newRun({ swarm_id: "s2" }));
    const c = await s.insertRun(newRun({ swarm_id: "s1" }));
    expect((await s.listRuns({ limit: 10 })).map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect((await s.listRuns({ swarm_id: "s1", limit: 10 })).map((r) => r.id)).toEqual([c.id, a.id]);
    expect(await s.listRuns({ limit: 0 })).toHaveLength(1);
    const [copy] = await s.listRuns({ limit: 1 });
    copy.status = "failed";
    expect((await s.listRuns({ limit: 1 }))[0].status).toBe("running");
  });

  it("caps memory at maxRuns", async () => {
    const s = new MemoryRunStore(3);
    for (let i = 0; i < 5; i++) await s.insertRun(newRun({ task: `t${i}` }));
    expect((await s.listRuns({ limit: 10 })).map((r) => r.task)).toEqual(["t4", "t3", "t2"]);
  });

  it("upserts assets by id", async () => {
    const s = new MemoryRunStore();
    await s.upsertAssets(DEFAULT_ASSETS.slice(0, 2) as never);
    await s.upsertAssets([{ ...DEFAULT_ASSETS[0], description: "changed" }]);
    const list = await s.listAssets();
    expect(list.map((a) => a.id)).toEqual(["notes_file", "notes_query"]);
    expect(list.find((a) => a.id === "notes_query")!.description).toBe("changed");
  });

  it("runStats per swarm", async () => {
    const s = new MemoryRunStore();
    const a = await s.insertRun(newRun({ swarm_id: "s1" }));
    await s.insertRun(newRun({ swarm_id: "s2" }));
    await s.finishRun(a.id, { status: "done", notes_filed: ["x", "y"], timings: [{ tier: "render", ms: 100, ok: true }], raw_bytes: 100, distilled_bytes: 25 });
    expect(await s.runStats("s1")).toMatchObject({ runs: 1, done: 1, notes_filed: 2, avg_ms_by_tier: { render: 100 }, compression_ratio: 0.25 });
    expect(await s.runStats()).toMatchObject({ runs: 2, done: 1, running: 1 });
  });
});

describe("computeRunStats", () => {
  const base = { status: "done" as const, timings: [], raw_bytes: null, distilled_bytes: null, cost_micro_usd: {}, notes_filed: [] };

  it("is empty-safe", () => {
    expect(computeRunStats([])).toEqual({ runs: 0, done: 0, failed: 0, running: 0, notes_filed: 0, avg_ms_by_tier: {}, cost_micro_usd_by_tier: {}, compression_ratio: null });
  });

  it("averages per-run tier sums over runs that have the tier, ignoring failed entries", () => {
    const s = computeRunStats([
      { ...base, timings: [{ tier: "execute", ms: 100, ok: true }, { tier: "execute", ms: 300, ok: true }, { tier: "snap", ms: 50, ok: true }] },
      { ...base, timings: [{ tier: "execute", ms: 200, ok: true }, { tier: "snap", ms: 0, ok: false, detail: "router unavailable: fallback" }] },
      { ...base, status: "failed", timings: [{ tier: "render", ms: 75_000, ok: false }] },
    ]);
    expect(s.avg_ms_by_tier).toEqual({ execute: 300, snap: 50 }); // (400 + 200) / 2; failed render excluded
    expect(s).toMatchObject({ runs: 3, done: 2, failed: 1, running: 0 });
  });

  it("sums costs per tier, skipping nulls, and leaves unknown tiers absent", () => {
    const s = computeRunStats([
      { ...base, cost_micro_usd: { snap: 12.5, distill: null, render: null } },
      { ...base, cost_micro_usd: { snap: 7.5, distill: 3 } },
    ]);
    expect(s.cost_micro_usd_by_tier).toEqual({ snap: 20, distill: 3 });
  });

  it("compression = sum distilled / sum raw over done runs with both", () => {
    const s = computeRunStats([
      { ...base, raw_bytes: 1000, distilled_bytes: 100 },
      { ...base, raw_bytes: 3000, distilled_bytes: 300 },
      { ...base, raw_bytes: 5000, distilled_bytes: null }, // no distiller: not counted
      { ...base, status: "failed", raw_bytes: 9000, distilled_bytes: 9000 }, // not done
      { ...base, raw_bytes: 0, distilled_bytes: 0 },
    ]);
    expect(s.compression_ratio).toBeCloseTo(0.1);
  });

  it("counts notes and tolerates malformed rows", () => {
    const s = computeRunStats([
      { ...base, notes_filed: ["a"] },
      { ...base, notes_filed: null as never, timings: [null, { tier: "bogus", ms: 5, ok: true }, { tier: "args", ms: "40", ok: true }] as never, cost_micro_usd: null as never },
    ]);
    expect(s.notes_filed).toBe(1);
    expect(s.avg_ms_by_tier).toEqual({ args: 40 });
  });
});

// Minimal stand-in for the supabase-js query builder: records calls, returns queued results per "table.op".
function fakeDb(results: Record<string, Array<{ data?: unknown; error?: { message: string } | null; count?: number }>>) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const next = (key: string) => {
    const r = results[key]?.shift() ?? {};
    return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null };
  };
  const builder = (table: string) => {
    let op = "";
    const b: any = { then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(next(`${table}.${op}`)).then(ok, bad) };
    for (const m of ["insert", "select", "delete", "update", "upsert", "eq", "order", "limit", "range", "single", "maybeSingle"]) {
      b[m] = (...args: unknown[]) => {
        calls.push({ op: `${table}.${m}`, args });
        if (!op && ["insert", "select", "delete", "update", "upsert"].includes(m)) op = m;
        return b;
      };
    }
    return b;
  };
  return { db: { from: (t: string) => builder(t) }, calls };
}
const sb = (results: Parameters<typeof fakeDb>[0]) => {
  const f = fakeDb(results);
  return { s: new SupabaseRunStore("https://x.supabase.co", "k", f.db as never), calls: f.calls };
};
const ID = "0b9d7c2e-1f7a-4c1e-9a7b-2a3c4d5e6f70";
const row = {
  id: ID, created_at: "2026-10-17T22:00:00.5+00:00", agent_id: "swarm-001", swarm_id: "s1", task: "t", surface: null, status: "done",
  attestation: "unverified", assets: [{ asset_id: "web_fetch", p: 0.9 }], timings: [{ tier: "execute", ms: 10, ok: true }], raw_bytes: 100,
  distilled_bytes: 10, cost_micro_usd: { snap: 1.5 }, answer: "a", notes_filed: ["n"], error: null, finished_at: "2026-10-17T22:00:03+00:00",
};

describe("SupabaseRunStore (fake client)", () => {
  it("inserts only NewRun columns and maps the returned row", async () => {
    const { s, calls } = sb({ "runs.insert": [{ data: { ...row, status: "running", extra: "x" } }] });
    const r = await s.insertRun({ ...newRun(), payout_address: "0x1", identity: "me" } as never);
    expect(Object.keys(calls.find((c) => c.op === "runs.insert")!.args[0] as object).sort()).toEqual(["agent_id", "attestation", "surface", "swarm_id", "task"]);
    expect(r.created_at).toBe("2026-10-17T22:00:00.500Z");
    expect(r).not.toHaveProperty("extra");
    expect(r.status).toBe("running");
  });

  it("finishes with whitelisted columns, skipping non-UUID ids and empty patches", async () => {
    const { s, calls } = sb({ "runs.update": [{}] });
    await s.finishRun("not-a-uuid", { status: "done" });
    await s.finishRun(ID, {});
    expect(calls).toEqual([]);
    await s.finishRun(ID, { status: "done", answer: "x", id: "evil", created_at: "y", identity: "z" } as never);
    expect(calls.find((c) => c.op === "runs.update")!.args[0]).toEqual({ status: "done", answer: "x" });
    expect(calls.find((c) => c.op === "runs.eq")!.args).toEqual(["id", ID]);
  });

  it("surfaces Postgres errors", async () => {
    const { s } = sb({ "runs.update": [{ error: { message: "relation runs does not exist" } }], "runs.insert": [{ error: { message: "denied" } }] });
    await expect(s.finishRun(ID, { status: "done" })).rejects.toThrow(/finish run: relation runs/);
    await expect(s.insertRun(newRun())).rejects.toThrow(/insert run: denied/);
  });

  it("lists runs with swarm filter, newest first, clamped limit", async () => {
    const { s, calls } = sb({ "runs.select": [{ data: [row, { ...row, timings: '[{"tier":"snap","ms":1,"ok":true}]', status: "weird" }] }] });
    const list = await s.listRuns({ swarm_id: "s1", limit: 10_000 });
    expect(calls.map((c) => c.op)).toEqual(["runs.select", "runs.eq", "runs.order", "runs.limit"]);
    expect(calls[1].args).toEqual(["swarm_id", "s1"]);
    expect(calls[2].args).toEqual(["created_at", { ascending: false }]);
    expect(calls[3].args).toEqual([500]);
    expect(list[0]).toEqual(toRun(row));
    expect(list[1].timings).toEqual([{ tier: "snap", ms: 1, ok: true }]); // jsonb-as-string tolerated
    expect(list[1].status).toBe("running");
  });

  it("pages runStats 1000 rows at a time and stops on a short page", async () => {
    const page = Array.from({ length: 1000 }, () => row);
    const { s, calls } = sb({ "runs.select": [{ data: page }, { data: [row, { ...row, status: "failed", notes_filed: [] }] }] });
    const st = await s.runStats("s1");
    expect(calls.filter((c) => c.op === "runs.range").map((c) => c.args)).toEqual([[0, 999], [1000, 1999]]);
    expect(st).toMatchObject({ runs: 1002, done: 1001, failed: 1, notes_filed: 1001, cost_micro_usd_by_tier: { snap: 1503 } });
    expect(st.compression_ratio).toBeCloseTo(0.1);
  });

  it("upserts assets on id and maps catalog rows defensively", async () => {
    const { s, calls } = sb({
      "warehouse_assets.upsert": [{}],
      "warehouse_assets.select": [{ data: [{ ...DEFAULT_ASSETS[3], updated_at: "x" }, { id: "bad", kind: "nope", executor: "aze" }, { ...DEFAULT_ASSETS[0], input_schema: '{"type":"object"}', active: null }] }],
    });
    await s.upsertAssets([...DEFAULT_ASSETS]);
    const up = calls.find((c) => c.op === "warehouse_assets.upsert")!;
    expect(up.args[1]).toEqual({ onConflict: "id" });
    expect((up.args[0] as unknown[]).length).toBe(DEFAULT_ASSETS.length);
    const list = await s.listAssets();
    expect(list.map((a) => a.id)).toEqual(["web_fetch", "notes_query"]);
    expect(list[0]).not.toHaveProperty("updated_at");
    expect(list[1]).toMatchObject({ input_schema: { type: "object" }, active: true });
    await s.upsertAssets([]); // no call
    expect(calls.filter((c) => c.op === "warehouse_assets.upsert")).toHaveLength(1);
  });
});

describe("createRunStore", () => {
  it("is memory without Supabase env, Supabase with both vars, and side-effect free", () => {
    expect(createRunStore({})).toBeInstanceOf(MemoryRunStore);
    expect(createRunStore({ SUPABASE_URL: "https://x.supabase.co" })).toBeInstanceOf(MemoryRunStore);
    expect(createRunStore({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" })).toBeInstanceOf(SupabaseRunStore);
  });

  it("never throws at boot: a malformed SUPABASE_URL falls back to memory and logs no secret", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(createRunStore({ SUPABASE_URL: "not a url", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" })).toBeInstanceOf(MemoryRunStore);
    expect(err).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(err.mock.calls)).not.toContain("service-role-secret");
    err.mockRestore();
  });
});
