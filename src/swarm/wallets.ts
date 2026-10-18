// Stream E: payout addresses for swarm agents, derived from one HD seed (env SWARM_SEED, a BIP-39 mnemonic).
// Agent i (0-based) gets m/44'/60'/0'/0/i. TEST ONLY: these addresses receive Base Sepolia test USDC.
// The seed and private keys never leave this module: we keep only addresses, and never log or return the seed.
// Side-effect free: nothing is derived until the first address is asked for.
import { createHash } from "node:crypto";
import { english, mnemonicToAccount } from "viem/accounts";

export const MAX_WALLETS = 1000;

export type WalletStatus = "configured" | "missing" | "invalid";

export interface Wallets {
  /** "missing" without SWARM_SEED, "invalid" if it is not a valid BIP-39 mnemonic. Never includes the seed. */
  status(): WalletStatus;
  /** Payout address for agent index i (0-based), or null when no valid seed is configured. */
  address(i: number): string | null;
}

/** Collapse whitespace; BIP-39 words are lowercase ASCII for the English list. */
const normalize = (seed: string) => seed.trim().split(/\s+/).join(" ").toLowerCase();

let WORD_INDEX: Map<string, number> | null = null;
/** Full BIP-39 check (English list): 12-24 words, every word in the list, and the checksum bits match.
 * viem's mnemonicToAccount only checks the word count, so a typo would silently derive different addresses. */
export function isValidMnemonic(seed: string): boolean {
  const words = normalize(seed).split(" ");
  if (![12, 15, 18, 21, 24].includes(words.length)) return false;
  WORD_INDEX ??= new Map(english.map((w, i) => [w, i]));
  let bits = "";
  for (const w of words) {
    const i = WORD_INDEX.get(w);
    if (i === undefined) return false;
    bits += i.toString(2).padStart(11, "0");
  }
  const csLen = bits.length / 33;
  const entBits = bits.slice(0, bits.length - csLen);
  const entropy = Buffer.from(entBits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const hash = createHash("sha256").update(entropy).digest();
  const expected = Array.from(hash).map((b) => b.toString(2).padStart(8, "0")).join("").slice(0, csLen);
  return expected === bits.slice(bits.length - csLen);
}

export function createWallets(env: NodeJS.ProcessEnv = process.env): Wallets {
  const raw = typeof env.SWARM_SEED === "string" ? env.SWARM_SEED : "";
  let seed: string | null = raw.trim() ? normalize(raw) : null;
  let status: WalletStatus = seed ? "configured" : "missing";
  let checked = !seed;
  const cache = new Map<number, string>();
  const reject = () => {
    seed = null;
    status = "invalid";
    checked = true;
    cache.clear();
  };

  function derive(i: number): string | null {
    if (!seed) return null;
    const hit = cache.get(i);
    if (hit) return hit;
    if (!checked && !isValidMnemonic(seed)) {
      reject();
      return null;
    }
    try {
      const address = mnemonicToAccount(seed, { addressIndex: i }).address;
      cache.set(i, address);
      checked = true;
      return address;
    } catch {
      // Forget the seed; the error text is not kept (it could echo input).
      reject();
      return null;
    }
  }

  return {
    status() {
      if (!checked) derive(0);
      return status;
    },
    address(i: number) {
      if (!Number.isInteger(i) || i < 0 || i >= MAX_WALLETS) return null;
      return derive(i);
    },
  };
}
