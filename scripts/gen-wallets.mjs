// Generates throwaway Base Sepolia TEST wallets (buyer = demo Agent B, platform = payTo). Refuses to overwrite.
// Pattern lifted from forkyard scripts/gen-wallets.mjs (prior work, 9c1e5e98).
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { existsSync, writeFileSync } from "node:fs";
const out = ".env.wallets";
if (existsSync(out)) { console.error(`${out} exists; refusing to overwrite`); process.exit(1); }
const buyer = generatePrivateKey(), platform = generatePrivateKey(), filer = generatePrivateKey();
const addr = (k) => privateKeyToAccount(k).address;
writeFileSync(out, [
  "# TEST wallets only (Base Sepolia). Never fund with real money. Gitignored.",
  `BUYER_PRIVATE_KEY=${buyer}`, `BUYER_ADDRESS=${addr(buyer)}`,
  `PLATFORM_PRIVATE_KEY=${platform}`, `PLATFORM_ADDRESS=${addr(platform)}`,
  `DEMO_FILER_PRIVATE_KEY=${filer}`, `DEMO_FILER_ADDRESS=${addr(filer)}`, "",
].join("\n"), { mode: 0o600 });
console.log("buyer (fund this):", addr(buyer));
console.log("platform (payTo):  ", addr(platform));
console.log("demo filer:        ", addr(filer));
