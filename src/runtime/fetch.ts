// Stream A: the "http_fetch" executor. GET-only, HTTPS-only fetch of public pages with SSRF protection:
// every hop (initial URL and each redirect, followed manually, max 3) is resolved once, every resolved address is
// checked against private/loopback/link-local/CGNAT/metadata/special ranges (v4 + v6), and the connection is pinned
// to exactly those vetted addresses (no second DNS lookup, so DNS rebinding can't swap in a private IP).
// Never sends cookies or credentials. 10 s total timeout, 1 MB body cap (after decompression), 20 KB output.
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import zlib from "node:zlib";
import type { Asset, Executor, StepResult } from "./types.js";

export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_MAX_BYTES = 1_048_576; // 1 MB
export const FETCH_MAX_REDIRECTS = 3;
export const OUTPUT_MAX_BYTES = 20_480; // 20 KB

export interface ResolvedAddress { address: string; family: 4 | 6 }
export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>;

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean; // body hit maxBytes and was cut
}
/** Performs ONE request to `url`, connecting only to `addresses`. Must not follow redirects. */
export type Transport = (req: { url: URL; addresses: ResolvedAddress[]; headers: Record<string, string>; signal: AbortSignal; maxBytes: number }) => Promise<RawResponse>;

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  lookup?: Lookup;
  transport?: Transport;
  /** TESTS ONLY: permits http:// and loopback addresses for localhost. Never wired to env. */
  allowLocalhostForTests?: boolean;
}

export type FrictionReason =
  | "http_401" | "http_403" | "rate_limited" | "server_error" | "timeout" | "captcha_wall" | "login_wall"
  | "js_required" | "too_many_redirects";

export interface FetchResult {
  ok: boolean;
  status: number | null;
  url: string; // origin + path of the final URL (query/fragment dropped)
  content_type: string | null;
  bytes: number;
  truncated: boolean;
  redirects: number;
  title: string | null;
  text: string;
  friction: boolean;
  reason: FrictionReason | null;
  error: string | null;
  ms: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Address policy

function parseV4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** 16 bytes, or null if not a valid IPv6 literal. Accepts embedded dotted IPv4 and strips a zone id. */
export function parseV6(input: string): number[] | null {
  let s = input.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  if (s.includes(".")) {
    const i = s.lastIndexOf(":");
    const v4 = parseV4(s.slice(i + 1));
    if (!v4) return null;
    s = `${s.slice(0, i + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  }
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function blockedV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 || // private
    (a === 100 && (b & 0xc0) === 64) || // CGNAT 100.64/10
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, cloud metadata 169.254.169.254
    (a === 172 && (b & 0xf0) === 16) || // private 172.16/12
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 192 && b === 168) || // private
    (a === 198 && (b & 0xfe) === 18) || // benchmarking 198.18/15
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

function blockedV6(x: number[]): boolean {
  const zero = (from: number, to: number) => x.slice(from, to).every((v) => v === 0);
  if (zero(0, 10) && x[10] === 0xff && x[11] === 0xff) return blockedV4(x.slice(12)); // ::ffff:a.b.c.d
  if (zero(0, 12)) return true; // ::, ::1, deprecated IPv4-compatible ::a.b.c.d
  if (x[0] === 0x00 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b) {
    return zero(4, 12) ? blockedV4(x.slice(12)) : true; // NAT64 64:ff9b::/96 well-known; 64:ff9b:1::/48 local-use
  }
  if ((x[0] & 0xe0) !== 0x20) return true; // only global unicast 2000::/3 (blocks ULA fc00::/7, fe80::/10, ff00::/8, 100::/64 ...)
  if (x[0] === 0x20 && x[1] === 0x01 && (x[2] & 0xfe) === 0x00) return true; // 2001::/23 IANA special (Teredo, ORCHID, benchmarking)
  if (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0x0d && x[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (x[0] === 0x20 && x[1] === 0x02) return blockedV4(x.slice(2, 6)); // 6to4 2002::/16 embeds an IPv4
  return false;
}

/** True when an address must never be contacted (anything that is not plainly public unicast). Non-IPs are blocked. */
export function isBlockedAddress(ip: string): boolean {
  const s = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const v = isIP(s.split("%")[0]);
  if (v === 4) {
    const b = parseV4(s);
    return !b || blockedV4(b);
  }
  if (v === 6) {
    const b = parseV6(s);
    return !b || blockedV6(b);
  }
  return true;
}

const isLoopback = (ip: string): boolean => {
  if (isIP(ip) === 4) return ip.startsWith("127.");
  const b = parseV6(ip);
  return !!b && b.slice(0, 15).every((v) => v === 0) && b[15] === 1;
};

const LOCAL_NAME = /(^|\.)(localhost|local|internal|intranet|corp|lan|home\.arpa)$/i;
/** A host name that only means something on a private network (no dot, .local, .internal...). Not for IP literals. */
export const isPrivateHostName = (h: string): boolean => {
  const name = h.toLowerCase().replace(/\.+$/, "");
  return !name.includes(".") || LOCAL_NAME.test(name);
};
const isLocalhostName = (h: string) => h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1";

const defaultLookup: Lookup = async (hostname) => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

class FetchRefused extends Error {}
class FetchTimeout extends Error {}

function bareHost(u: URL): string {
  const h = u.hostname;
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/** Scheme/credential/port/name checks that need no DNS. Throws FetchRefused. */
function checkUrl(u: URL, allowLocal: boolean): void {
  const host = bareHost(u).toLowerCase().replace(/\.+$/, ""); // "localhost." and "x.internal." are the same names
  const local = allowLocal && isLocalhostName(host);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new FetchRefused(`refused: only https URLs are fetched (got ${u.protocol.replace(":", "")})`);
  if (u.username || u.password) throw new FetchRefused("refused: credentials in URL");
  if (u.port && u.port !== "443" && !local) throw new FetchRefused("refused: non-standard port");
  if (!host) throw new FetchRefused("refused: no host");
  if (local) return;
  if (!isIP(host) && isPrivateHostName(host)) throw new FetchRefused("refused: private host name");
}

async function resolveSafe(u: URL, lookup: Lookup, allowLocal: boolean): Promise<ResolvedAddress[]> {
  const host = bareHost(u);
  const fam = isIP(host);
  let addrs: ResolvedAddress[];
  if (fam) addrs = [{ address: host, family: fam === 6 ? 6 : 4 }];
  else {
    try {
      addrs = await lookup(host);
    } catch (e) {
      throw new Error(`dns lookup failed (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }
  if (!addrs.length) throw new Error("dns lookup returned no addresses");
  const allowed = (a: ResolvedAddress) => !isBlockedAddress(a.address) || (allowLocal && isLocalhostName(host.toLowerCase()) && isLoopback(a.address));
  if (!addrs.every(allowed)) throw new FetchRefused("refused: host resolves to a private or reserved address");
  return addrs;
}

// ---------------------------------------------------------------------------------------------------------------
// Transport: node:http(s) with a lookup pinned to the vetted addresses

export const nodeTransport: Transport = ({ url, addresses, headers, signal, maxBytes }) =>
  new Promise<RawResponse>((resolve, reject) => {
    const pinned = (_host: string, options: { family?: number; all?: boolean } | number, cb: (...a: unknown[]) => void) => {
      const fam = typeof options === "number" ? options : options?.family;
      const list = addresses.filter((a) => !fam || a.family === fam);
      if (!list.length) return cb(new Error("no vetted address for requested family"));
      if (typeof options === "object" && options?.all) return cb(null, list.map((a) => ({ address: a.address, family: a.family })));
      return cb(null, list[0].address, list[0].family);
    };
    const mod = url.protocol === "http:" ? http : https;
    const req = mod.request(url, { method: "GET", headers, signal, agent: false, lookup: pinned as never }, (res) => {
      const status = res.statusCode ?? 0;
      const hdrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) hdrs[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
      if (status >= 300 && status < 400) {
        res.destroy();
        return resolve({ status, headers: hdrs, body: Buffer.alloc(0), truncated: false });
      }
      const enc = (hdrs["content-encoding"] ?? "").toLowerCase();
      const stream: NodeJS.ReadableStream =
        enc === "gzip" || enc === "x-gzip" ? res.pipe(zlib.createGunzip())
        : enc === "deflate" ? res.pipe(zlib.createInflate())
        : enc === "br" ? res.pipe(zlib.createBrotliDecompress())
        : res;
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (truncated: boolean) => {
        if (done) return;
        done = true;
        resolve({ status, headers: hdrs, body: Buffer.concat(chunks), truncated });
      };
      stream.on("data", (c: Buffer) => {
        if (done) return;
        const room = maxBytes - size;
        if (c.length >= room) {
          chunks.push(c.subarray(0, room));
          size = maxBytes;
          finish(true);
          res.destroy();
          // Stop the decompressor too: it would otherwise keep inflating its buffered input (a gzip bomb burns CPU).
          if (stream !== res) (stream as unknown as { destroy?: () => void }).destroy?.();
          return;
        }
        chunks.push(c);
        size += c.length;
      });
      stream.on("end", () => finish(false));
      stream.on("error", (e: Error) => (done ? undefined : (done = true, reject(e))));
      res.on("aborted", () => (done ? undefined : (done = true, reject(new Error("response aborted")))));
    });
    req.on("error", reject);
    req.end();
  });

// ---------------------------------------------------------------------------------------------------------------
// HTML → readable text, wall detection

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", bull: "•" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const SKIP_BLOCKS = new Set(["script", "style", "template", "svg", "head", "iframe", "object", "canvas", "math"]);
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "nav", "aside", "li", "ul", "ol", "tr", "table", "h1", "h2", "h3",
  "h4", "h5", "h6", "pre", "blockquote", "dd", "dt", "dl", "form", "figure", "noscript", "br", "hr",
]);
const TAG_NAME = /^\/?([a-z][a-z0-9-]{0,30})/;

/** Readable text of an HTML page: drops script/style/template/svg/head (keeps <title>), keeps <noscript> text.
 * A single forward scan (indexOf only), so hostile markup (unterminated tags/comments by the thousand) stays linear. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const lower = html.toLowerCase();
  let title: string | null = null;
  const ts = lower.indexOf("<title");
  if (ts >= 0) {
    const gt = lower.indexOf(">", ts);
    const te = gt < 0 ? -1 : lower.indexOf("</title", gt);
    if (te > gt) title = decodeEntities(html.slice(gt + 1, Math.min(te, gt + 1 + 500))).replace(/\s+/g, " ").trim() || null;
  }
  const out: string[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { out.push(html.slice(i)); break; }
    out.push(html.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      const e = lower.indexOf("-->", lt + 4);
      if (e < 0) break; // unterminated comment: the rest is not text
      out.push(" ");
      i = e + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break; // unterminated tag (e.g. a body cut at 1 MB)
    const head = lower.slice(lt + 1, Math.min(gt, lt + 34));
    const m = TAG_NAME.exec(head);
    const name = m ? m[1] : "";
    const closing = head.startsWith("/");
    i = gt + 1;
    if (!closing && SKIP_BLOCKS.has(name) && !lower.slice(lt, gt + 1).endsWith("/>")) {
      const close = lower.indexOf(`</${name}`, i);
      if (close < 0) {
        if (name === "head") continue; // a page that never closes <head>: keep going
        break; // unterminated script/style: the rest is code
      }
      const ce = lower.indexOf(">", close);
      i = ce < 0 ? n : ce + 1;
      out.push(" ");
      continue;
    }
    out.push(BLOCK_TAGS.has(name) ? "\n" : name === "td" || name === "th" ? " \t" : " ");
  }
  const text = decodeEntities(out.join(""))
    .replace(/[ \t\f\v\r\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

const SNIFF_BYTES = 100_000; // wall detectors look at the start of the page only
const CAPTCHA = /g-recaptcha|h-captcha|hcaptcha\.com|cf-turnstile|challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform|cf_chl_|captcha-delivery\.com|px-captcha|<title>\s{0,20}just a moment\.\.\.|attention required! \| cloudflare|checking your browser|verify (that )?you are (a )?human|are you a robot/i;
const JS_PHRASE = /enable javascript|javascript is (required|disabled)|requires javascript|turn on javascript|you need to enable javascript/i;
const APP_SHELL = /<div[^>]{0,300}\bid=["']?(root|app|__next|__nuxt|svelte|main-app)["']?[^>]{0,300}>\s{0,200}<\/div>|<app-root[^>]{0,300}>\s{0,200}<\/app-root>/i;
const PASSWORD_INPUT = /<input[^>]{0,300}type=["']?password/i;
const LOGIN_PATH = /\/(login|log-in|signin|sign-in|sign_in|auth|sso|session\/new|accounts?\/login)\b/i;

export function detectWall(o: { html: string; text: string; status: number; finalPath: string; firstPath: string }): FrictionReason | null {
  const textLen = o.text.length;
  const html = o.html.length > SNIFF_BYTES ? o.html.slice(0, SNIFF_BYTES) : o.html;
  if (CAPTCHA.test(html) && (textLen < 2000 || o.status === 403 || o.status === 429 || o.status === 503)) return "captcha_wall";
  if (o.finalPath !== o.firstPath && LOGIN_PATH.test(o.finalPath)) return "login_wall";
  if (textLen < 1500 && PASSWORD_INPUT.test(html)) return "login_wall";
  if (textLen < 300 && (/<noscript/i.test(html) || APP_SHELL.test(html) || JS_PHRASE.test(o.text))) return "js_required";
  if (textLen < 50 && (html.match(/<script\b/gi)?.length ?? 0) >= 3) return "js_required";
  return null;
}

function statusFriction(status: number): FrictionReason | null {
  if (status === 401) return "http_401";
  if (status === 403) return "http_403";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return null;
}

function decodeBody(body: Buffer, contentType: string | null): string {
  const cs = contentType?.match(/charset=["']?([\w-]+)/i)?.[1];
  try {
    return new TextDecoder(cs ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

const shortUrl = (u: URL) => `${u.origin}${u.pathname}`;

// ---------------------------------------------------------------------------------------------------------------
// safeFetch

const HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (compatible; AzeAgent/0.1; agent runtime)",
  accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
  "accept-language": "en",
  "accept-encoding": "gzip, deflate, br",
};

export async function safeFetch(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? FETCH_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? FETCH_MAX_REDIRECTS;
  const lookup = opts.lookup ?? defaultLookup;
  const transport = opts.transport ?? nodeTransport;
  const allowLocal = opts.allowLocalhostForTests === true;
  const base = (over: Partial<FetchResult>): FetchResult => ({
    ok: false, status: null, url: "", content_type: null, bytes: 0, truncated: false, redirects: 0, title: null, text: "",
    friction: false, reason: null, error: null, ms: Date.now() - t0, ...over,
  });

  let url: URL;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    return base({ error: "invalid URL" });
  }
  url.hash = ""; // never sent; keeps logs and keys clean
  const firstPath = url.pathname;
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const timeoutP = new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new FetchTimeout("timeout")), { once: true }));
  timeoutP.catch(() => {});
  let redirects = 0;
  try {
    for (;;) {
      checkUrl(url, allowLocal);
      const addresses = await Promise.race([resolveSafe(url, lookup, allowLocal), timeoutP]);
      const res = await Promise.race([transport({ url, addresses, headers: { ...HEADERS }, signal: ac.signal, maxBytes }), timeoutP]);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (redirects >= maxRedirects) {
          return base({ status: res.status, url: shortUrl(url), redirects, friction: true, reason: "too_many_redirects", error: `too many redirects (> ${maxRedirects})` });
        }
        let next: URL;
        try {
          next = new URL(res.headers.location, url);
        } catch {
          return base({ status: res.status, url: shortUrl(url), redirects, error: "invalid redirect location" });
        }
        next.hash = "";
        url = next;
        redirects++;
        continue;
      }
      const ct = res.headers["content-type"] ?? null;
      const bodyText = decodeBody(res.body, ct);
      const isHtml = /html|xml/i.test(ct ?? "") || /^\s*(<!doctype html|<html)/i.test(bodyText.slice(0, 200));
      const isText = isHtml || /^text\/|json|javascript|csv|yaml|x-www-form-urlencoded/i.test(ct ?? "") || (!ct && !bodyText.includes("\u0000"));
      let title: string | null = null;
      let text: string;
      if (isHtml) ({ title, text } = htmlToText(bodyText));
      else if (isText) text = bodyText.trim();
      else text = `[binary content: ${ct ?? "unknown type"}, ${res.body.length} bytes]`;
      const sf = statusFriction(res.status);
      const wall = isHtml ? detectWall({ html: bodyText, text, status: res.status, finalPath: url.pathname, firstPath }) : null;
      const reason = sf ?? wall;
      const ok = res.status >= 200 && res.status < 300 && !wall;
      return base({
        ok, status: res.status, url: shortUrl(url), content_type: ct, bytes: res.body.length, truncated: res.truncated, redirects,
        title, text, friction: reason !== null, reason,
        error: ok ? null : res.status < 200 || res.status >= 300 ? `HTTP ${res.status}` : wall,
      });
    }
  } catch (e) {
    if (timedOut || e instanceof FetchTimeout) return base({ url: shortUrl(url), redirects, friction: true, reason: "timeout", error: `timed out after ${timeoutMs / 1000} s` });
    if (e instanceof FetchRefused) return base({ url: shortUrl(url), redirects, error: e.message });
    const code = (e as NodeJS.ErrnoException).code;
    return base({ url: shortUrl(url), redirects, error: `fetch failed${code ? ` (${code})` : `: ${(e as Error).message.slice(0, 120)}`}` });
  } finally {
    clearTimeout(timer);
  }
}

/** Cut a string to at most `max` UTF-8 bytes without splitting a character. */
export function truncateBytes(s: string, max: number): string {
  const b = Buffer.from(s, "utf8");
  if (b.length <= max) return s;
  return b.subarray(0, max).toString("utf8").replace(/�+$/, "");
}

/** StepResult text for a fetch: one header line, optional title/friction lines, then the readable text (≤ 20 KB). */
export function formatFetch(r: FetchResult): string {
  const head = [
    `GET ${r.url || "(invalid url)"} -> ${r.status ?? "no response"}${r.content_type ? ` ${r.content_type.split(";")[0]}` : ""}`,
    r.status !== null ? `${r.bytes} bytes${r.truncated ? " (truncated at 1 MB)" : ""}` : null,
    r.redirects ? `${r.redirects} redirect${r.redirects > 1 ? "s" : ""}` : null,
  ].filter(Boolean).join("; ");
  const lines = [head];
  if (r.title) lines.push(`Title: ${r.title}`);
  if (r.reason) lines.push(`Friction: ${r.reason}`);
  if (r.error) lines.push(`Error: ${r.error}`);
  if (r.text) lines.push("", r.text);
  return truncateBytes(lines.join("\n"), OUTPUT_MAX_BYTES);
}

export function createHttpFetchExecutor(opts: FetchOptions = {}): Executor {
  return {
    async execute(asset: Asset, args: Record<string, unknown>): Promise<StepResult> {
      const t0 = Date.now();
      const url = typeof args?.url === "string" ? args.url : "";
      if (!url) return { asset_id: asset.id, ok: false, output: "", ms: 0, error: "missing url argument", friction: false };
      const r = await safeFetch(url, opts);
      return { asset_id: asset.id, ok: r.ok, output: formatFetch(r), ms: Date.now() - t0, error: r.ok ? null : r.error ?? "fetch failed", friction: r.friction };
    },
  };
}
