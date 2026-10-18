// The seed notes and the stage demo note must pass the same privacy gate notes_file uses.
import { describe, expect, it } from "vitest";
import { gate } from "./index.js";
import { SEED_NOTES } from "../../scripts/seed-notes.js";
import { DEMO_NOTE } from "../../demo/run.js";

describe("seed and demo notes", () => {
  it("every one passes the gate, with distinct wording", () => {
    for (const n of [...SEED_NOTES, DEMO_NOTE]) {
      const g = gate(n);
      expect(g.ok ? "ok" : JSON.stringify(g.problems)).toBe("ok");
    }
    expect(new Set(SEED_NOTES.map((n) => n.what)).size).toBe(SEED_NOTES.length);
  });
});
