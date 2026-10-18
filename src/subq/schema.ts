// Strict JSON schemas for SubQ chat JSON mode (Muse M1): `response_format: {type: "json_schema", json_schema: {name,
// strict: true, schema}}`. Strict rules: the root is an object; every property is listed in `required`;
// `additionalProperties: false` on every object; types string/number/boolean/integer/array/object (and enum).
// toStrictSchema derives such a schema from a tool's input_schema: optional properties become nullable
// ([type, "null"]) and stripNullOptionals removes those nulls again before the arguments are executed.
import { isObj } from "./wire.js";

/** Bounds on a derived schema (SubQ documents none; these mirror common strict-mode limits). Beyond them: no schema. */
export const STRICT_LIMITS = Object.freeze({ depth: 10, properties: 100, enumValues: 500, descriptionChars: 300 });

const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
/** Keywords whose meaning a strict schema cannot keep: their presence makes a schema unconvertible. */
const STRUCTURAL = [
  "anyOf", "oneOf", "allOf", "not", "$ref", "$defs", "definitions", "if", "then", "else", "patternProperties",
  "prefixItems", "dependentSchemas", "dependentRequired", "unevaluatedProperties", "propertyNames",
];

/** A json_schema `name`: [a-zA-Z0-9_-], 1-64 chars. */
export function schemaName(raw: string): string {
  const s = String(raw ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return s || "schema";
}

class Unconvertible extends Error {}
function fail(why: string): never {
  throw new Unconvertible(why);
}

interface Budget { properties: number; enumValues: number }

function jsonTypeOf(v: unknown): string | null {
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number" && Number.isFinite(v)) return Number.isInteger(v) ? "integer" : "number";
  if (v === null) return "null";
  return null;
}

function valueFits(v: unknown, t: string, nullable: boolean): boolean {
  if (v === null) return nullable;
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  return jsonTypeOf(v) === t;
}

/** The single non-null type of a node and whether it allows null. Type arrays other than [T, "null"] fail. */
function typeOfNode(node: Record<string, unknown>, en: unknown[] | null): { type: string; nullable: boolean } {
  let list: string[];
  if (node.type === undefined) {
    if (!en || en.length === 0) fail("no type");
    const ts = new Set(en!.map((v) => jsonTypeOf(v) ?? fail("enum value is not a scalar")));
    if (ts.has("integer") && ts.has("number")) ts.delete("integer");
    list = [...ts];
  } else if (typeof node.type === "string") {
    list = [node.type];
  } else if (Array.isArray(node.type) && node.type.every((t) => typeof t === "string")) {
    list = node.type as string[];
  } else {
    return fail("bad type");
  }
  const nullable = list.includes("null");
  const types = [...new Set(list.filter((t) => t !== "null"))];
  if (types.length !== 1 || !TYPES.has(types[0])) fail("needs exactly one supported type");
  return { type: types[0], nullable };
}

function enumOf(node: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(node.enum)) return node.enum;
  if ("const" in node) return [node.const];
  return null;
}

function convertNode(node: unknown, depth: number, b: Budget): Record<string, unknown> {
  if (!isObj(node)) return fail("schema node is not an object");
  if (depth > STRICT_LIMITS.depth) fail("too deep");
  for (const k of STRUCTURAL) if (k in node) fail(`unsupported keyword ${k}`);
  const en = enumOf(node);
  const { type, nullable } = typeOfNode(node, en);
  const out: Record<string, unknown> = { type: nullable ? [type, "null"] : type };
  if (typeof node.description === "string" && node.description.trim()) out.description = node.description.trim().slice(0, STRICT_LIMITS.descriptionChars);
  if (en) {
    if (type === "object" || type === "array") fail("enum on a container");
    if (en.length === 0 || !en.every((v) => valueFits(v, type, nullable))) fail("enum values do not fit the type");
    const values = nullable && !en.includes(null) ? [...en, null] : [...en];
    b.enumValues += values.length;
    if (b.enumValues > STRICT_LIMITS.enumValues) fail("too many enum values");
    out.enum = values;
  }
  if (type === "object") {
    const props = node.properties;
    if (!isObj(props)) return fail("object without properties");
    if (Object.keys(props).length === 0 && node.additionalProperties !== false) fail("free-form object");
    const required = new Set(Array.isArray(node.required) ? node.required.filter((k): k is string => typeof k === "string") : []);
    for (const k of required) if (!(k in props)) fail("required key without a property");
    const outProps: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(props)) {
      if (++b.properties > STRICT_LIMITS.properties) fail("too many properties");
      const s = convertNode(p, depth + 1, b);
      outProps[k] = required.has(k) ? s : nullableOf(s);
    }
    out.properties = outProps;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  } else if (type === "array") {
    if (!isObj(node.items)) fail("array without a single items schema");
    out.items = convertNode(node.items, depth + 1, b);
  }
  return out;
}

/** The same node, also allowing null (null joins an enum too). */
function nullableOf(s: Record<string, unknown>): Record<string, unknown> {
  const t = s.type;
  const out: Record<string, unknown> = { ...s, type: Array.isArray(t) ? (t.includes("null") ? t : [...t, "null"]) : [t, "null"] };
  if (Array.isArray(s.enum) && !s.enum.includes(null)) out.enum = [...s.enum, null];
  return out;
}

/**
 * A strict schema derived from a tool's JSON Schema: properties copied; every property required; originally-optional
 * ones made nullable; additionalProperties:false on every object; unsupported keywords (format, pattern, minLength,
 * maximum, default, title, ...) dropped; descriptions kept (capped). Returns null when the schema cannot be expressed
 * strictly (root not an object, anyOf/$ref/..., multi-type unions, free-form objects, arrays without items, too big):
 * the call then sends no response_format.
 */
export function toStrictSchema(schema: unknown): Record<string, unknown> | null {
  if (!isObj(schema)) return null;
  const root = schema.type === undefined && isObj(schema.properties) ? { ...schema, type: "object" } : schema;
  if (root.type !== "object" || !isObj(root.properties)) return null;
  try {
    return convertNode(root, 1, { properties: 0, enumValues: 0 });
  } catch {
    return null; // Unconvertible, or input weird enough to break the walk
  }
}

/**
 * Undo the nullable trick: drop null values of properties the ORIGINAL schema does not require, recursively through
 * nested objects and array items. Required keys keep their null (validation then reports them as missing).
 */
export function stripNullOptionals(value: unknown, schema: unknown, depth = 0): unknown {
  if (!isObj(schema) || depth > STRICT_LIMITS.depth * 2) return value;
  if (isObj(value)) {
    const props = isObj(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : []);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null && !required.has(k)) continue;
      out[k] = isObj(props[k]) ? stripNullOptionals(v, props[k], depth + 1) : v;
    }
    return out;
  }
  if (Array.isArray(value) && isObj(schema.items)) return value.map((x) => stripNullOptionals(x, schema.items, depth + 1));
  return value;
}
