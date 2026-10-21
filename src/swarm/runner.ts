// Stream E: the swarm runner. A swarm = N agents (1..100), each one real run of the runtime pipeline on one public
// micro-task, `concurrency` (1..10) at a time. One swarm at a time per runner; stop() aborts the queue (runs already
// in flight finish; the Pipeline contract has no cancel). State lives in memory only (it resets on restart); every
// run is also logged by the pipeline in the RunStore.
// The state never holds payout addresses or identities: the address goes straight into the run's AgentContext.
import { randomBytes } from "node:crypto";
import type { AgentContext, RunRecord, RunStore } from "../runtime/types.js";

/** What the runner needs from the pipeline: one run per task (the decide-only Pipeline satisfies it). */
export interface Pipeline {
  run(task: string, surface: string | null, ctx: AgentContext): Promise<RunRecord>;
}
import { loadTasks, type SwarmTask } from "./tasks.js";
import type { Wallets } from "./wallets.js";

export const MAX_AGENTS = 100;
export const MAX_CONCURRENCY = 10;
export const DEFAULT_CONCURRENCY = 6;
/** Watchdog per agent. The real pipeline stops itself at ~120 s (+ store timeouts); this only catches a run that never
 * settles, so one hung run cannot hold the one-swarm slot (409 for every new swarm) until the next restart. */
export const AGENT_TIMEOUT_MS = 180_000;

export type AgentStatus = "queued" | "running" | "done" | "failed" | "stopped";
export type SwarmStatus = "running" | "stopping" | "done" | "stopped";
export const AGENT_STATUSES: readonly AgentStatus[] = ["queued", "running", "done", "failed", "stopped"];

/** One grid cell. Public by design: no payout address, no identity, no machine. */
export interface AgentState {
  agent_id: string; // "swarm-001"
  task_id: string;
  surface: string;
  status: AgentStatus; // "stopped" = never started because the operator stopped the swarm
  run_id: string | null;
  ms: number | null; // wall time of the run
  notes_filed: number;
  error: string | null; // the run's own error text (public RunRecord field), truncated
}

export interface SwarmState {
  swarm_id: string;
  status: SwarmStatus;
  n: number;
  concurrency: number;
  task_source: "file" | "builtin" | "custom";
  task_count: number;
  payout_addresses: boolean; // whether HD payout addresses were configured (the addresses are never shown)
  started_at: string;
  finished_at: string | null;
  counts: Record<AgentStatus, number>;
  agents: AgentState[];
}

export interface StartOptions {
  n: number;
  concurrency?: number;
  /** The pipeline, or a factory called once when the first agent starts (lazy). */
  pipeline: Pipeline | (() => Pipeline);
  /** Optional; the pipeline logs every run itself, so the runner does not need it. */
  runs?: RunStore;
  /** Defaults to loadTasks() (Muse's file, else the built-in list). */
  tasks?: SwarmTask[];
  task_source?: SwarmState["task_source"];
  wallets?: Wallets | null;
  /** Called once with the final state when the swarm has finished (e.g. to refund runs a stop kept from starting).
   * Errors it throws are ignored. */
  onFinish?: (s: SwarmState) => void;
}

export class SwarmBusyError extends Error {
  readonly code = "swarm_running";
  constructor(readonly swarm_id: string) {
    super(`swarm ${swarm_id} is still running`);
  }
}

export class SwarmInputError extends Error {
  readonly code = "invalid_input";
}

const pad = (i: number) => String(i).padStart(3, "0");
const short = (s: unknown, n = 160) => (typeof s === "string" && s ? s.replace(/\s+/g, " ").slice(0, n) : null);

/** Integer in [min, max], or the default when undefined; anything else is an input error. */
export function intInRange(v: unknown, min: number, max: number, dflt: number | undefined, name: string): number {
  if (v === undefined || v === null || v === "") {
    if (dflt === undefined) throw new SwarmInputError(`${name} is required (${min}-${max})`);
    return dflt;
  }
  const x = typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
  if (typeof x !== "number" || !Number.isInteger(x) || x < min || x > max) throw new SwarmInputError(`${name} must be an integer ${min}-${max}`);
  return x;
}

/** Resolve with `p`, or reject after `ms`. The run is not cancelled (the Pipeline has no cancel); a late result or
 * rejection is ignored, and the pipeline still logs that run in the RunStore itself. */
function settleWithin<T>(p: Promise<T>, ms: number): Promise<T> {
  const run = Promise.resolve(p);
  run.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`no result after ${ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`}`)), ms);
  });
  return Promise.race([run, limit]).finally(() => clearTimeout(timer));
}

const copyState = (s: SwarmState): SwarmState => ({ ...s, counts: { ...s.counts }, agents: s.agents.map((a) => ({ ...a })) });

interface Live {
  state: SwarmState;
  aborted: boolean;
  done: Promise<void>;
}

export class SwarmRunner {
  private live: Live | null = null;
  private readonly now: () => number;
  private readonly agentTimeoutMs: number;
  constructor(opts: { now?: () => number; agentTimeoutMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.agentTimeoutMs = opts.agentTimeoutMs && opts.agentTimeoutMs > 0 ? opts.agentTimeoutMs : AGENT_TIMEOUT_MS;
  }

  /** True while a swarm is running or stopping (its in-flight runs have not finished). */
  busy(): boolean {
    return this.live !== null && (this.live.state.status === "running" || this.live.state.status === "stopping");
  }

  /** Starts a swarm in the background and returns its id. Throws SwarmBusyError or SwarmInputError. */
  start(opts: StartOptions): string {
    if (this.busy()) throw new SwarmBusyError(this.live!.state.swarm_id);
    const n = intInRange(opts.n, 1, MAX_AGENTS, undefined, "n");
    const concurrency = intInRange(opts.concurrency, 1, MAX_CONCURRENCY, DEFAULT_CONCURRENCY, "concurrency");
    if (!opts.pipeline) throw new SwarmInputError("pipeline is required");
    let tasks = opts.tasks;
    let source: SwarmState["task_source"] = opts.task_source ?? "custom";
    if (!tasks) {
      const loaded = loadTasks();
      tasks = loaded.tasks;
      source = loaded.source;
    }
    if (!tasks.length) throw new SwarmInputError("no tasks to run");
    const list = tasks.slice();
    const wallets = opts.wallets ?? null;
    let payout = false;
    try {
      payout = wallets?.status() === "configured";
    } catch {
      payout = false;
    }

    const swarm_id = `sw-${randomBytes(4).toString("hex")}`;
    const agents: AgentState[] = Array.from({ length: n }, (_, i) => {
      const t = list[i % list.length];
      return { agent_id: `swarm-${pad(i + 1)}`, task_id: t.id, surface: t.surface, status: "queued", run_id: null, ms: null, notes_filed: 0, error: null };
    });
    const state: SwarmState = {
      swarm_id, status: "running", n, concurrency, task_source: source, task_count: list.length, payout_addresses: payout,
      started_at: new Date(this.now()).toISOString(), finished_at: null,
      counts: { queued: n, running: 0, done: 0, failed: 0, stopped: 0 }, agents,
    };
    const live: Live = { state, aborted: false, done: Promise.resolve() };
    this.live = live;

    let pipeline: Pipeline | null = null;
    const getPipeline = (): Pipeline => (pipeline ??= typeof opts.pipeline === "function" ? (opts.pipeline as () => Pipeline)() : opts.pipeline);
    const set = (a: AgentState, s: AgentStatus) => {
      state.counts[a.status]--;
      a.status = s;
      state.counts[s]++;
    };

    const runOne = async (i: number) => {
      const a = agents[i];
      const t = list[i % list.length];
      set(a, "running");
      const t0 = this.now();
      let r: RunRecord | null = null;
      let err: string | null = null;
      try {
        let payout_address: string | null = null;
        try {
          payout_address = wallets?.address(i) ?? null;
        } catch {
          payout_address = null;
        }
        const ctx: AgentContext = { agent_id: a.agent_id, swarm_id, attestation: "unverified", payout_address, machine: null, identity: null };
        r = await settleWithin(getPipeline().run(t.task, t.surface, ctx), this.agentTimeoutMs);
      } catch (e) {
        err = `runner: ${short((e as Error)?.message ?? String(e), 120) ?? "error"}`;
      }
      a.ms = Math.max(0, this.now() - t0);
      a.run_id = typeof r?.id === "string" ? r.id : null;
      a.notes_filed = Array.isArray(r?.notes_filed) ? r!.notes_filed.length : 0;
      a.error = err ?? short(r?.error);
      set(a, r?.status === "done" && !err ? "done" : "failed");
    };

    let cursor = 0;
    const worker = async () => {
      while (!live.aborted && cursor < n) {
        const i = cursor++;
        try {
          await runOne(i);
        } catch {
          // runOne never throws; this is belt and braces so one agent can't stop the swarm.
        }
      }
    };
    live.done = Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker))
      .then(() => undefined, () => undefined)
      .finally(() => {
        state.status = live.aborted ? "stopped" : "done";
        state.finished_at = new Date(this.now()).toISOString();
        try {
          opts.onFinish?.(copyState(state));
        } catch {
          // a reporting hook must not break the runner
        }
      });
    return swarm_id;
  }

  /** Abort the queue: agents not yet started become "stopped"; runs in flight finish. */
  stop(): { stopped: boolean; swarm_id: string | null } {
    const live = this.live;
    if (!live || !this.busy()) return { stopped: false, swarm_id: live?.state.swarm_id ?? null };
    if (!live.aborted) {
      live.aborted = true;
      for (const a of live.state.agents) {
        if (a.status === "queued") {
          live.state.counts.queued--;
          a.status = "stopped";
          live.state.counts.stopped++;
        }
      }
      if (live.state.status === "running") live.state.status = "stopping";
    }
    return { stopped: true, swarm_id: live.state.swarm_id };
  }

  /** A copy of the current (or last) swarm's state, or null if none ran since boot. */
  state(): SwarmState | null {
    return this.live ? copyState(this.live.state) : null;
  }

  /** Resolves when the current swarm (if any) has finished. For tests and graceful shutdown. */
  async whenIdle(): Promise<void> {
    await this.live?.done;
  }
}

/** One runner per process: the admin routes use it so only one swarm runs at a time. */
export const defaultRunner = new SwarmRunner();
export const startSwarm = (opts: StartOptions) => defaultRunner.start(opts);
export const stopSwarm = () => defaultRunner.stop();
export const swarmState = () => defaultRunner.state();
