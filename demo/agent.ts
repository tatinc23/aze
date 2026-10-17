// CLI: BUYER_PRIVATE_KEY=0x... npx tsx demo/agent.ts https://<server>/mcp
import { runDemo } from "./run.js";
const url = process.argv[2] ?? process.env.MCP_URL ?? "http://localhost:3000/mcp";
if (!process.env.BUYER_PRIVATE_KEY) { console.error("Set BUYER_PRIVATE_KEY (test wallet)."); process.exit(1); }
await runDemo({ url, buyerKey: process.env.BUYER_PRIVATE_KEY, filerAddress: process.env.DEMO_FILER_ADDRESS });
