import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SYSTEM_ONE_FALLBACK, DEFAULT_SYSTEM_ONE_MODEL, WorkersAiDecider, createWorkersAiSystemOne, systemOneConfig, systemOnePrompt, toSnapAnswers,
} from "./workers-ai-systemone.js";
import { createEnsembleRouter } from "../subq/ensemble.js";
import { createRouter } from "../subq/snap.js";
import { choiceOf, noulOf, scoreLevelOf, type SnapQuestion } from "../subq/wire.js";
import { buildRuntime } from "../runtime/deps.js";
import { MemoryStore } from "../store/memory.js";
import type { Asset, Router } from "../runtime/types.js";

const CREDS = { CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CF_API_TOKEN: "cf-test-token-abcdefghijklmnop" };
const ENV = { ...CREDS, SYSTEM_ONE_CF: "on" };
const reply = (response: string) =>
  new Response(JSON.stringify({ success: true, errors: [], result: { response, usage: { prompt_tokens: 50, completion_tokens: 10 } } }), { status: 200 });

const Q: Record<string, SnapQuestion> = {
  needed: { type: "noul", instructions: "The task needs web_fetch.", criteria: { true: "needed", false: "not needed" } },
  kind: { type: "choice", instructions: "Kind of problem.", options: { outage: "down", docs: "docs wrong" } },
  severity: { type: "score", instructions: "How bad.", levels: ["1 mild", "2 bad", "3 total outage"] },
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); warn.mockRestore(); });

describe("systemOneConfig", () => {
  it("is opt-in: off unless SYSTEM_ONE_CF=on", () => {
    expect(systemOneConfig(CREDS)).toBeNull();
    for (const v of ["off", "", "nope"]) expect(systemOneConfig({ ...CREDS, SYSTEM_ONE_CF: v })).toBeNull();
    for (const v of ["on", "ON", "1", "true", "yes"]) expect(systemOneConfig({ ...CREDS, SYSTEM_ONE_CF: v })).not.toBeNull();
  });

  it("uses a fast non-reasoning Llama with a 70B fallback; off without CF credentials or with SYSTEM_ONE_CF=off", () => {
    const cfg = systemOneConfig(ENV)!;
    expect(cfg.model).toBe(DEFAULT_SYSTEM_ONE_MODEL);
    expect(cfg.fallbackModel).toBe(DEFAULT_SYSTEM_ONE_FALLBACK);
    expect(cfg.reasoningEffort).toBeNull();
    expect(systemOneConfig({ SYSTEM_ONE_CF: "on" })).toBeNull();
    expect(systemOneConfig({ ...ENV, SYSTEM_ONE_CF: "off" })).toBeNull();
    expect(systemOneConfig({ ...ENV, SYSTEM_ONE_CF_FALLBACK_MODEL: "off" })!.fallbackModel).toBeNull();
    expect(systemOneConfig({ ...ENV, SYSTEM_ONE_CF_MODEL: "not a model" })!.model).toBe(DEFAULT_SYSTEM_ONE_MODEL);
  });
});

describe("System One answers from Workers AI", () => {
  it("prompts every question with its answer shape", () => {
    const p = systemOnePrompt("STATE TEXT", Q);
    expect(p).toContain("STATE TEXT");
    expect(p).toContain('"needed" (yes/no)');
    expect(p).toContain('"kind" (choice)');
    expect(p).toContain("3 = 3 total outage");
  });

  it("maps noul/choice/score onto the Snap answer shape the parsers read; drops unusable answers", () => {
    const a = toSnapAnswers({ answers: { needed: { p_yes: 0.83 }, kind: { choice: "outage" }, severity: { level: 3 } } }, Q);
    expect(noulOf(a.needed)).toBeCloseTo(0.83);
    expect(choiceOf(a.kind, ["outage", "docs"])).toBe("outage");
    expect(scoreLevelOf(a.severity, ["1 mild", "2 bad", "3 total outage"])).toBe(3);
    expect(noulOf(toSnapAnswers({ needed: 72 }, Q).needed)).toBeCloseTo(0.72); // percent, no wrapper
    const bad = toSnapAnswers({ answers: { needed: { p_yes: "x" }, kind: {}, severity: { level: 9 } } }, Q);
    expect(Object.keys(bad)).toEqual([]);
  });

  it("decide() calls the System One model without a reasoning field and parses its JSON", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return reply('Sure: {"answers": {"needed": {"p_yes": 0.9}}}');
    }));
    const d = new WorkersAiDecider(systemOneConfig(ENV)!);
    const r = await d.decide("TASK: fetch a page", { needed: Q.needed }, 5_000);
    expect(calls[0].url).toContain(DEFAULT_SYSTEM_ONE_MODEL);
    expect(calls[0].body.reasoning).toBeUndefined();
    expect(noulOf(r.answers.needed)).toBeCloseTo(0.9);
    expect(r.usage).toEqual({ input_tokens: 50, output_tokens: 10 });
  });

  it("the diag passes on a confident yes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply('{"answers": {"blue": {"p_yes": 0.97}}}')));
    const one = createWorkersAiSystemOne(ENV)!;
    const r = await one.diags[0].check();
    expect(one.diags[0].name).toBe("workers-ai-systemone");
    expect(r.ok).toBe(true);
    expect(r.detail).not.toContain(ENV.CF_API_TOKEN);
  });
});

const ASSETS = [{ id: "web_fetch" }, { id: "github" }] as Asset[];
const fixed = (choices: Array<{ asset_id: string; p: number }>, usage = { input_tokens: 10, output_tokens: 1 }): Router =>
  ({ route: async () => ({ choices, ms: 1, usage }) });
const failing = (msg: string): Router => ({ route: async () => { throw Object.assign(new Error(msg), { usage: { input_tokens: 3, output_tokens: 0 } }); } });

describe("createEnsembleRouter", () => {
  it("averages both models' p per asset, bills only the priced voter, and reports each vote", async () => {
    const r = createEnsembleRouter([
      { label: "SubQ Snap", router: fixed([{ asset_id: "web_fetch", p: 0.9 }, { asset_id: "github", p: 0.2 }]), priced: true },
      { label: "Workers AI", router: fixed([{ asset_id: "web_fetch", p: 0.7 }, { asset_id: "github", p: 0.4 }], { input_tokens: 999, output_tokens: 9 }), priced: false },
    ])!;
    const out = await r.route("t", ASSETS);
    expect(out.choices[0].asset_id).toBe("web_fetch");
    expect(out.choices[0].p).toBeCloseTo(0.8);
    expect(out.choices[1].p).toBeCloseTo(0.3);
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 1 });
    expect(out.detail).toBe("System One votes: SubQ Snap web_fetch p=0.90, Workers AI web_fetch p=0.70");
  });

  it("routes on the other model when one fails; throws (with priced usage) only when every model fails", async () => {
    const one = createEnsembleRouter([
      { label: "SubQ Snap", router: failing("snap down"), priced: true },
      { label: "Workers AI", router: fixed([{ asset_id: "web_fetch", p: 0.6 }]), priced: false },
    ])!;
    const out = await one.route("t", ASSETS);
    expect(out.choices).toEqual([{ asset_id: "web_fetch", p: 0.6 }]);
    expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 0 });
    expect(out.detail).toContain("SubQ Snap failed (snap down)");
    const none = createEnsembleRouter([
      { label: "SubQ Snap", router: failing("a"), priced: true },
      { label: "Workers AI", router: failing("b"), priced: false },
    ])!;
    await expect(none.route("t", ASSETS)).rejects.toThrow(/every System One model failed/);
  });

  it("one voter is passed through unchanged; none is null", () => {
    const solo = fixed([]);
    expect(createEnsembleRouter([{ label: "x", router: solo, priced: true }])).toBe(solo);
    expect(createEnsembleRouter([])).toBeNull();
  });
});

describe("runtime wiring", () => {
  it("routes with Workers AI alone when only CF credentials exist, and lists its diag", () => {
    const rt = buildRuntime(ENV, new MemoryStore());
    expect(rt.router).not.toBeNull();
    expect(rt.diags.map((d) => d.name)).toContain("workers-ai-systemone");
    expect(buildRuntime({ ...ENV, SYSTEM_ONE_CF: "off" }, new MemoryStore()).router).toBeNull();
  });

  it("a real createRouter over the Workers AI decider asks one yes/no per asset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply('{"answers": {"t0": {"p_yes": 0.95}, "t1": {"p_yes": 0.05}}}')));
    const r = createRouter(new WorkersAiDecider(systemOneConfig(ENV)!));
    const out = await r.route("Fetch https://example.com", [{ id: "web_fetch", description: "fetch a URL" }, { id: "github", description: "GitHub API" }] as Asset[]);
    expect(out.choices.map((c) => c.asset_id)).toEqual(["web_fetch", "github"]);
    expect(out.choices[0].p).toBeCloseTo(0.95);
  });
});
