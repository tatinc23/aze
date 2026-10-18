import { describe, expect, it } from "vitest";
import { DEFAULT_ASSETS } from "../runtime/catalog.js";
import { STRICT_LIMITS, schemaName, stripNullOptionals, toStrictSchema } from "./schema.js";

/** Muse M1 strict rules, checked on every object node of a derived schema. */
function assertStrict(node: any, path = "$"): void {
  const types = Array.isArray(node.type) ? node.type : [node.type];
  for (const t of types) expect(["string", "number", "boolean", "integer", "array", "object", "null"], `${path} type`).toContain(t);
  for (const k of Object.keys(node)) expect(["type", "description", "enum", "properties", "required", "additionalProperties", "items"], `${path} keyword`).toContain(k);
  if (types.includes("object")) {
    expect(node.additionalProperties, `${path} additionalProperties`).toBe(false);
    expect([...node.required].sort(), `${path} required`).toEqual(Object.keys(node.properties).sort());
    for (const [k, p] of Object.entries(node.properties)) assertStrict(p, `${path}.${k}`);
  }
  if (types.includes("array")) assertStrict(node.items, `${path}[]`);
}

describe("toStrictSchema", () => {
  it("converts the notes_query schema: optional keys nullable, limits dropped, descriptions kept", () => {
    const q = DEFAULT_ASSETS.find((a) => a.id === "notes_query")!;
    expect(toStrictSchema(q.input_schema)).toEqual({
      type: "object",
      properties: {
        surface: { type: "string", description: "Public name of the product or service" },
        tool: { type: ["string", "null"], description: "Specific tool or endpoint, if any" },
        error: { type: ["string", "null"], description: "The error you got, if any (identifiers removed)" },
      },
      required: ["surface", "tool", "error"],
      additionalProperties: false,
    });
  });

  it("converts every built-in catalog asset into a schema that follows the strict rules", () => {
    for (const a of DEFAULT_ASSETS) {
      const s = toStrictSchema(a.input_schema);
      expect(s, a.id).not.toBeNull();
      assertStrict(s);
    }
    // a schema with no required keys: everything nullable; format/maxLength/minimum/maximum dropped
    expect(toStrictSchema(DEFAULT_ASSETS.find((a) => a.id === "inkbox_inbox")!.input_schema)).toEqual({
      type: "object",
      properties: { limit: { type: ["integer", "null"], description: "How many messages (default 5)" } },
      required: ["limit"],
      additionalProperties: false,
    });
    expect(JSON.stringify(toStrictSchema(DEFAULT_ASSETS.find((a) => a.id === "web_fetch")!.input_schema))).not.toMatch(/format|maxLength/);
  });

  it("recurses into nested objects and array items; adds additionalProperties:false everywhere; root without type is an object", () => {
    const s = toStrictSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Args",
      properties: {
        filters: {
          type: "object",
          properties: { lang: { type: "string", enum: ["en", "fr"] }, since: { type: "string", format: "date" } },
          required: ["lang"],
          additionalProperties: true,
        },
        tags: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 5 },
        rows: { type: "array", items: { type: "object", properties: { id: { type: "integer", minimum: 0 } } } },
        mode: { const: "fast" },
        level: { enum: [1, 2, 3] },
        ratio: { type: "number", default: 0.5 },
        flag: { type: ["boolean", "null"] },
      },
      required: ["filters", "flag"],
    });
    expect(s).toEqual({
      type: "object",
      properties: {
        filters: {
          type: "object",
          properties: { lang: { type: "string", enum: ["en", "fr"] }, since: { type: ["string", "null"] } },
          required: ["lang", "since"],
          additionalProperties: false,
        },
        tags: { type: ["array", "null"], items: { type: "string" } },
        rows: { type: ["array", "null"], items: { type: "object", properties: { id: { type: ["integer", "null"] } }, required: ["id"], additionalProperties: false } },
        mode: { type: ["string", "null"], enum: ["fast", null] },
        level: { type: ["integer", "null"], enum: [1, 2, 3, null] },
        ratio: { type: ["number", "null"] },
        flag: { type: ["boolean", "null"] }, // required and already nullable: kept as is
      },
      required: ["filters", "tags", "rows", "mode", "level", "ratio", "flag"],
      additionalProperties: false,
    });
    assertStrict(s);
  });

  it("an originally-nullable enum gets null in its enum list", () => {
    expect(toStrictSchema({ type: "object", properties: { m: { type: ["string", "null"], enum: ["a", "b"] } }, required: ["m"] })).toMatchObject({
      properties: { m: { type: ["string", "null"], enum: ["a", "b", null] } },
    });
  });

  it.each([
    ["not an object", "nope"],
    ["root is not an object type", { type: "array", items: { type: "string" } }],
    ["root without properties", { type: "object" }],
    ["anyOf", { type: "object", properties: { q: { anyOf: [{ type: "string" }, { type: "number" }] } } }],
    ["$ref", { type: "object", properties: { q: { $ref: "#/$defs/q" } }, $defs: { q: { type: "string" } } }],
    ["multi-type union", { type: "object", properties: { q: { type: ["string", "number"] } } }],
    ["untyped property", { type: "object", properties: { q: { description: "anything" } } }],
    ["free-form nested object", { type: "object", properties: { meta: { type: "object" } } }],
    ["map-style nested object", { type: "object", properties: { meta: { type: "object", properties: {}, additionalProperties: { type: "string" } } } }],
    ["array without items", { type: "object", properties: { xs: { type: "array" } } }],
    ["tuple items", { type: "object", properties: { xs: { type: "array", items: [{ type: "string" }] } } }],
    ["required key with no property", { type: "object", properties: { a: { type: "string" } }, required: ["a", "b"] }],
    ["enum values that don't fit the type", { type: "object", properties: { a: { type: "string", enum: ["x", 1] } } }],
    ["unsupported type", { type: "object", properties: { a: { type: "date" } } }],
  ])("returns null (no response_format) for %s", (_label, schema) => {
    expect(toStrictSchema(schema)).toBeNull();
  });

  it("returns null past the size limits", () => {
    const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: STRICT_LIMITS.properties + 1 }, (_, i) => [`p${i}`, { type: "string" }])) };
    expect(toStrictSchema(wide)).toBeNull();
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < STRICT_LIMITS.depth; i++) deep = { type: "object", properties: { x: deep }, required: ["x"] };
    expect(toStrictSchema(deep)).toBeNull();
  });

  it("does not modify its input", () => {
    const input = { type: "object", properties: { a: { type: "string", maxLength: 3 } } };
    const before = JSON.stringify(input);
    toStrictSchema(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("stripNullOptionals", () => {
  const schema = {
    type: "object",
    properties: {
      q: { type: "string" },
      n: { type: "integer" },
      nested: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] },
      list: { type: "array", items: { type: "object", properties: { k: { type: "string" }, v: { type: "string" } }, required: ["k"] } },
    },
    required: ["q"],
  };
  it("drops nulls on optional keys at every level, keeps required nulls and everything else", () => {
    expect(stripNullOptionals({ q: null, n: null, nested: { a: null, b: null }, list: [{ k: "x", v: null }, { k: null, v: "y" }] }, schema)).toEqual({
      q: null,
      nested: { a: null },
      list: [{ k: "x" }, { k: null, v: "y" }],
    });
    expect(stripNullOptionals({ q: "x", n: 0, extra: "kept" }, schema)).toEqual({ q: "x", n: 0, extra: "kept" });
    expect(stripNullOptionals("scalar", schema)).toBe("scalar");
  });
});

describe("schemaName", () => {
  it("keeps [a-zA-Z0-9_-], replaces the rest, caps at 64", () => {
    expect(schemaName("args_web_fetch")).toBe("args_web_fetch");
    expect(schemaName("args_my.tool/v2")).toBe("args_my_tool_v2");
    expect(schemaName("x".repeat(80))).toHaveLength(64);
    expect(schemaName("")).toBe("schema");
  });
});
