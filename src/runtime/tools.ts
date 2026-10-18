// Stream A: registers the `agent_run` MCP tool (runs the pipeline for one task). It SPENDS provider credits, so it
// needs RUNTIME_ACCESS_KEY (constant-time compare; never ADMIN_KEY, which must not ride in LLM-visible tool args), has
// a global 60 runs/hour limit and at most 3 runs in flight, and applies the same task rules as POST /admin/run.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "../types.js";
import { seedCatalog } from "./catalog.js";
import { createPipeline } from "./pipeline.js";
import type { AgentContext, Pipeline, RunStore, RuntimeDeps } from "./types.js";
import { hasControlChars, surfaceRule, taskTextRule } from "../swarm/tasks.js";

export const RUNS_PER_HOUR = 60;
export const MAX_IN_FLIGHT = 3;
const HOUR_MS = 3_600_000;

const json = (data: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
  ...(isError ? { isError: true } : {}),
});

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
/** Constant-time string equality (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** Sliding-window limiter: at most `max` acquisitions per `windowMs`. */
export function createLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits: number[] = [];
  return {
    tryAcquire(): { ok: true } | { ok: false; retry_after_s: number } {
      const t = now();
      while (hits.length && t - hits[0] >= windowMs) hits.shift();
      if (hits.length >= max) return { ok: false, retry_after_s: Math.max(1, Math.ceil((hits[0] + windowMs - t) / 1000)) };
      hits.push(t);
      return { ok: true };
    },
  };
}

const seeded = new WeakSet<RunStore>();
/** Seed the catalog once per RunStore (fire and forget; never during `mcp-use build`). */
export function seedOnce(runs: RunStore, env: NodeJS.ProcessEnv = process.env): void {
  if (env.MCP_USE_PHASE === "build" || seeded.has(runs)) return;
  seeded.add(runs);
  seedCatalog(runs, env)
    .then((a) => console.log(`[runtime] catalog seeded: ${a.length} assets (${a.filter((x) => x.active).length} active)`))
    .catch((e) => {
      seeded.delete(runs); // let a later registration retry
      console.error("[runtime] catalog seed failed:", String((e as Error)?.message ?? e).slice(0, 200));
    });
}

export function registerRuntimeTools(
  server: unknown,
  deps: { store: Store; runtime: RuntimeDeps; baseUrl?: string; env?: NodeJS.ProcessEnv; pipeline?: Pipeline; now?: () => number },
): void {
  const env = deps.env ?? process.env;
  const runtime = deps.runtime;
  seedOnce(runtime.runs, env);
  const pipeline = deps.pipeline ?? createPipeline(runtime.runs, runtime, { env });
  const limiter = createLimiter(RUNS_PER_HOUR, HOUR_MS, deps.now);
  let inFlight = 0;

  (server as { tool: (def: unknown, cb: (args: any, ctx?: unknown) => Promise<unknown>) => unknown }).tool(
    {
      name: "agent_run",
      title: "Run an agent task (operators only)",
      description:
        "Runs Aze's agent runtime on one task: checks Aze's known issues for the service first, picks warehouse assets (SubQ Snap), executes them, distills the output, renders an answer (Workers AI), and files any friction as an anonymous field note. Spends provider credits, so it needs the operator's access_key. Returns run_id, status, answer, per-tier timings and the ids of notes filed.",
      inputSchema: z.object({
        task: z.string().min(1).max(500).describe("One public, no-login task, e.g. 'What is the unauthenticated rate limit of the GitHub REST API?'"),
        surface: z.string().max(60).optional().describe("Public name of the main product or service the task is about"),
        access_key: z.string().max(256).describe("Operator access key (RUNTIME_ACCESS_KEY)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args: { task: string; surface?: string; access_key: string }) => {
      const keys = [env.RUNTIME_ACCESS_KEY].filter((k): k is string => typeof k === "string" && k.length > 0);
      if (!keys.length) return json({ ok: false, code: "disabled", hint: "agent_run is disabled on this server: no access key is configured. Nothing was run or charged." }, true);
      const given = typeof args?.access_key === "string" ? args.access_key : "";
      let match = false;
      for (const k of keys) match = safeEqual(given, k) || match; // check every key; no early exit
      if (!match) return json({ ok: false, code: "unauthorized", hint: "Wrong or missing access_key. Nothing was run." }, true);
      // The task goes to the models and into the run log: same rules as POST /admin/run. Rejections name the rule only.
      const task = typeof args?.task === "string" && !hasControlChars(args.task) ? args.task.replace(/\s+/g, " ").trim() : "";
      if (!task || task.length > 500) return json({ ok: false, code: "invalid_task", hint: "task must be 1-500 characters of plain text." }, true);
      const tRule = taskTextRule(task);
      if (tRule) return json({ ok: false, code: "invalid_task", rule: tRule, hint: "Remove credentials, secrets, emails, private hosts, invisible characters and instructions aimed at the model. Nothing was run." }, true);
      const surface = typeof args?.surface === "string" && args.surface.trim() ? args.surface.replace(/\s+/g, " ").trim() : null;
      const sRule = surface ? surfaceRule(surface) : null;
      if (sRule) return json({ ok: false, code: "invalid_surface", rule: sRule, hint: "surface must be a public product name. Nothing was run." }, true);
      if (inFlight >= MAX_IN_FLIGHT) return json({ ok: false, code: "busy", hint: `At most ${MAX_IN_FLIGHT} agent runs at a time; try again when one finishes. Nothing was run.` }, true);
      const slot = limiter.tryAcquire();
      if (!slot.ok) return json({ ok: false, code: "rate_limited", hint: `agent_run is limited to ${RUNS_PER_HOUR} runs per hour; try again later.`, retry_after_s: slot.retry_after_s }, true);

      const ctx: AgentContext = { agent_id: "agent_run", swarm_id: null, attestation: "unverified", payout_address: null, machine: null, identity: null };
      let r;
      inFlight++;
      try {
        r = await pipeline.run(task, surface, ctx);
      } catch (e) {
        // Pipeline.run never throws by contract; a tool handler must not either.
        console.error("[agent_run] pipeline error:", String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 160));
        return json({ ok: false, code: "run_failed", hint: "The run failed before it could be logged." }, true);
      } finally {
        inFlight--;
      }
      return json(
        { run_id: r.id, status: r.status, answer: r.answer, timings: r.timings, notes_filed: r.notes_filed, cost_micro_usd: r.cost_micro_usd, error: r.error },
        r.status === "failed",
      );
    },
  );
}
