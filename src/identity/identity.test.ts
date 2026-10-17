import { describe, expect, it } from "vitest";
import { attest } from "./index.js";

describe("attest", () => {
  it("returns unverified with or without a proof (seam until Inkbox is confirmed)", async () => {
    expect(await attest(undefined)).toBe("unverified");
    expect(await attest("some-proof")).toBe("unverified");
  });
});
