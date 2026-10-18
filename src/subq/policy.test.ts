import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CATEGORIES, DEFAULT_POLICY, DEFAULT_POLICY_TEXT, MAX_POLICY_CHARS, SEVERITY_LEVELS, loadPolicy, parsePolicyCategories, policyFromText,
  resetPolicyCache,
} from "./policy.js";

afterEach(() => resetPolicyCache());

describe("default policy", () => {
  it("has the 12 categories, a 1-5 severity scale, and the privacy / spam / injection rules", () => {
    expect(Object.keys(DEFAULT_CATEGORIES)).toEqual(["auth", "signup", "docs", "rate-limit", "pricing", "errors", "schema", "latency", "availability", "sdk", "payments", "other"]);
    expect(SEVERITY_LEVELS).toHaveLength(5);
    expect(SEVERITY_LEVELS[0]).toMatch(/^1 cosmetic/);
    expect(SEVERITY_LEVELS[4]).toMatch(/^5 blocks the task completely/);
    for (const k of Object.keys(DEFAULT_CATEGORIES)) expect(DEFAULT_POLICY_TEXT).toContain(`- ${k}:`);
    for (const word of ["email", "file paths", "branch names", "UUIDs", "@handles", "IP addresses", "public product", "ignore previous instructions", "ads"])
      expect(DEFAULT_POLICY_TEXT).toContain(word);
    expect(DEFAULT_POLICY.source).toBe("default");
  });
});

describe("parsePolicyCategories", () => {
  it("reads bullets in a Categories section (several markdown styles) and adds 'other'", () => {
    const md = [
      "# Audit policy", "Some intro.", "- not a category: this bullet is outside the section",
      "## Categories (pick one)",
      "- **auth**: logins and keys",
      "- `rate-limit` — quotas and throttling",
      "* Docs - documentation problems",
      "1. billing (prices and invoices)",
      "- Use exactly one category per note, and keep it short.",
      "## Severity", "- 1 cosmetic: tiny",
    ].join("\n");
    expect(parsePolicyCategories(md)).toEqual({
      auth: "logins and keys", "rate-limit": "quotas and throttling", docs: "documentation problems", billing: "prices and invoices",
      other: DEFAULT_CATEGORIES.other,
    });
  });

  it("reads a markdown table, skipping header and separator rows", () => {
    const md = "## Category list\n| Category | Meaning |\n|---|---|\n| auth | logins |\n| sdk | client libraries |\n| other | anything else |\n";
    expect(parsePolicyCategories(md)).toEqual({ auth: "logins", sdk: "client libraries", other: "anything else" });
  });

  it("reads an inline 'Categories: a, b, c' line", () => {
    expect(Object.keys(parsePolicyCategories("Intro\n**Categories:** auth, signup, docs.\n")!)).toEqual(["auth", "signup", "docs", "other"]);
  });

  it("returns null when fewer than two are found", () => {
    expect(parsePolicyCategories("# Policy\nNo list here.")).toBeNull();
    expect(parsePolicyCategories("## Categories\n- auth: only one")).toBeNull();
  });
});

describe("policyFromText + loadPolicy", () => {
  it("uses the file text (capped) and falls back to default categories", () => {
    const p = policyFromText(`# Muse policy\n${"x".repeat(MAX_POLICY_CHARS + 100)}`);
    expect(p.source).toBe("file");
    expect(p.text.length).toBe(MAX_POLICY_CHARS);
    expect(p.categories).toEqual(DEFAULT_CATEGORIES);
  });

  it("reads Muse's file at first use and caches it; missing files give the default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aze-policy-"));
    try {
      const file = join(dir, "audit-policy.md");
      await writeFile(file, "# Muse audit policy\n## Categories\n- identity: proving who you are\n- billing: money\n");
      const p = await loadPolicy([join(dir, "missing.md"), file]);
      expect(p).toMatchObject({ source: "file", categories: { identity: "proving who you are", billing: "money", other: DEFAULT_CATEGORIES.other } });
      expect(p.text).toContain("Muse audit policy");
      await writeFile(file, "# changed");
      expect(await loadPolicy([file])).toBe(p); // cached for the process
      resetPolicyCache();
      expect(await loadPolicy([join(dir, "missing.md")])).toBe(DEFAULT_POLICY);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
