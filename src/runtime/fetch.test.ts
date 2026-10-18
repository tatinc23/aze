import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createHttpFetchExecutor, detectWall, formatFetch, htmlToText, isBlockedAddress, nodeTransport, OUTPUT_MAX_BYTES, parseV6, safeFetch, truncateBytes,
  type Lookup, type RawResponse, type ResolvedAddress, type Transport,
} from "./fetch.js";
import type { AgentContext, Asset } from "./types.js";

const PUBLIC: ResolvedAddress[] = [{ address: "93.184.215.14", family: 4 }];
const html = (body: string, head = "<title>T</title>") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const resp = (status: number, body = "", headers: Record<string, string> = {}): RawResponse => ({
  status, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body: Buffer.from(body), truncated: false,
});

/** Fake DNS + transport: map host -> addresses, URL -> response. Records every call. */
function fakes(dns: Record<string, ResolvedAddress[]>, pages: Record<string, RawResponse | (() => Promise<RawResponse>)>) {
  const lookups: string[] = [];
  const requests: Array<{ url: string; addresses: ResolvedAddress[]; headers: Record<string, string> }> = [];
  const lookup: Lookup = async (h) => {
    lookups.push(h);
    if (!(h in dns)) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return dns[h];
  };
  const transport: Transport = async ({ url, addresses, headers }) => {
    requests.push({ url: url.toString(), addresses, headers });
    const p = pages[url.toString()];
    if (!p) return resp(404, "nope");
    return typeof p === "function" ? p() : p;
  };
  return { lookup, transport, lookups, requests };
}

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.255.255", "169.254.169.254", "172.16.0.1",
    "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.0.10", "198.18.0.1", "198.19.255.255", "198.51.100.7",
    "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "[::1]", "fe80::1", "fe80::1%eth0", "fc00::1", "fd00:ec2::254", "fec0::1", "ff02::1", "100::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::127.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1",
    "2002:c0a8:0101::1", "2002:7f00:0001::", "2001:db8::1", "2001::1", "2001:10::1",
    "not-an-ip", "", "1.2.3", "999.1.1.1",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each([
    "8.8.8.8", "93.184.215.14", "172.32.0.1", "172.15.255.255", "100.128.0.1", "100.63.255.255", "192.169.0.1", "1.1.1.1",
    "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:0808:0808::1", "2001:4860:4860::8888",
  ])("allows public %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));

  it("parses IPv6 forms consistently", () => {
    expect(parseV6("::1")).toEqual([...Array(15).fill(0), 1]);
    expect(parseV6("::ffff:1.2.3.4")?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect(parseV6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseV6("1::2::3")).toBeNull();
    expect(parseV6("gggg::")).toBeNull();
  });
});

describe("safeFetch policy (fake DNS + transport)", () => {
  it("refuses non-https, credentials, odd ports and private names before any DNS or request", async () => {
    const f = fakes({}, {});
    for (const [url, re] of [
      ["http://example.com/", /only https/],
      ["ftp://example.com/", /only https/],
      ["file:///etc/passwd", /only https/],
      ["https://user:pw@example.com/", /credentials/],
      ["https://example.com:8080/", /non-standard port/],
      ["https://localhost/", /private host name/],
      ["https://intranet/", /private host name/],
      ["https://metadata.google.internal/", /private host name/],
      ["https://printer.local/", /private host name/],
      ["https://localhost./", /private host name/],
      ["https://metadata.google.internal./", /private host name/],
      ["not a url", /invalid URL/],
    ] as const) {
      const r = await safeFetch(url, { lookup: f.lookup, transport: f.transport });
      expect(r.ok, url).toBe(false);
      expect(r.error, url).toMatch(re);
      expect(r.friction, url).toBe(false);
    }
    expect(f.lookups).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it("refuses private IP literals (incl. decimal/hex forms and IPv6) without DNS", async () => {
    const f = fakes({}, {});
    for (const url of ["https://169.254.169.254/latest/meta-data/", "https://127.0.0.1/", "https://2130706433/", "https://0x7f.0.0.1/", "https://[::1]/", "https://[::ffff:10.0.0.1]/", "https://10.0.0.1:443/"]) {
      const r = await safeFetch(url, { lookup: f.lookup, transport: f.transport });
      expect(r.error, url).toMatch(/private or reserved/);
    }
    expect(f.lookups).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it("refuses hosts whose DNS answer contains any private address", async () => {
    const f = fakes({
      "evil.example.com": [{ address: "10.0.0.7", family: 4 }],
      "mixed.example.com": [{ address: "93.184.215.14", family: 4 }, { address: "fd00::1", family: 6 }],
      "meta.example.com": [{ address: "169.254.169.254", family: 4 }],
    }, {});
    for (const h of ["evil.example.com", "mixed.example.com", "meta.example.com"]) {
      const r = await safeFetch(`https://${h}/`, { lookup: f.lookup, transport: f.transport });
      expect(r.error, h).toMatch(/private or reserved/);
    }
    expect(f.requests).toEqual([]);
  });

  it("pins the connection to the vetted addresses and sends no cookies or credentials", async () => {
    const f = fakes({ "example.com": PUBLIC }, { "https://example.com/": resp(200, html("<p>Hello world</p>")) });
    const r = await safeFetch("https://example.com/", { lookup: f.lookup, transport: f.transport });
    expect(r.ok).toBe(true);
    expect(f.requests[0].addresses).toEqual(PUBLIC);
    const h = Object.keys(f.requests[0].headers).map((k) => k.toLowerCase());
    expect(h).not.toContain("cookie");
    expect(h).not.toContain("authorization");
  });

  it("checks every redirect hop: a redirect to a private address is refused", async () => {
    const f = fakes(
      { "example.com": PUBLIC, "inside.example.com": [{ address: "192.168.1.20", family: 4 }] },
      { "https://example.com/go": resp(302, "", { location: "https://inside.example.com/admin" }) },
    );
    const r = await safeFetch("https://example.com/go", { lookup: f.lookup, transport: f.transport });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/private or reserved/);
    expect(f.requests.map((x) => x.url)).toEqual(["https://example.com/go"]);
  });

  it("refuses redirects to IP literals, http, and other schemes", async () => {
    for (const location of ["https://169.254.169.254/", "http://example.com/", "file:///etc/passwd", "https://[fd00::1]/"]) {
      const f = fakes({ "example.com": PUBLIC }, { "https://example.com/": resp(301, "", { location }) });
      const r = await safeFetch("https://example.com/", { lookup: f.lookup, transport: f.transport });
      expect(r.ok, location).toBe(false);
      expect(r.error, location).toMatch(/refused/);
      expect(f.requests.length, location).toBe(1);
    }
  });

  it("follows up to 3 redirects (relative too) and refuses a 4th", async () => {
    const pages = {
      "https://example.com/1": resp(302, "", { location: "/2" }),
      "https://example.com/2": resp(307, "", { location: "https://www.example.com/3" }),
      "https://www.example.com/3": resp(308, "", { location: "/4" }),
      "https://www.example.com/4": resp(200, html("<p>arrived</p>")),
    };
    const dns = { "example.com": PUBLIC, "www.example.com": PUBLIC };
    const ok = await safeFetch("https://example.com/1", fakes(dns, pages));
    expect(ok.ok).toBe(true);
    expect(ok.redirects).toBe(3);
    expect(ok.url).toBe("https://www.example.com/4");
    expect(ok.text).toContain("arrived");

    const loop = await safeFetch("https://example.com/1", fakes(dns, { ...pages, "https://www.example.com/4": resp(302, "", { location: "/5" }) }));
    expect(loop.ok).toBe(false);
    expect(loop.reason).toBe("too_many_redirects");
    expect(loop.friction).toBe(true);
  });

  it("marks 401/403/429/5xx as friction, 404 as a plain failure", async () => {
    const cases: Array<[number, string | null, boolean]> = [[401, "http_401", true], [403, "http_403", true], [429, "rate_limited", true], [500, "server_error", true], [503, "server_error", true], [404, null, false], [410, null, false]];
    for (const [status, reason, friction] of cases) {
      const f = fakes({ "example.com": PUBLIC }, { "https://example.com/": resp(status, html("<p>status page with enough words to not be a wall</p>")) });
      const r = await safeFetch("https://example.com/", f);
      expect(r.ok, String(status)).toBe(false);
      expect(r.reason, String(status)).toBe(reason);
      expect(r.friction, String(status)).toBe(friction);
      expect(r.error, String(status)).toBe(`HTTP ${status}`);
    }
  });

  it("times out (friction) when the server or DNS hangs", async () => {
    const hang = fakes({ "example.com": PUBLIC }, { "https://example.com/": () => new Promise<RawResponse>(() => {}) });
    const r = await safeFetch("https://example.com/", { ...hang, timeoutMs: 40 });
    expect(r).toMatchObject({ ok: false, friction: true, reason: "timeout" });
    expect(r.error).toMatch(/timed out/);
    const slowDns = await safeFetch("https://example.com/", { lookup: () => new Promise(() => {}), transport: hang.transport, timeoutMs: 40 });
    expect(slowDns.reason).toBe("timeout");
  });

  it("reports DNS failures without friction", async () => {
    const r = await safeFetch("https://nxdomain.example.com/", fakes({}, {}));
    expect(r).toMatchObject({ ok: false, friction: false });
    expect(r.error).toMatch(/dns lookup failed \(ENOTFOUND\)/);
  });

  it("detects captcha walls, login walls and JavaScript-only app shells", async () => {
    const dns = { "example.com": PUBLIC };
    const captcha = await safeFetch("https://example.com/", fakes(dns, { "https://example.com/": resp(403, html('<div class="cf-turnstile"></div><p>Verify you are human</p>', "<title>Just a moment...</title>")) }));
    expect(captcha.reason).toBe("http_403"); // status first
    const captcha200 = await safeFetch("https://example.com/", fakes(dns, { "https://example.com/": resp(200, html('<form><div class="g-recaptcha"></div></form><p>Are you a robot?</p>')) }));
    expect(captcha200).toMatchObject({ ok: false, friction: true, reason: "captcha_wall" });

    const login = await safeFetch("https://example.com/pricing", fakes(dns, {
      "https://example.com/pricing": resp(302, "", { location: "/login?next=/pricing" }),
      "https://example.com/login": resp(200, html('<form><input name="u"><input type="password" name="p"></form><p>Sign in</p>')),
    }));
    expect(login).toMatchObject({ ok: false, friction: true, reason: "login_wall" });

    const spa = await safeFetch("https://example.com/", fakes(dns, { "https://example.com/": resp(200, html('<noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div><script src="/a.js"></script>')) }));
    expect(spa).toMatchObject({ ok: false, friction: true, reason: "js_required" });
    expect(spa.text).toContain("enable JavaScript");
  });

  it("extracts readable text from HTML and passes JSON through", async () => {
    const page = html('<script>var secret = "x";</script><style>p{color:red}</style><h1>Rate limits</h1><p>Unauthenticated: 60 requests &amp; hour.</p><!-- hidden -->', "<title>Docs &mdash; API</title><script>evil()</script>");
    const f = fakes({ "example.com": PUBLIC, "api.example.com": PUBLIC }, {
      "https://example.com/docs?token=abc": resp(200, page),
      "https://api.example.com/rate_limit": resp(200, '{"resources":{"core":{"limit":60}}}', { "content-type": "application/json" }),
    });
    const r = await safeFetch("https://example.com/docs?token=abc#frag", f);
    expect(r.ok).toBe(true);
    expect(r.title).toBe("Docs — API");
    expect(r.text).toContain("Rate limits");
    expect(r.text).toContain("60 requests & hour.");
    expect(r.text).not.toMatch(/secret|color:red|evil|hidden/);
    expect(r.url).toBe("https://example.com/docs"); // query + fragment never echoed
    const j = await safeFetch("https://api.example.com/rate_limit", f);
    expect(j.text).toBe('{"resources":{"core":{"limit":60}}}');
  });
});

describe("nodeTransport against a local server (allowLocalhostForTests)", () => {
  let server: http.Server;
  let base = "";
  const seen: http.IncomingHttpHeaders[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === "/gzip") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        return res.end(zlib.gzipSync("hello gzip"));
      }
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("x".repeat(3 * 1024 * 1024));
      }
      if (req.url === "/bomb") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        return res.end(zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 97)));
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/gzip", "set-cookie": "sid=abc" });
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const loopback: Lookup = async () => [{ address: "127.0.0.1", family: 4 }];

  it("refuses http://localhost unless the test-only flag is set", async () => {
    const r = await safeFetch(`${base}/gzip`, { lookup: loopback });
    expect(r.error).toMatch(/only https/);
  });

  it("decompresses gzip, follows a redirect without sending the cookie back", async () => {
    seen.length = 0;
    const r = await safeFetch(`${base}/redirect`, { lookup: loopback, allowLocalhostForTests: true });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("hello gzip");
    expect(r.redirects).toBe(1);
    expect(seen).toHaveLength(2);
    for (const h of seen) {
      expect(h.cookie).toBeUndefined();
      expect(h.authorization).toBeUndefined();
    }
  });

  it("connects only to the vetted addresses (no second DNS lookup, so rebinding can't swap the IP)", async () => {
    // ".invalid" never resolves in real DNS (RFC 2606): this only succeeds if the transport uses the pinned address.
    const port = Number(new URL(base).port);
    const r = await nodeTransport({
      url: new URL(`http://pinned.invalid:${port}/gzip`), addresses: [{ address: "127.0.0.1", family: 4 }], headers: {},
      signal: new AbortController().signal, maxBytes: 1000,
    });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe("hello gzip");
    await expect(nodeTransport({
      url: new URL(`http://pinned.invalid:${port}/gzip`), addresses: [], headers: {}, signal: new AbortController().signal, maxBytes: 1000,
    })).rejects.toThrow(/no vetted address/); // nothing vetted = no connection, never a fallback to real DNS
  });

  it("caps the body at 1 MB (and after decompression)", async () => {
    const big = await safeFetch(`${base}/big`, { lookup: loopback, allowLocalhostForTests: true });
    expect(big.ok).toBe(true);
    expect(big.truncated).toBe(true);
    expect(big.bytes).toBe(1_048_576);
    const bomb = await safeFetch(`${base}/bomb`, { lookup: loopback, allowLocalhostForTests: true, maxBytes: 10_000 });
    expect(bomb.truncated).toBe(true);
    expect(bomb.bytes).toBe(10_000);
  });
});

describe("helpers + executor", () => {
  it("htmlToText keeps noscript text, drops head/scripts, decodes entities", () => {
    const { title, text } = htmlToText('<html><head><title> A &amp; B </title><meta name="x"></head><body><p>One</p><br>Two&#33; &#x41;<noscript>No JS</noscript></body></html>');
    expect(title).toBe("A & B");
    expect(text).toBe("One\n\nTwo! A\nNo JS");
  });

  it("stays linear on hostile 1 MB markup (unterminated tags, comments, scripts, entities)", () => {
    const MB = 1_048_576;
    const hostile = ["<script", "<!--", "<", "<div id=", "<p", "&aaaaaaaa", "<title", "<input type=", "<a href='>'"].map((u) => u.repeat(Math.ceil(MB / u.length)).slice(0, MB));
    const t0 = Date.now();
    for (const h of hostile) {
      const { text } = htmlToText(h);
      expect(typeof text).toBe("string");
      expect(() => detectWall({ html: h, text, status: 200, finalPath: "/", firstPath: "/" })).not.toThrow();
    }
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("htmlToText: self-closing svg, unclosed head, unterminated script", () => {
    expect(htmlToText("<p>a</p><svg/><p>b</p>").text).toBe("a\n\nb");
    expect(htmlToText("<html><head><meta x><body><p>still here</p>").text).toBe("still here");
    expect(htmlToText("<p>before</p><script>var a = '<p>x</p>'").text).toBe("before");
    expect(htmlToText("<style>p{}</style>text<STYLE>q{}</STYLE> more").text).toBe("text more");
  });

  it("truncateBytes never splits a character", () => {
    expect(truncateBytes("héllo", 2)).toBe("h");
    expect(Buffer.byteLength(truncateBytes("€".repeat(10_000), 20_480))).toBeLessThanOrEqual(20_480);
  });

  it("formats results with a header and keeps output under 20 KB", async () => {
    const f = fakes({ "example.com": PUBLIC }, { "https://example.com/": resp(200, `<p>${"word ".repeat(20_000)}</p>`) });
    const ex = createHttpFetchExecutor(f);
    const asset = { id: "web_fetch" } as Asset;
    const s = await ex.execute(asset, { url: "https://example.com/" }, {} as AgentContext);
    expect(s.ok).toBe(true);
    expect(s.output.startsWith("GET https://example.com/ -> 200 text/html")).toBe(true);
    expect(Buffer.byteLength(s.output)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
    expect(await ex.execute(asset, {}, {} as AgentContext)).toMatchObject({ ok: false, error: "missing url argument" });
    expect(formatFetch({ ok: false, status: null, url: "", content_type: null, bytes: 0, truncated: false, redirects: 0, title: null, text: "", friction: false, reason: null, error: "invalid URL", ms: 0 })).toContain("Error: invalid URL");
  });

  it("never goes through global fetch (requests use the pinned node transport)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    try {
      const f = fakes({ "example.com": PUBLIC }, { "https://example.com/": resp(200, html("<p>hi</p>")) });
      await safeFetch("https://example.com/", f);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
