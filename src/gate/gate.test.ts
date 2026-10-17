import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { errorClass, gate, normalizeSurface } from "./index.js";

interface Case { input: unknown; expect: "pass" | "reject"; rules?: string[] }
const corpus: Case[] = JSON.parse(readFileSync(new URL("../../test/fixtures/gate-corpus.json", import.meta.url), "utf8"));

const base = { kind: "friction", category: "docs", surface: "Context7", what: "Docs lookup returned an older version." };
const rulesOf = (input: unknown) => {
  const r = gate(input);
  return r.ok ? [] : [...new Set(r.problems.map((p) => p.rule))].sort();
};

describe("corpus", () => {
  it("is balanced and covers every rule", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(40);
    const pass = corpus.filter((c) => c.expect === "pass").length;
    expect(pass).toBe(corpus.length - pass);
    const covered = new Set(corpus.flatMap((c) => c.rules ?? []));
    for (const rule of ["email", "url", "path", "uuid", "hex", "address", "digits", "handle", "branch", "ipv4", "secret",
      "quote", "private_name", "unknown_field", "invalid_kind", "required", "invalid_chars", "too_long", "range", "type",
      "invalid_address", "not_object"]) expect(covered, rule).toContain(rule);
  });

  it.each(corpus.map((c, i) => [i, c] as const))("case %i", (_i, c) => {
    const r = gate(c.input);
    if (c.expect === "pass") {
      expect(r.ok ? [] : r.problems).toEqual([]);
    } else {
      expect(r.ok).toBe(false);
      expect(rulesOf(c.input)).toEqual([...(c.rules ?? [])].sort());
    }
  });
});

describe("normalizeSurface", () => {
  it("lowercases, trims, collapses whitespace and strips a leading 'the '", () => {
    expect(normalizeSurface("  The   Google  Cloud Console ")).toBe("google cloud console");
    expect(normalizeSurface("GitHub Actions")).toBe("github actions");
    expect(normalizeSurface("Theta Labs")).toBe("theta labs");
  });
});

describe("errorClass", () => {
  it("replaces quotes, numbers and ids", () => {
    expect(errorClass("Argument Validation Error: field 'teamId' is required")).toBe("argument validation error: field <q> is required");
    expect(errorClass('HTTP 429: "Too many" requests, retry in 30s')).toBe("http <n>: <q> requests, retry in <n>s");
    expect(errorClass("can't read property `x` of undefined")).toBe("can't read property <q> of undefined");
    expect(errorClass("job 3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c failed with 0x80070005")).toBe("job <id> failed with <id>");
    expect(errorClass("query: expected string,   received undefined ")).toBe("query: expected string, received undefined");
  });
  it("caps at 120 chars", () => {
    expect(errorClass("x".repeat(300))).toHaveLength(120);
  });
});

describe("gate", () => {
  it("builds a clean note", () => {
    const r = gate({ ...base, surface: " The Context7 ", tool: " resolve-library-id ", error: "Code 400: bad 'q'", tokens_spent: 12 });
    expect(r).toEqual({
      ok: true,
      payout_address: null,
      note: {
        kind: "friction", category: "docs", surface: "context7", surface_display: "The Context7",
        what: base.what, tool: "resolve-library-id", error_class: "code <n>: bad <q>", tokens_spent: 12,
        dollars_spent: null, workaround: null, teaser: null, wish: null,
      },
    });
  });

  it("truncates the teaser to 79 chars + an ellipsis", () => {
    const short = gate({ ...base, workaround: "a".repeat(80) });
    expect(short.ok && short.note.teaser).toBe("a".repeat(80));
    const long = gate({ ...base, workaround: "b".repeat(81) });
    expect(long.ok && long.note.teaser).toBe("b".repeat(79) + "…");
    expect(long.ok && long.note.teaser?.length).toBe(80);
  });

  it("collects all problems across fields with a hint each", () => {
    const r = gate({ kind: "nope", category: "", surface: "Okta", what: "Mail jane@acme.io about /etc/app/conf", extra: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => `${p.field}:${p.rule}`).sort()).toEqual(
      ["category:required", "extra:unknown_field", "kind:invalid_kind", "what:email", "what:path"],
    );
    for (const p of r.problems) expect(p.hint.length).toBeGreaterThan(10);
  });

  it("rejects unknown fields", () => {
    expect(rulesOf({ ...base, repo: "x" })).toEqual(["unknown_field"]);
  });

  it("validates payout_address and returns it apart from the note", () => {
    const addr = "0x52908400098527886E0F7030069857D2E4169EE7";
    const r = gate({ ...base, payout_address: addr });
    expect(r.ok && r.payout_address).toBe(addr);
    expect(JSON.stringify(r.ok && r.note)).not.toContain(addr);
    expect(rulesOf({ ...base, payout_address: "0xZZ" })).toEqual(["invalid_address"]);
    expect(rulesOf({ ...base, payout_address: addr + "00" })).toEqual(["invalid_address"]);
    expect(rulesOf({ ...base, payout_address: 42 })).toEqual(["invalid_address"]);
  });

  it("never returns proof and never scans it", () => {
    const proof = "attestation for jane@acme.io sig 9fceb02d0ae598e95dc970b74767f19372d61af8";
    const r = gate({ ...base, proof });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("attestation");
    expect(rulesOf({ ...base, proof: "x".repeat(2001) })).toEqual(["too_long"]);
  });

  it("checks number fields", () => {
    expect(rulesOf({ ...base, tokens_spent: 1.5 })).toEqual(["type"]);
    expect(rulesOf({ ...base, tokens_spent: 10_000_001 })).toEqual(["range"]);
    expect(rulesOf({ ...base, dollars_spent: 10_000.01 })).toEqual(["range"]);
    expect(rulesOf({ ...base, dollars_spent: Number.NaN })).toEqual(["type"]);
  });

  it("blocks identifiers hidden with zero-width or fullwidth characters", () => {
    expect(rulesOf({ ...base, what: "ask jane​@acme.io" })).toEqual(["email"]);
    expect(rulesOf({ ...base, what: "ask jane＠acme.io" })).toEqual(["email"]);
  });

  it("lets ordinary prose about 'my team' through but blocks a name after it", () => {
    expect(rulesOf({ ...base, what: "My team is blocked until a human approves the deploy." })).toEqual([]);
    expect(rulesOf({ ...base, what: "My client Globex needs SSO before the agent can log in." })).toEqual(["private_name"]);
  });

  it("stores exactly what it scanned: invisible and control characters are removed, look-alikes folded", () => {
    const r = gate({ ...base, what: "hello \u{E0041}\u{E0042}\u202Eworld\u0000ok", tool: "ｇｈ cli", workaround: "step one\nstep two" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.note.what).toBe("hello world ok");
    expect(r.note.tool).toBe("gh cli");
    expect(r.note.workaround).toBe("step one\nstep two");
    expect(rulesOf({ ...base, what: "ask jane\u2062@acme.io" })).toEqual(["email"]); // invisible times, not in a fixed list
  });

  it("never splits a surrogate pair in the teaser", () => {
    const r = gate({ ...base, workaround: "\u{1F600}".repeat(100) });
    expect(r.ok && r.note.teaser).toBe("\u{1F600}".repeat(79) + "…");
  });

  it("bounds scan time on oversize input and still reports too_long", () => {
    const t0 = Date.now();
    expect(rulesOf({ ...base, what: "a".repeat(500_000) })).toEqual(["too_long"]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("blocks credential and host shapes that slipped past the first rules", () => {
    for (const [what, rule] of [
      ["Key pk_live_abc123def was rejected", "secret"], ["Header Basic dXNlcjpwYXNzd29yZA== failed", "secret"],
      ["Pasted -----BEGIN RSA PRIVATE KEY----- by mistake", "secret"], ["Set MY_API_KEY=abc first", "secret"],
      ["Run ..\\scripts\\deploy.ps1 first", "path"], ["Calls to abcdefghijkl.supabase.co fail", "url"],
      ["Preview at acme-dash.vercel.app fails", "url"], ["My project Zephyr fails builds.", "private_name"],
    ] as const) expect(rulesOf({ ...base, what }), what).toEqual([rule]);
    expect(rulesOf({ ...base, what: "Bearer authentication is required on every call." })).toEqual([]);
  });
});
