import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_ASSETS, defaultAssets, isNotesAsset, loadDescriptions, seedCatalog } from "./catalog.js";
import { MemoryRunStore } from "./store.js";

const dir = mkdtempSync(path.join(tmpdir(), "aze-catalog-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, body: string) => {
  const f = path.join(dir, name);
  writeFileSync(f, body);
  return f;
};

describe("DEFAULT_ASSETS", () => {
  it("has the runtime's assets and never notes_unlock", () => {
    expect(DEFAULT_ASSETS.map((a) => a.id)).toEqual(["notes_query", "notes_file", "notes_score", "web_fetch", "instabox_exec", "inkbox_send", "inkbox_inbox"]);
    expect(DEFAULT_ASSETS.some((a) => a.id === "notes_unlock" || a.tool_name === "notes_unlock")).toBe(false);
  });

  it("has valid object schemas whose required keys are declared, and one-sentence descriptions", () => {
    for (const a of DEFAULT_ASSETS) {
      expect(a.input_schema.type, a.id).toBe("object");
      const props = Object.keys(a.input_schema.properties as object);
      for (const r of (a.input_schema.required as string[] | undefined) ?? []) expect(props, a.id).toContain(r);
      expect(a.description.length, a.id).toBeLessThanOrEqual(200);
      expect(a.description.trim().endsWith("."), a.id).toBe(true);
    }
    expect(DEFAULT_ASSETS.find((a) => a.id === "web_fetch")).toMatchObject({ executor: "http_fetch", kind: "fetch", input_schema: { required: ["url"] } });
    expect(DEFAULT_ASSETS.find((a) => a.id === "instabox_exec")).toMatchObject({ executor: "instabox", input_schema: { required: ["command"] } });
    expect(DEFAULT_ASSETS.filter((a) => a.executor === "aze").map((a) => a.id)).toEqual(["notes_query", "notes_file", "notes_score"]);
    // notes_file's schema never exposes payout/proof: those come from the agent context only.
    expect(Object.keys(DEFAULT_ASSETS[1].input_schema.properties as object)).not.toContain("payout_address");
  });

  it("isNotesAsset marks the ids the router never sees", () => {
    expect(DEFAULT_ASSETS.filter((a) => isNotesAsset(a.id)).map((a) => a.id)).toEqual(["notes_query", "notes_file", "notes_score"]);
  });
});

describe("defaultAssets", () => {
  it("activates sandbox/comms assets only when their API key is set", () => {
    const off = defaultAssets({}, {});
    expect(off.filter((a) => a.active).map((a) => a.id)).toEqual(["notes_query", "notes_file", "notes_score", "web_fetch"]);
    const on = defaultAssets({ INSTABOX_API_KEY: "x", INKBOX_API_KEY: "y" }, {});
    expect(on.every((a) => a.active)).toBe(true);
  });

  it("returns deep copies and applies description overrides", () => {
    const a = defaultAssets({}, { web_fetch: "Custom." });
    (a[0].input_schema.properties as Record<string, unknown>).surface = "mutated";
    expect((DEFAULT_ASSETS[0].input_schema.properties as Record<string, unknown>).surface).not.toBe("mutated");
    expect(a.find((x) => x.id === "web_fetch")!.description).toBe("Custom.");
  });
});

describe("loadDescriptions", () => {
  it("reads {asset_id: sentence}, ignoring unknown ids, non-strings and overlong values", () => {
    const f = file("map.json", JSON.stringify({ web_fetch: "  Fetch a  page. ", notes_unlock: "Pay.", notes_query: 3, notes_file: "x".repeat(301), notes_score: { description: "Scores." } }));
    expect(loadDescriptions(f)).toEqual({ web_fetch: "Fetch a page.", notes_score: "Scores." });
  });

  it("also reads [{id, description}]", () => {
    const f = file("list.json", JSON.stringify([{ id: "web_fetch", description: "A." }, { asset_id: "notes_query", description: "B." }, { id: "nope", description: "C." }]));
    expect(loadDescriptions(f)).toEqual({ web_fetch: "A.", notes_query: "B." });
  });

  it("returns {} for a missing or malformed file", () => {
    expect(loadDescriptions(path.join(dir, "missing.json"))).toEqual({});
    expect(loadDescriptions(file("bad.json", "{not json"))).toEqual({});
  });
});

describe("seedCatalog", () => {
  it("upserts the default catalog idempotently", async () => {
    const runs = new MemoryRunStore();
    const seeded = await seedCatalog(runs, {});
    await seedCatalog(runs, { INSTABOX_API_KEY: "x" });
    const list = await runs.listAssets();
    expect(list).toHaveLength(seeded.length);
    expect(list.find((a) => a.id === "instabox_exec")!.active).toBe(true);
  });
});
