// Stream A: the warehouse catalog. Default assets the runtime can use; seeded into the RunStore at boot.
// notes_unlock is deliberately NOT here: agents in the swarm never pay. Descriptions are one plain sentence each
// (Snap reads them); Muse's docs/muse/catalog.json ({asset_id: sentence}) overrides the built-ins when present.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Asset, RunStore } from "./types.js";

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });

export const DEFAULT_ASSETS: readonly Asset[] = Object.freeze([
  {
    id: "notes_query", kind: "mcp_tool", executor: "aze", endpoint: null, tool_name: null, active: true,
    description: "Free check of the known issues other agents reported for a public product or service, before using it.",
    input_schema: {
      type: "object",
      properties: {
        surface: str("Public name of the product or service", { maxLength: 60 }),
        tool: str("Specific tool or endpoint, if any", { maxLength: 80 }),
        error: str("The error you got, if any (identifiers removed)", { maxLength: 500 }),
      },
      required: ["surface"],
      additionalProperties: false,
    },
  },
  {
    id: "notes_file", kind: "mcp_tool", executor: "aze", endpoint: null, tool_name: null, active: true,
    description: "File one short anonymous field note about what blocked, slowed or helped an agent with a public product or service.",
    input_schema: {
      type: "object",
      properties: {
        kind: str("One of: friction, worked_well, wish, workaround, cost, trust, comparison, barrier, missing_data"),
        category: str("Short class, e.g. 'auth', 'docs', 'rate-limit'", { maxLength: 40 }),
        surface: str("Public name of the product or service", { maxLength: 60 }),
        what: str("What happened, in classes not names", { maxLength: 240 }),
        tool: str("Public tool or endpoint name", { maxLength: 80 }),
        error: str("Error text with identifiers removed", { maxLength: 500 }),
        workaround: str("What got past it", { maxLength: 1000 }),
        wish: str("What you wish existed", { maxLength: 240 }),
      },
      required: ["kind", "category", "surface", "what"],
      additionalProperties: false,
    },
  },
  {
    id: "notes_score", kind: "mcp_tool", executor: "aze", endpoint: null, tool_name: null, active: true,
    description: "Agent-experience score for public services from filed notes, with sample sizes.",
    input_schema: {
      type: "object",
      properties: { surface: str("Public service name; omit for all", { maxLength: 60 }) },
      additionalProperties: false,
    },
  },
  {
    id: "web_fetch", kind: "fetch", executor: "http_fetch", endpoint: null, tool_name: null, active: true,
    description: "Fetch one public web page or API over HTTPS (GET only, no login) and return its readable text.",
    input_schema: {
      type: "object",
      properties: { url: str("Full https:// URL of a public page or API endpoint", { format: "uri", maxLength: 2000 }) },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    id: "instabox_exec", kind: "sandbox", executor: "instabox", endpoint: null, tool_name: null, active: false,
    description: "Run one shell command on this agent's Instabox cloud computer and return its output.",
    input_schema: {
      type: "object",
      properties: { command: str("Shell command to run", { maxLength: 2000 }) },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    id: "inkbox_send", kind: "comms", executor: "inkbox", endpoint: null, tool_name: null, active: false,
    description: "Send an email from this agent's Inkbox identity.",
    input_schema: {
      type: "object",
      properties: {
        to: str("Recipient address", { maxLength: 320 }),
        subject: str("Subject line", { maxLength: 200 }),
        body: str("Plain-text body", { maxLength: 5000 }),
      },
      required: ["to", "body"],
      additionalProperties: false,
    },
  },
  {
    id: "inkbox_inbox", kind: "comms", executor: "inkbox", endpoint: null, tool_name: null, active: false,
    description: "Read the most recent messages in this agent's Inkbox inbox.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 20, description: "How many messages (default 5)" } },
      additionalProperties: false,
    },
  },
].map((a) => Object.freeze(a as Asset)));

let cached: Record<string, string> | null = null;

/** Muse's descriptions file: {asset_id: sentence} (or [{id, description}]). Unknown ids and bad values are ignored.
 * Without an explicit file, looks in docs/muse/catalog.json (cwd, then repo root) once per process. */
export function loadDescriptions(file?: string): Record<string, string> {
  if (!file && cached) return cached;
  const result = readDescriptions(file);
  if (!file) cached = result;
  return result;
}

function moduleDir(): string | null {
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return null; } // e.g. a CJS bundle
}

function readDescriptions(file?: string): Record<string, string> {
  const here = moduleDir();
  const candidates = file ? [file] : [path.join(process.cwd(), "docs/muse/catalog.json"), ...(here ? [path.join(here, "../../docs/muse/catalog.json")] : [])];
  for (const f of candidates) {
    try {
      if (!existsSync(f)) continue;
      const parsed: unknown = JSON.parse(readFileSync(f, "utf8"));
      const entries: Array<[unknown, unknown]> = Array.isArray(parsed)
        ? parsed.map((r) => [(r as Record<string, unknown>)?.id ?? (r as Record<string, unknown>)?.asset_id, (r as Record<string, unknown>)?.description])
        : parsed && typeof parsed === "object" ? Object.entries(parsed as Record<string, unknown>) : [];
      const known = new Set(DEFAULT_ASSETS.map((a) => a.id));
      const out: Record<string, string> = {};
      for (const [id, d] of entries) {
        if (typeof id !== "string" || !known.has(id)) continue;
        const desc = typeof d === "string" ? d : typeof (d as Record<string, unknown>)?.description === "string" ? String((d as Record<string, unknown>).description) : null;
        const clean = desc?.replace(/\s+/g, " ").trim();
        if (clean && clean.length <= 300) out[id] = clean;
      }
      return out;
    } catch (e) {
      console.error(`[catalog] ignoring ${path.basename(f)}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  return {};
}

/** The default catalog for this deployment: sandbox/comms assets are active only when their API key is set. */
export function defaultAssets(env: NodeJS.ProcessEnv = process.env, descriptions: Record<string, string> = loadDescriptions()): Asset[] {
  return DEFAULT_ASSETS.map((a) => {
    const active = a.executor === "instabox" ? Boolean(env.INSTABOX_API_KEY) : a.executor === "inkbox" ? Boolean(env.INKBOX_API_KEY) : a.active;
    return { ...a, input_schema: structuredClone(a.input_schema), description: descriptions[a.id] ?? a.description, active };
  });
}

/** Upsert the default catalog (ids are stable, so this is idempotent). */
export async function seedCatalog(runs: RunStore, env: NodeJS.ProcessEnv = process.env): Promise<Asset[]> {
  const assets = defaultAssets(env);
  await runs.upsertAssets(assets);
  return assets;
}

/** Ids the router never sees: notes_query is always called first, notes_file only by the notes step. */
export const isNotesAsset = (id: string) => id.startsWith("notes_");
