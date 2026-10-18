import { afterEach, describe, expect, it, vi } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
import { createWallets, MAX_WALLETS } from "./wallets.js";

// The well-known public Hardhat/Anvil test mnemonic (never holds real funds).
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

afterEach(() => vi.restoreAllMocks());

describe("createWallets", () => {
  it("derives the standard m/44'/60'/0'/0/i addresses, deterministically", () => {
    const w = createWallets({ SWARM_SEED: TEST_MNEMONIC });
    expect(w.status()).toBe("configured");
    expect(w.address(0)).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(w.address(1)).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(w.address(2)).toBe("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    const again = createWallets({ SWARM_SEED: TEST_MNEMONIC });
    expect(again.address(7)).toBe(w.address(7));
    expect(w.address(42)).toBe(mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 42 }).address);
    expect(new Set([0, 1, 2, 3, 4].map((i) => w.address(i))).size).toBe(5);
  });

  it("normalizes whitespace and case in the seed", () => {
    const w = createWallets({ SWARM_SEED: `  ${TEST_MNEMONIC.toUpperCase().split(" ").join("  \n ")}  ` });
    expect(w.address(0)).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("returns null addresses without SWARM_SEED", () => {
    for (const env of [{}, { SWARM_SEED: "" }, { SWARM_SEED: "   " }]) {
      const w = createWallets(env);
      expect(w.status()).toBe("missing");
      expect(w.address(0)).toBeNull();
    }
  });

  it("returns null addresses for an invalid mnemonic and never logs or echoes it", () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const bad = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"; // bad checksum
    for (const seed of [bad, "correct horse battery staple", "zzzz qqqq"]) {
      const w = createWallets({ SWARM_SEED: seed });
      expect(w.address(0)).toBeNull();
      expect(w.status()).toBe("invalid");
      expect(JSON.stringify({ s: w.status(), a: w.address(1) })).not.toContain(seed.split(" ")[0]);
    }
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("status() checks a configured seed lazily and refuses out-of-range indexes", () => {
    const w = createWallets({ SWARM_SEED: TEST_MNEMONIC });
    for (const i of [-1, 1.5, Number.NaN, MAX_WALLETS]) expect(w.address(i)).toBeNull();
    expect(w.address(MAX_WALLETS - 1)).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("isValidMnemonic", () => {
  it("checks word count, the English list and the checksum", async () => {
    const { isValidMnemonic } = await import("./wallets.js");
    expect(isValidMnemonic(TEST_MNEMONIC)).toBe(true);
    expect(isValidMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about")).toBe(true);
    expect(isValidMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon")).toBe(false); // checksum
    expect(isValidMnemonic("test test test test test test test test test test test tesx")).toBe(false); // not a word
    expect(isValidMnemonic("test test test")).toBe(false); // count
    // 24 words: abandon x23 + art is the BIP-39 test vector for all-zero 256-bit entropy
    expect(isValidMnemonic(`${"abandon ".repeat(23)}art`)).toBe(true);
  });
});
