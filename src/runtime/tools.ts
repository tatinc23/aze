// Stream A: registers the `agent_run` MCP tool, decide-only (Ken, 2026-10-20): the caller sends a task and its own
// candidate tools; Aze checks the map for each tool's service, SubQ Snap picks the tools that fit, and the result
// carries the decisions, the advisories that apply and one next-step line. The caller's LLM runs the tools and answers.
// Snap calls cost credits, so it needs RUNTIME_ACCESS_KEY (constant-time compare; never ADMIN_KEY, which must not
// ride in LLM-visible tool args), has a global 60 runs/hour limit and at most 3 runs in flight, and applies the same
// task rules as POST /admin/run to the task and to every tool description (they all reach Snap).
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { KINDS, type Store } from "../types.js";
import { seedCatalog } from "./catalog.js";
import { createPipeline, MAX_CANDIDATES } from "./pipeline.js";
import type { AgentContext, Candidate, Pipeline, RunStore, RuntimeDeps } from "./types.js";
import { hasControlChars, surfaceRule, taskTextRule } from "../swarm/tasks.js";

export const RUNS_PER_HOUR = 60;
export const MAX_IN_FLIGHT = 3;
const HOUR_MS = 3_600_000;
/** MCP tool names: letters, digits, _ - . : / (e.g. "web_search", "github.create_issue"). */
export const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,79}$/;
export const TOOL_DESCRIPTION_MAX = 300;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Check the caller's tools. Rejections name the rule and the tool's position only (never echo the text). */
export function checkTools(tools: unknown): { ok: true; tools: Candidate[] } | { ok: false; index: number; rule: string } {
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > MAX_CANDIDATES) return { ok: false, index: -1, rule: "count" };
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const [i, t] of tools.entries()) {
    const name = typeof t?.name === "string" ? t.name.trim() : "";
    if (!TOOL_NAME_RE.test(name)) return { ok: false, index: i, rule: "name" };
    if (seen.has(name.toLowerCase())) return { ok: false, index: i, rule: "duplicate_name" };
    seen.add(name.toLowerCase());
    const description = typeof t?.description === "string" && !hasControlChars(t.description) ? oneLine(t.description) : "";
    if (!description || description.length > TOOL_DESCRIPTION_MAX) return { ok: false, index: i, rule: "description" };
    const dRule = taskTextRule(description);
    if (dRule) return { ok: false, index: i, rule: `description:${dRule}` };
    const surface = typeof t?.surface === "string" && t.surface.trim() ? oneLine(t.surface) : null;
    if (surface && surfaceRule(surface)) return { ok: false, index: i, rule: `surface:${surfaceRule(surface)}` };
    out.push({ id: name, description, surface });
  }
  return { ok: true, tools: out };
}

const advisoryShape = z.object({
  surface: z.string().describe("Normalized service key the advisory was filed under."),
  note_id: z.string().describe("Pass to notes_unlock for the full workaround when has_workaround is true."),
  kind: z.enum(KINDS), what: z.string(), tool: z.string().nullable().describe("The tool it was filed against; null = the whole service."),
  reports: z.number().describe("How many notes report the same service, tool and error class."),
  verified: z.boolean(), label: z.enum(["VERIFIED", "UNVERIFIED"]), has_workaround: z.boolean(),
  teaser: z.string().nullable().describe("Start of the workaround, when there is one."),
  price_usdc: z.string().nullable().describe("Test USDC price to unlock the workaround, when there is one."),
});
/** agent_run's structuredContent. Error results are isError and carry only ok/code/hint (fields optional below). */
export const runOutput = z.object({
  ok: z.boolean().optional().describe("false when the call was refused (with code and hint); absent on a run result."),
  code: z.string().optional().describe("Machine-readable error code when the call was refused."),
  hint: z.string().optional().describe("What to do about the error."),
  rule: z.string().optional().describe("Which input rule was broken, when the input was refused."),
  index: z.number().optional().describe("Position of the tool that broke a rule, when a tool was refused."),
  retry_after_s: z.number().optional().describe("Seconds to wait before retrying when rate limited."),
  run_id: z.string().optional().describe("Id of this run in the run log."),
  status: z.enum(["done", "failed"]).optional().describe("done when Snap ranked the tools; failed when it could not (advisories are still returned)."),
  decided_by: z.string().nullable().optional().describe("The model that ranked the tools, e.g. 'SubQ Snap (subq-snap-preview)'; null when none could."),
  chosen: z.array(z.object({ tool: z.string(), p: z.number() })).optional()
    .describe(`The tools to call, best first: Snap's probability that the task needs each one (p >= 0.5, at most 3).`),
  scores: z.array(z.object({ tool: z.string(), p: z.number() })).optional().describe("Snap's probability for every candidate tool, highest first."),
  advisories: z.array(advisoryShape).optional().describe("Known issues that apply to the chosen tools (to every candidate when nothing was ranked)."),
  next: z.string().optional().describe("What to do now: run the chosen tools yourself and file friction with notes_file."),
  cost_micro_usd: z.object({ snap: z.number().nullable().optional() }).optional().describe("Snap cost of this run in micro-USD; null = price unknown."),
  error: z.string().nullable().optional().describe("Why Snap could not rank the tools, when it could not."),
});

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
  const pipeline = deps.pipeline ?? createPipeline({ store: deps.store, runs: runtime.runs, router: runtime.router }, { env });
  const limiter = createLimiter(RUNS_PER_HOUR, HOUR_MS, deps.now);
  let inFlight = 0;

  (server as { tool: (def: unknown, cb: (args: any, ctx?: unknown) => Promise<unknown>) => unknown }).tool(
    {
      name: "agent_run",
      title: "Pick tools for a task (operators only)",
      description:
        "Decides which of your tools a task needs, before you call them. Send the task and your candidate tools (name, one-line description, and the public service each belongs to). Aze checks its map of known issues for each service, SubQ Snap scores every tool for the task, and you get back the chosen tools with their probabilities, the known issues that apply to them, and a next step. Aze does not run tools or write answers: you call the chosen tools yourself, answer the task, and file a note with notes_file if a tool blocks or slows you. Snap calls cost credits, so this needs the operator's access_key.",
      inputSchema: z.object({
        task: z.string().min(1).max(500).describe("The task you are about to do, in one or two plain sentences, e.g. 'Find the unauthenticated rate limit of the GitHub REST API'. No credentials, emails or private names."),
        tools: z.array(z.object({
          name: z.string().min(1).max(80).describe("The tool's name as you would call it, e.g. 'web_fetch' or 'github.search_code'."),
          description: z.string().min(1).max(TOOL_DESCRIPTION_MAX).describe("What the tool does, in one sentence. Snap reads it to decide."),
          surface: z.string().max(60).optional().describe("Public name of the product or service the tool belongs to, e.g. 'GitHub'. Its known issues are checked. Defaults to the top-level surface."),
        })).min(1).max(MAX_CANDIDATES).describe(`Your candidate tools, 1 to ${MAX_CANDIDATES}. Snap picks from these only.`),
        surface: z.string().max(60).optional().describe("Public name of the main product or service the task is about; used for tools that name none."),
        access_key: z.string().max(256).describe("Operator access key (RUNTIME_ACCESS_KEY)"),
      }),
      outputSchema: runOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: { task: string; tools: unknown; surface?: string; access_key: string }) => {
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
      const checked = checkTools(args?.tools);
      if (!checked.ok) {
        return json({
          ok: false, code: "invalid_tools", rule: checked.rule, ...(checked.index >= 0 ? { index: checked.index } : {}),
          hint: `Send 1-${MAX_CANDIDATES} tools, each with a unique name (letters, digits, _ - . : /), a one-sentence description of at most ${TOOL_DESCRIPTION_MAX} characters without credentials, emails, private hosts or instructions to the model, and an optional public service name. Nothing was run.`,
        }, true);
      }
      if (inFlight >= MAX_IN_FLIGHT) return json({ ok: false, code: "busy", hint: `At most ${MAX_IN_FLIGHT} agent runs at a time; try again when one finishes. Nothing was run.` }, true);
      const slot = limiter.tryAcquire();
      if (!slot.ok) return json({ ok: false, code: "rate_limited", hint: `agent_run is limited to ${RUNS_PER_HOUR} runs per hour; try again later.`, retry_after_s: slot.retry_after_s }, true);

      const ctx: AgentContext = { agent_id: "agent_run", swarm_id: null, attestation: "unverified", payout_address: null, machine: null, identity: null };
      let r;
      inFlight++;
      try {
        r = await pipeline.run(task, surface, ctx, checked.tools);
      } catch (e) {
        // Pipeline.run never throws by contract; a tool handler must not either.
        console.error("[agent_run] pipeline error:", String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 160));
        return json({ ok: false, code: "run_failed", hint: "The run failed before it could be logged." }, true);
      } finally {
        inFlight--;
      }
      const d = r.decision;
      return json(
        {
          run_id: r.id, status: r.status, decided_by: d.decided_by, chosen: r.assets.map((a) => ({ tool: a.asset_id, p: a.p })), scores: d.scores,
          advisories: d.advisories, next: d.next, cost_micro_usd: r.cost_micro_usd, error: r.error,
        },
        r.status === "failed",
      );
    },
  );
}
