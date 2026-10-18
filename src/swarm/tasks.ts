// Stream E: the swarm's micro-tasks. Muse's docs/muse/swarm-tasks.json ([{id, surface, task}]) when it exists and has
// valid rows, else a built-in list of 12 real public lookups (public docs/status pages and APIs, no login, no money).
// These are operator-chosen demo tasks; nothing here pretends to come from users.
// Validation keeps the public dashboard clean: public surface names, task <= 500 chars, http(s) URLs only (the fetch
// executor upgrades to https), no credentials, emails, private hosts, invisible/bidi characters or obvious prompt
// injection. The file is size-capped before it is read. Rejected rows are counted and logged by index + rule, never by
// content.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SwarmTask {
  id: string;
  surface: string; // public product/service name, e.g. "GitHub REST API"
  task: string; // <= 500 chars
}

export const MAX_TASK_CHARS = 500;
export const MAX_SURFACE_CHARS = 60;
export const MAX_TASKS = 500;
/** The task file is read whole; a bigger one is refused (500 rows of <= 500 chars fit in well under this). */
export const MAX_FILE_BYTES = 512 * 1024;

export const BUILTIN_TASKS: readonly SwarmTask[] = Object.freeze([
  { id: "github-rest-rate-limit", surface: "GitHub REST API", task: "How many requests per hour does the GitHub REST API allow without logging in? Check https://api.github.com/rate_limit (public JSON, no token)." },
  { id: "npm-zod-latest", surface: "npm registry", task: "What is the latest published version of the zod package? Check https://registry.npmjs.org/zod/latest (public JSON)." },
  { id: "pypi-requests-latest", surface: "PyPI", task: "What is the latest released version of the Python requests package? Check https://pypi.org/pypi/requests/json (public JSON API)." },
  { id: "cloudflare-status", surface: "Cloudflare", task: "Is Cloudflare reporting an incident right now? Check the public status summary at https://www.cloudflarestatus.com/api/v2/status.json." },
  { id: "github-status", surface: "GitHub", task: "Is GitHub reporting an incident right now? Check the public status summary at https://www.githubstatus.com/api/v2/status.json." },
  { id: "npm-status", surface: "npm", task: "Is npm reporting an incident right now? Check the public status summary at https://status.npmjs.org/api/v2/status.json." },
  { id: "hacker-news-maxitem", surface: "Hacker News API", task: "What is the id of the newest item on Hacker News right now? Check https://hacker-news.firebaseio.com/v0/maxitem.json (public API, no key)." },
  { id: "nodejs-latest", surface: "Node.js", task: "What is the newest Node.js release, and is it on an LTS line? Check the public release index at https://nodejs.org/dist/index.json." },
  { id: "docker-hub-node-tags", surface: "Docker Hub", task: "Which tags were pushed most recently for the official node image? Check https://hub.docker.com/v2/repositories/library/node/tags?page_size=5 (public API, no login)." },
  { id: "crates-serde-latest", surface: "crates.io", task: "What is the newest version of the serde crate? Check https://crates.io/api/v1/crates/serde (public API)." },
  { id: "rfc-6585-429", surface: "RFC Editor", task: "What does HTTP status 429 Too Many Requests mean, and which header can tell a client when to retry? Check RFC 6585 at https://www.rfc-editor.org/rfc/rfc6585.txt." },
  { id: "workers-ai-limits", surface: "Cloudflare Workers AI", task: "What are the default rate limits for text generation models on Cloudflare Workers AI? Check the public docs at https://developers.cloudflare.com/workers-ai/platform/limits/." },
].map((t) => Object.freeze(t)));

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// A public product name: letters/digits first, then a small set of punctuation. No slashes, @, or scheme.
const SURFACE_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,&+()'’:_-]*$/u;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// Invisible and bidi-override characters: they can make public text read differently from what it says.
const FORMAT_RE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/;
// Obvious prompt injection. Task text reaches Snap, the arg filler, the distiller, the renderer and the note writer;
// a curated lookup never needs to talk to the model about its instructions.
const INJECTION_RE = /\b(?:ignore|disregard|forget)\b[^.]{0,40}\b(?:previous|prior|above|earlier|all|any|your)\b[^.]{0,20}\b(?:instructions?|prompts?)\b|\bsystem prompt\b|\bdeveloper mode\b|\bjailbreak|\byou are now\b/i;
const SCHEME_RE = /\b([a-z][a-z0-9+.-]*):\/\//gi;
const USERINFO_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]*@/i;
const QUERY_SECRET_RE = /[?&](?:access[_-]?token|id[_-]?token|api[_-]?key|apikey|key|token|secret|client[_-]?secret|password|passwd|pwd|sig|signature|auth|session|code)=/i;
// Case-sensitive on purpose ("a basic overview" is not a Basic auth header: the token must contain a digit).
const SECRET_RE = /\b[rsp]k_(?:live|test)_\w+|\bsk-[A-Za-z0-9_-]{8,}|\bgithub_pat_\w+|\bgh[pousr]_[A-Za-z0-9]{10,}|\bxox[abprs]-[\w-]+|\bAKIA[0-9A-Z]{12,}|\beyJ[\w-]{8,}\.[\w-]{8,}\.|\b(?:Bearer|Basic)\s+(?=[\w.~+/-]*\d)[\w.~+/-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** Global form of the secret patterns, for masking (not rejecting) operational strings on public endpoints. */
export const SECRET_MASK_RE = new RegExp(SECRET_RE.source, "g");
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const PRIVATE_HOST_RE = /\b(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0)\b|\[::1?\]|\b[\w-]+(?:\.[\w-]+)*\.(?:internal|local|localhost|lan|corp|intranet|home\.arpa)\b/i;

export type TaskCheck = { ok: true; task: SwarmTask } | { ok: false; rule: string };

/** The first rule a surface name breaks, or null. Expects a whitespace-collapsed, trimmed, non-empty string. */
export function surfaceRule(surface: string): string | null {
  if (surface.length > MAX_SURFACE_CHARS) return "surface_too_long";
  // SURFACE_RE has no "@" or "/", so emails, handles and URLs fail here too.
  if (!SURFACE_RE.test(surface) || surface.includes("://")) return "surface_not_public_name";
  return null;
}

/** The first rule a task text breaks, or null. Expects a whitespace-collapsed, trimmed, non-empty string. Shared with
 * POST /admin/run, whose task text lands in the public run log. */
export function taskTextRule(task: string): string | null {
  if (task.length > MAX_TASK_CHARS) return "task_too_long";
  if (FORMAT_RE.test(task)) return "task_format_chars";
  if (INJECTION_RE.test(task)) return "task_injection";
  for (const m of task.matchAll(SCHEME_RE)) if (!/^https?$/i.test(m[1])) return "task_url_scheme";
  if (USERINFO_RE.test(task)) return "task_url_credentials";
  if (QUERY_SECRET_RE.test(task)) return "task_url_credentials";
  if (SECRET_RE.test(task)) return "task_secret";
  if (EMAIL_RE.test(task)) return "email";
  if (PRIVATE_HOST_RE.test(task)) return "task_private_host";
  return null;
}

/** Validate one untrusted row. Returns the cleaned task or the first rule it breaks (never echoes content). */
export function validateTask(row: unknown): TaskCheck {
  if (!row || typeof row !== "object" || Array.isArray(row)) return { ok: false, rule: "not_object" };
  const r = row as Record<string, unknown>;
  const id = typeof r.id === "number" && Number.isInteger(r.id) && r.id >= 0 ? String(r.id) : typeof r.id === "string" ? r.id.trim() : "";
  if (!ID_RE.test(id)) return { ok: false, rule: "id" };
  const surface = typeof r.surface === "string" ? r.surface.replace(/\s+/g, " ").trim() : "";
  if (!surface) return { ok: false, rule: "surface_required" };
  const sRule = surfaceRule(surface);
  if (sRule) return { ok: false, rule: sRule };
  if (typeof r.task !== "string") return { ok: false, rule: "task_required" };
  if (CONTROL_RE.test(r.task)) return { ok: false, rule: "task_control_chars" };
  const task = r.task.replace(/\s+/g, " ").trim();
  if (!task) return { ok: false, rule: "task_required" };
  const tRule = taskTextRule(task);
  if (tRule) return { ok: false, rule: tRule };
  return { ok: true, task: { id, surface, task } };
}

/** Control characters (other than tab/newline/CR) are refused in task text. */
export const hasControlChars = (s: string): boolean => CONTROL_RE.test(s);

export interface LoadedTasks {
  tasks: SwarmTask[];
  source: "file" | "builtin";
  rejected: number; // rows in the file that failed validation (0 for builtin without a file)
  reason: string | null; // why the built-in list is used when a file was found
}

/** Validate a parsed file body: an array of rows, or {tasks: [...]}. Duplicate ids are rejected. */
export function parseTasks(body: unknown): { tasks: SwarmTask[]; rejected: Array<{ index: number; rule: string }> } {
  const rows = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { tasks?: unknown }).tasks) ? (body as { tasks: unknown[] }).tasks : null;
  if (!rows) return { tasks: [], rejected: [{ index: -1, rule: "not_array" }] };
  const tasks: SwarmTask[] = [];
  const rejected: Array<{ index: number; rule: string }> = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (tasks.length >= MAX_TASKS) return void rejected.push({ index, rule: "too_many" });
    const c = validateTask(row);
    if (!c.ok) return void rejected.push({ index, rule: c.rule });
    if (seen.has(c.task.id)) return void rejected.push({ index, rule: "duplicate_id" });
    seen.add(c.task.id);
    tasks.push(c.task);
  });
  return { tasks, rejected };
}

const builtin = (reason: string | null, rejected = 0): LoadedTasks => ({ tasks: BUILTIN_TASKS.map((t) => ({ ...t })), source: "builtin", rejected, reason });

/** Muse's file when it has valid rows, else the built-in list. Without `file`, looks in docs/muse/swarm-tasks.json
 * (cwd, then repo root). Read fresh on each call (one small file per swarm start). Never throws. */
export function loadTasks(file?: string): LoadedTasks {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = file ? [file] : [path.join(process.cwd(), "docs/muse/swarm-tasks.json"), path.join(here, "../../docs/muse/swarm-tasks.json")];
  for (const f of candidates) {
    let body: unknown;
    try {
      if (!existsSync(f)) continue;
      if (statSync(f).size > MAX_FILE_BYTES) {
        console.error(`[swarm] ignoring ${path.basename(f)}: larger than ${MAX_FILE_BYTES} bytes`);
        return builtin("task file too large");
      }
      body = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      console.error(`[swarm] ignoring ${path.basename(f)}: ${(e as Error).name}`);
      return builtin("task file unreadable or not JSON");
    }
    const { tasks, rejected } = parseTasks(body);
    if (rejected.length) {
      const sample = rejected.slice(0, 10).map((r) => `#${r.index}:${r.rule}`).join(", ");
      console.warn(`[swarm] ${path.basename(f)}: ${rejected.length} row(s) rejected (${sample}${rejected.length > 10 ? ", ..." : ""})`);
    }
    if (!tasks.length) return builtin("task file has no valid rows", rejected.length);
    return { tasks, source: "file", rejected: rejected.length, reason: null };
  }
  return builtin(null);
}
