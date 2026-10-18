import { describe, expect, it } from "vitest";
import { createRunBudget, DEFAULT_RUNS_PER_HOUR, HOUR_MS, runsPerHour } from "./budget.js";

describe("createRunBudget", () => {
  it("reserves runs in a sliding hour and says when enough frees up", () => {
    let t = 1_000_000;
    const b = createRunBudget(10, HOUR_MS, () => t);
    const a = b.take(6);
    expect(a.ok).toBe(true);
    t += 10 * 60_000;
    expect(b.take(3).ok).toBe(true);
    expect(b.left()).toBe(1);
    const no = b.take(2);
    expect(no).toEqual({ ok: false, left: 1, retry_after_s: 50 * 60 }); // the first reservation (6) expires 50 min from now
    expect(b.take(11)).toEqual({ ok: false, left: 1, retry_after_s: null }); // can never fit
    t += 50 * 60_000;
    expect(b.left()).toBe(7);
    expect(b.take(7).ok).toBe(true);
    expect(b.left()).toBe(0);
  });

  it("refunds only the runs that never started, only for its own reservation", () => {
    const b = createRunBudget(10, HOUR_MS, () => 0);
    const r = b.take(10);
    if (!r.ok) throw new Error("expected a reservation");
    b.refund(r.id, 8);
    expect(b.left()).toBe(8);
    b.refund(r.id, 100); // never below zero
    expect(b.left()).toBe(10);
    b.refund(999, 5); // unknown id: no-op
    b.refund(r.id, -3);
    expect(b.left()).toBe(10);
  });

  it("max 0 refuses everything; a bad max falls back to the default", () => {
    expect(createRunBudget(0).take(1)).toEqual({ ok: false, left: 0, retry_after_s: null });
    expect(createRunBudget(-1).max).toBe(DEFAULT_RUNS_PER_HOUR);
    expect(createRunBudget(2.5).max).toBe(DEFAULT_RUNS_PER_HOUR);
  });
});

describe("runsPerHour", () => {
  it("reads SWARM_RUNS_PER_HOUR as an integer; a typo keeps the default cap (never removes it)", () => {
    expect(runsPerHour({})).toBe(DEFAULT_RUNS_PER_HOUR);
    expect(runsPerHour({ SWARM_RUNS_PER_HOUR: "120" })).toBe(120);
    expect(runsPerHour({ SWARM_RUNS_PER_HOUR: " 0 " })).toBe(0);
    for (const bad of ["", "lots", "-5", "1e9", "50.5", "999999999"]) expect(runsPerHour({ SWARM_RUNS_PER_HOUR: bad }), bad).toBe(DEFAULT_RUNS_PER_HOUR);
  });
});
