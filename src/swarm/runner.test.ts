import { describe, expect, it, vi } from "vitest";
import type { AgentContext, Pipeline, RunRecord } from "../runtime/types.js";
import { DEFAULT_CONCURRENCY, intInRange, SwarmBusyError, SwarmInputError, SwarmRunner } from "./runner.js";
import type { SwarmTask } from "./tasks.js";
import { createWallets } from "./wallets.js";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const TASKS: SwarmTask[] = [
  { id: "a", surface: "GitHub", task: "task A https://api.github.com/rate_limit" },
  { id: "b", surface: "npm", task: "task B" },
  { id: "c", surface: "PyPI", task: "task C" },
];

const record = (task: string, ctx: AgentContext, over: Partial<RunRecord> = {}): RunRecord => ({
  id: `run-${ctx.agent_id}`, created_at: new Date().toISOString(), agent_id: ctx.agent_id, swarm_id: ctx.swarm_id, task, surface: null,
  status: "done", attestation: ctx.attestation, assets: [], timings: [], raw_bytes: null, distilled_bytes: null, cost_micro_usd: {},
  answer: "ok", notes_filed: [], error: null, finished_at: new Date().toISOString(), ...over,
});

/** A pipeline whose runs stay open until released; tracks how many are in flight. */
function gatedPipeline(result: (task: string, ctx: AgentContext) => Partial<RunRecord> = () => ({})) {
  const calls: Array<{ task: string; surface: string | null; ctx: AgentContext }> = [];
  const gates: Array<() => void> = [];
  let inFlight = 0, maxInFlight = 0;
  const pipeline: Pipeline = {
    async run(task, surface, ctx) {
      calls.push({ task, surface, ctx });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => gates.push(r));
      inFlight--;
      return record(task, ctx, result(task, ctx));
    },
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    pipeline, calls, gates, tick,
    get inFlight() { return inFlight; },
    get maxInFlight() { return maxInFlight; },
    /** Release every open run until the swarm finishes. */
    async drain(runner: SwarmRunner) {
      while (runner.busy()) {
        gates.splice(0).forEach((g) => g());
        await tick();
      }
    },
  };
}

describe("SwarmRunner", () => {
  it("runs n agents with at most `concurrency` in flight, with the right ids, tasks and context", async () => {
    const runner = new SwarmRunner();
    const g = gatedPipeline((_t, ctx) => (ctx.agent_id === "swarm-005" ? { notes_filed: ["n1", "n2"] } : {}));
    const wallets = createWallets({ SWARM_SEED: TEST_MNEMONIC });
    const id = runner.start({ n: 20, concurrency: 4, pipeline: g.pipeline, tasks: TASKS, task_source: "builtin", wallets });
    expect(id).toMatch(/^sw-[0-9a-f]{8}$/);
    await g.tick();
    expect(g.inFlight).toBe(4);
    expect(runner.state()!.counts).toEqual({ queued: 16, running: 4, done: 0, failed: 0, stopped: 0 });
    await g.drain(runner);
    expect(g.maxInFlight).toBe(4);
    expect(g.calls).toHaveLength(20);

    const s = runner.state()!;
    expect(s.status).toBe("done");
    expect(s.finished_at).not.toBeNull();
    expect(s.counts).toEqual({ queued: 0, running: 0, done: 20, failed: 0, stopped: 0 });
    expect(s.agents.map((a) => a.agent_id).slice(0, 3)).toEqual(["swarm-001", "swarm-002", "swarm-003"]);
    expect(s.agents[19].agent_id).toBe("swarm-020");
    expect(s.agents.map((a) => a.task_id).slice(0, 5)).toEqual(["a", "b", "c", "a", "b"]);
    expect(s.agents[4].notes_filed).toBe(2);
    expect(s.agents[0]).toMatchObject({ status: "done", run_id: "run-swarm-001", error: null });
    expect(typeof s.agents[0].ms).toBe("number");

    const byAgent = new Map(g.calls.map((c) => [c.ctx.agent_id, c]));
    const c3 = byAgent.get("swarm-003")!;
    expect(c3.task).toBe("task C");
    expect(c3.surface).toBe("PyPI");
    expect(c3.ctx).toEqual({
      agent_id: "swarm-003", swarm_id: id, attestation: "unverified", payout_address: wallets.address(2), machine: null, identity: null,
    });
    // the grid state never carries payout addresses
    expect(JSON.stringify(s)).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(JSON.stringify(s)).not.toContain('"payout_address"');
  });

  it("marks failed runs, thrown runs and missing wallets honestly", async () => {
    const runner = new SwarmRunner();
    const pipeline: Pipeline = {
      async run(task, _s, ctx) {
        expect(ctx.payout_address).toBeNull();
        if (ctx.agent_id === "swarm-002") throw new Error("boom\nsecond line");
        return record(task, ctx, ctx.agent_id === "swarm-003" ? { status: "failed", error: "soft deadline (120 s) exceeded at render" } : {});
      },
    };
    runner.start({ n: 3, pipeline, tasks: TASKS, wallets: createWallets({}) });
    await runner.whenIdle();
    const s = runner.state()!;
    expect(s.payout_addresses).toBe(false);
    expect(s.task_source).toBe("custom");
    expect(s.agents.map((a) => a.status)).toEqual(["done", "failed", "failed"]);
    expect(s.agents[1]).toMatchObject({ run_id: null, error: "runner: boom second line" });
    expect(s.agents[2].error).toBe("soft deadline (120 s) exceeded at render");
    expect(s.counts).toMatchObject({ done: 1, failed: 2 });
  });

  it("allows one swarm at a time, and a new one after it finishes", async () => {
    const runner = new SwarmRunner();
    const g = gatedPipeline();
    const first = runner.start({ n: 2, concurrency: 2, pipeline: g.pipeline, tasks: TASKS });
    expect(() => runner.start({ n: 2, pipeline: g.pipeline, tasks: TASKS })).toThrow(SwarmBusyError);
    try {
      runner.start({ n: 2, pipeline: g.pipeline, tasks: TASKS });
    } catch (e) {
      expect((e as SwarmBusyError).swarm_id).toBe(first);
    }
    await g.drain(runner);
    const second = runner.start({ n: 1, pipeline: g.pipeline, tasks: TASKS });
    expect(second).not.toBe(first);
    await g.drain(runner);
    expect(runner.state()!.swarm_id).toBe(second);
  });

  it("stop() aborts the queue: queued agents become stopped, runs in flight finish", async () => {
    const runner = new SwarmRunner();
    const g = gatedPipeline();
    const id = runner.start({ n: 10, concurrency: 2, pipeline: g.pipeline, tasks: TASKS });
    await g.tick();
    expect(runner.stop()).toEqual({ stopped: true, swarm_id: id });
    let s = runner.state()!;
    expect(s.status).toBe("stopping");
    expect(s.counts).toEqual({ queued: 0, running: 2, done: 0, failed: 0, stopped: 8 });
    expect(runner.busy()).toBe(true);
    await g.drain(runner);
    s = runner.state()!;
    expect(s.status).toBe("stopped");
    expect(s.counts).toEqual({ queued: 0, running: 0, done: 2, failed: 0, stopped: 8 });
    expect(g.calls).toHaveLength(2); // nothing started after stop
    expect(runner.stop()).toEqual({ stopped: false, swarm_id: id });
  });

  it("stop() with nothing running is a no-op", () => {
    expect(new SwarmRunner().stop()).toEqual({ stopped: false, swarm_id: null });
    expect(new SwarmRunner().state()).toBeNull();
  });

  it("builds a lazy pipeline once, on the first agent", async () => {
    const runner = new SwarmRunner();
    const factory = vi.fn((): Pipeline => ({ run: async (task, _s, ctx) => record(task, ctx) }));
    runner.start({ n: 5, concurrency: 3, pipeline: factory, tasks: TASKS });
    await runner.whenIdle();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(runner.state()!.counts.done).toBe(5);
  });

  it("a run that never settles is failed by the watchdog, so the swarm (and the one-swarm slot) still finishes", async () => {
    const runner = new SwarmRunner({ agentTimeoutMs: 30 });
    const pipeline: Pipeline = {
      run: (task, _s, ctx) => (ctx.agent_id === "swarm-002" ? new Promise<RunRecord>(() => {}) : Promise.resolve(record(task, ctx))),
    };
    runner.start({ n: 3, concurrency: 1, pipeline, tasks: TASKS });
    await runner.whenIdle();
    const s = runner.state()!;
    expect(s.status).toBe("done");
    expect(s.agents.map((a) => a.status)).toEqual(["done", "failed", "done"]); // swarm-003 still ran after the hang
    expect(s.agents[1]).toMatchObject({ run_id: null, error: "runner: no result after 30 ms" });
    expect(runner.busy()).toBe(false);
    expect(() => runner.start({ n: 1, pipeline, tasks: TASKS })).not.toThrow();
  });

  it("calls onFinish once with the final state (stopped count included); a throwing hook changes nothing", async () => {
    const runner = new SwarmRunner();
    const g = gatedPipeline();
    const seen: Array<{ status: string; stopped: number; done: number }> = [];
    runner.start({ n: 6, concurrency: 2, pipeline: g.pipeline, tasks: TASKS, onFinish: (s) => seen.push({ status: s.status, stopped: s.counts.stopped, done: s.counts.done }) });
    await g.tick();
    runner.stop();
    await g.drain(runner);
    expect(seen).toEqual([{ status: "stopped", stopped: 4, done: 2 }]);
    runner.start({ n: 1, pipeline: g.pipeline, tasks: TASKS, onFinish: () => { throw new Error("hook"); } });
    await g.drain(runner);
    expect(runner.state()).toMatchObject({ status: "done", counts: { done: 1 } });
    expect(runner.busy()).toBe(false);
  });

  it("validates n and concurrency", () => {
    const runner = new SwarmRunner();
    const pipeline: Pipeline = { run: async (task, _s, ctx) => record(task, ctx) };
    for (const bad of [{ n: 0 }, { n: 101 }, { n: 2.5 }, { n: "x" }, { n: undefined }, { n: 5, concurrency: 0 }, { n: 5, concurrency: 11 }]) {
      expect(() => runner.start({ ...(bad as { n: number }), pipeline, tasks: TASKS })).toThrow(SwarmInputError);
    }
    expect(() => runner.start({ n: 1, pipeline, tasks: [] })).toThrow(SwarmInputError);
    expect(intInRange(undefined, 1, 10, DEFAULT_CONCURRENCY, "c")).toBe(6);
    expect(intInRange("7", 1, 10, undefined, "c")).toBe(7);
    runner.start({ n: "3" as unknown as number, pipeline, tasks: TASKS });
    expect(runner.state()).toMatchObject({ n: 3, concurrency: DEFAULT_CONCURRENCY });
  });
});
