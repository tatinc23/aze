// The privacy gate: deterministic shape checks + identifier scan. Blocks (never silently edits) and tells the
// agent how to fix each problem. No model calls.
import { KINDS, type CleanNote, type GateProblem, type GateResult, type Kind } from "../types.js";

const TEXT_FIELDS = ["category", "surface", "what", "tool", "error", "workaround", "wish"] as const;
const ALLOWED = new Set<string>([...TEXT_FIELDS, "kind", "tokens_spent", "dollars_spent", "payout_address", "proof"]);
const LIMITS: Record<string, number> = {
  category: 40, surface: 60, what: 240, tool: 80, error: 500, workaround: 1000, wish: 240, proof: 2000,
};
const REQUIRED = ["category", "surface", "what"] as const;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const HINTS: Record<string, string> = {
  not_object: "Send the note as a JSON object with kind, category, surface and what.",
  required: "This field is required; add a short value.",
  type: "Wrong type for this field; check the tool's input schema.",
  too_long: "Too long; shorten it to the limit and keep only the essential detail.",
  invalid_kind: `Use one of: ${KINDS.join(", ")}.`,
  invalid_chars: "Use only letters, digits, spaces, '-' and '_' (e.g. 'signup', 'rate-limits').",
  range: "Out of range; tokens_spent is an integer 0..10000000, dollars_spent a number 0..10000.",
  invalid_address: "payout_address must be an EVM address: 0x followed by 40 hex characters.",
  unknown_field: `Remove this field; allowed fields are: ${[...ALLOWED].join(", ")}.`,
  html: "Remove HTML tags, scripts or event handlers; describe what you saw in plain words.",
  secret: "Remove the secret or token (rotate it if it is real); never include credentials.",
  email: "Remove the email address; describe the role instead (e.g. 'a support inbox').",
  url: "Remove the URL or private host; name the public product or page type instead (e.g. 'the billing settings page').",
  uuid: "Remove the UUID; say 'an id' instead.",
  address: "Remove the 0x address or hash; put your own payout address only in payout_address.",
  hex: "Remove the hash- or key-like hex string; say 'a commit hash' or 'an API key' instead.",
  ipv4: "Remove the IP address; say 'a private host' or 'the API server' instead.",
  path: "Remove the file path; describe it generically (e.g. 'a config file in the project root').",
  branch: "Remove the branch or ref name; say 'a feature branch' instead.",
  digits: "Remove the long number (id, phone, account, timestamp); generalize it (e.g. 'an order id', 'recently').",
  handle: "Remove the @handle; describe the role instead (e.g. 'a maintainer').",
  private_name: "Remove the private name; keep only the role (e.g. 'the human's repo', 'a client').",
  quote: "Do not paste long quotes (chat or document text); summarize in your own words.",
};

const TLDS = "com|net|org|edu|gov|io|ai|dev|app|co|sh|so|me|gg|ly|tv|fm|to|run|pro|live|xyz|cloud|tech|site|info|biz|page|" +
  "us|uk|de|ca|fr|nl|eu|ch|se|es|it|in|au|jp|br|ru|cn";

// Ordered detectors. Each match is masked before the next detector runs, so one identifier yields one problem.
const DETECTORS: Array<[rule: string, re: RegExp]> = [
  // Markup in a note is either an injection attempt or pasted page content; other clients may render it.
  ["html", /<\/?(?:script|img|svg|iframe|a|style|object|embed|link|meta|form|input|button|body|html|div|span|p|b|i|br|video|audio|source|base|math|template|textarea|select|details|marquee)\b[^>]{0,200}>?|<!--|\bjavascript:|\bon[a-z]+\s*=/gi],
  ["secret", new RegExp([
    String.raw`\bsk-[A-Za-z0-9_-]{8,}`, String.raw`\b[rsp]k_(?:live|test)_\w+`, String.raw`\bgithub_pat_\w+`, String.raw`\bgh[pousr]_[A-Za-z0-9]{10,}`,
    String.raw`\bxox[abprs]-[\w-]+`, String.raw`\bAKIA[0-9A-Z]{12,}`, String.raw`\b(?:Bearer|Basic)\s+(?=[\w.~+/-]*[\d_.~+/-])[\w.~+/-]{8,}=*`,
    String.raw`\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*`,
    String.raw`\b[\w-]*?(?:password|passwd|pwd|api[_-]?key|apikey|secret|access[_-]?key|private[_-]?key|token)\s*=\s*[^\s&]+`,
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  ].join("|"), "gi")],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g],
  ["url", new RegExp([
    String.raw`\b[a-z][a-z0-9+.-]*:\/\/\S+`, String.raw`\bwww\.\S+`,
    String.raw`\b(?:[a-z0-9-]+\.)+(?:${TLDS})\/\S*`, String.raw`\b(?:[a-z0-9-]+\.){2,}(?:${TLDS})\b`,
    String.raw`\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|localhost|corp|lan|intranet|home\.arpa)\b`,
  ].join("|"), "gi")],
  ["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ["address", /\b0x[0-9a-f]{16,}\b/gi],
  ["hex", /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{16,}\b/gi],
  // a long mixed-case + digit run with no spaces: an opaque key (after uuid/0x/hex so those keep their own rule)
  ["secret", /(?<![\w+\/=-])(?=[\w+\/=-]*[A-Z])(?=[\w+\/=-]*[a-z])(?=[\w+\/=-]*\d)[\w+\/=-]{24,}/g],
  ["ipv4", /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g],
  ["path", new RegExp([
    String.raw`(?<![\w.:/~-])\/(?:[\w.@-]+\/)+[\w.@-]*`, String.raw`~(?:[A-Za-z_][\w.-]*)?\/[\w.\/-]*`, String.raw`\b[A-Za-z]:[\\\/]\S*`,
    String.raw`(?<![\w.])\.{1,2}[\\\/][\w.-]+`,
  ].join("|"), "g")],
  ["branch", /\b(?:refs\/(?:heads|tags|remotes)|origin|upstream|feature|feat|bugfix|hotfix|release|claude|dependabot|renovate)\/[\w./-]+/gi],
  ["digits", /\d{7,}|\b\d{3}-\d{2}-\d{4}\b|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\+\d[\d\s-]{7,}\d/g],
  // @word, but not npm/model scopes like @x402/mcp or @cf/openai
  ["handle", /(?<![\w.@/])@[A-Za-z0-9_][\w.-]*(?![\w.\/-])/g],
];

const PRIVATE_NOUN = /\b(?:my|our)\s+(?:own\s+)?(?:repo|repository|project|company|employer|startup|org|organization|organisation|client|customer|boss|manager|colleague|coworker|cofounder|team)s?\s*[,:]?\s+(called\s+|named\s+|["'`])?([A-Za-z0-9][\w.-]*)/gi;
const NOT_A_NAME = new Set(
  ("is was are were has had have uses used using and or but nor to in on at for with of from by the a an that which who whom " +
    "where when so because then can could would will should may might must needs needed requires required keeps kept gets got " +
    "does did doesn't don't didn't isn't wasn't won't can't couldn't hasn't haven't also just only still already asked wants " +
    "wanted said says told runs ran owns owner owners settings account accounts lead members member name it this these those as if")
    .split(" "),
);
const QUOTED = /"([^"]+)"|“([^”]+)”|‘([^’]+)’|(?<!\w)'((?:[^']|(?<=\w)'(?=\w))+)'(?!\w)/g;

// What we scan is exactly what we store: NFKC folds look-alikes (fullwidth @, etc.), invisible characters (zero-width,
// bidi controls, tag characters used for smuggling) are removed so they cannot split an identifier or hide text, and
// control characters (NUL breaks Postgres text) become spaces. Newlines and tabs are kept.
function clean(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
}

function scan(field: string, text: string): GateProblem[] {
  const rules = new Set<string>();
  for (const m of text.matchAll(QUOTED)) {
    const inner = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    if (inner.trim().split(/\s+/).length > 12) rules.add("quote");
  }
  for (const [rule, re] of DETECTORS) {
    text = text.replace(re, () => {
      rules.add(rule);
      return " ";
    });
  }
  // A name follows: introduced by called/named/a quote, or name-shaped (capitals, digits, - _ .), not a plain word
  // ("our client library", "my team is") so ordinary prose passes.
  for (const m of text.matchAll(PRIVATE_NOUN)) {
    const [, intro, word] = m;
    if (intro || (/[A-Z0-9_.-]/.test(word) && !NOT_A_NAME.has(word.toLowerCase()))) rules.add("private_name");
  }
  return [...rules].map((rule) => ({ field, rule, hint: HINTS[rule] }));
}

export function normalizeSurface(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase().replace(/^the /, "");
}

export function errorClass(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’|(?<![a-z0-9])'[^']*'(?![a-z0-9])/g, "<q>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>")
    .replace(/\b0x[0-9a-f]+\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/g, "<id>")
    .replace(/(?<![a-z])\d+(?:\.\d+)*/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function teaser(workaround: string | null): string | null {
  if (workaround === null) return null;
  const chars = Array.from(workaround);
  return chars.length <= 80 ? workaround : chars.slice(0, 79).join("") + "…";
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function gate(input: unknown): GateResult {
  if (!isPlainObject(input)) return { ok: false, problems: [{ field: "(input)", rule: "not_object", hint: HINTS.not_object }] };
  const problems: GateProblem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule, hint: HINTS[rule] });

  for (const key of Object.keys(input)) if (!ALLOWED.has(key)) add(key, "unknown_field");

  // kind
  const kind = input.kind;
  if (kind === undefined || kind === null || kind === "") add("kind", "required");
  else if (typeof kind !== "string") add("kind", "type");
  else if (!(KINDS as readonly string[]).includes(kind)) add("kind", "invalid_kind");

  // text fields: shape, then identifier scan
  const text: Record<string, string | null> = {};
  for (const field of TEXT_FIELDS) {
    const v = input[field];
    text[field] = null;
    if (v === undefined || v === null) {
      if ((REQUIRED as readonly string[]).includes(field)) add(field, "required");
      continue;
    }
    if (typeof v !== "string") { add(field, "type"); continue; }
    const t = clean(v).trim();
    if (t === "") {
      if ((REQUIRED as readonly string[]).includes(field)) add(field, "required");
      continue;
    }
    if (t.length > LIMITS[field]) add(field, "too_long");
    if (field === "category" && !/^[A-Za-z0-9 _-]+$/.test(t)) add(field, "invalid_chars");
    // Oversize text is already rejected; scan a bounded prefix so huge input cannot stall the event loop.
    problems.push(...scan(field, t.slice(0, 2 * LIMITS[field])));
    text[field] = t;
  }

  // numbers
  const tokens = input.tokens_spent;
  if (tokens !== undefined && tokens !== null) {
    if (typeof tokens !== "number" || !Number.isInteger(tokens)) add("tokens_spent", "type");
    else if (tokens < 0 || tokens > 10_000_000) add("tokens_spent", "range");
  }
  const dollars = input.dollars_spent;
  if (dollars !== undefined && dollars !== null) {
    if (typeof dollars !== "number" || !Number.isFinite(dollars)) add("dollars_spent", "type");
    else if (dollars < 0 || dollars > 10_000) add("dollars_spent", "range");
  }

  // payout address (stored apart from the note) and proof (never scanned, never stored in the note)
  const payout = input.payout_address;
  if (payout !== undefined && payout !== null && (typeof payout !== "string" || !EVM_ADDRESS.test(payout.trim())))
    add("payout_address", "invalid_address");
  const proof = input.proof;
  if (proof !== undefined && proof !== null) {
    if (typeof proof !== "string") add("proof", "type");
    else if (proof.length > LIMITS.proof) add("proof", "too_long");
  }

  if (problems.length > 0) return { ok: false, problems };

  const note: CleanNote = {
    kind: kind as Kind,
    category: text.category!,
    surface: normalizeSurface(text.surface!),
    surface_display: text.surface!,
    what: text.what!,
    tool: text.tool,
    error_class: text.error === null ? null : errorClass(text.error),
    tokens_spent: typeof tokens === "number" ? tokens : null,
    dollars_spent: typeof dollars === "number" ? dollars : null,
    workaround: text.workaround,
    teaser: teaser(text.workaround),
    wish: text.wish,
  };
  return { ok: true, note, payout_address: typeof payout === "string" ? payout.trim() : null };
}
