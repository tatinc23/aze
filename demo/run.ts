// The stage loop: Agent A files a real incident; Agent B checks known issues, hits the paywall, pays, unlocks.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, erc20Abi } from "viem";
import { baseSepolia } from "viem/chains";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
async function usdcBalance(address: `0x${string}`): Promise<string> {
  try {
    const c = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org") });
    const v = await c.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    return (Number(v) / 1e6).toString();
  } catch (e) { return `unknown (${(e as Error).message.slice(0, 80)})`; }
}

// A public, well-known wall (no sponsor named): GitHub's unauthenticated REST limit.
export const DEMO_NOTE = {
  kind: "barrier",
  category: "rate-limit",
  surface: "GitHub",
  what: "The REST API returned 403 rate limit exceeded after about 60 unauthenticated requests in an hour, so the agent stalled mid-task.",
  tool: "REST API",
  error: "403 API rate limit exceeded",
  workaround: "Send a token (the authenticated limit is far higher), and use conditional requests with ETag or If-None-Match: a 304 Not Modified does not count against the limit. Check the x-ratelimit-remaining header before each burst.",
};

const parse = (r: any) => {
  const sc = r?.structuredContent;
  if (sc) return sc;
  try { return JSON.parse(r?.content?.[0]?.text ?? "{}"); } catch { return { text: r?.content?.[0]?.text }; }
};

export async function runDemo(o: { url: string; buyerKey: string; filerAddress?: string; log?: (m: string) => void; note?: Record<string, unknown> }) {
  const log = o.log ?? ((m: string) => console.log(m));
  const url = new URL(o.url);

  // Agent A: an ordinary MCP client, no wallet.
  const a = new Client({ name: "agent-a", version: "1.0.0" });
  await a.connect(new StreamableHTTPClientTransport(url));
  const filed = parse(await a.callTool({ name: "notes_file", arguments: { ...(o.note ?? DEMO_NOTE), ...(o.filerAddress ? { payout_address: o.filerAddress } : {}) } }));
  log(`A  notes_file → ${JSON.stringify(filed)}`);
  await a.close();

  // Agent B: x402-capable client with a test wallet.
  const buyer = privateKeyToAccount(o.buyerKey as `0x${string}`);
  log(`B  wallet ${buyer.address} holds ${await usdcBalance(buyer.address)} test USDC`);
  const b = createx402MCPClient({
    name: "agent-b", version: "1.0.0",
    schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(buyer) }],
    autoPayment: true,
    onPaymentRequested: async ({ paymentRequired }: any) => {
      const r = paymentRequired.accepts[0];
      log(`B  402 payment required: ${Number(r.amount) / 1e6} USDC on ${r.network} → paying`);
      return true;
    },
  } as any);
  await b.connect(new StreamableHTTPClientTransport(url));
  const env = parse(await b.callTool("notes_query", { surface: String((o.note ?? DEMO_NOTE).surface) }));
  log(`B  notes_query → ${env.advisories?.length ?? 0} advisories; next: ${env.next}`);
  for (const adv of env.advisories ?? []) log(`B    [${adv.label}] ${adv.what} (reports ${adv.reports}) teaser: ${adv.teaser ?? "-"}`);
  const target = (env.advisories ?? []).find((x: any) => x.has_workaround);
  let unlocked: any = null;
  if (target) {
    const r: any = await b.callTool("notes_unlock", { note_id: target.note_id });
    unlocked = parse(r);
    log(`B  notes_unlock → ${r.isError ? "ERROR " : ""}${JSON.stringify(unlocked).slice(0, 400)}`);
    const pr = r.paymentResponse ?? r._meta?.["x402/payment-response"];
    const tx = pr?.transaction || "";
    log(`B  settlement: ${pr?.success ? "SUCCESS" : "FAILED"}${pr?.errorReason ? ` reason=${pr.errorReason}` : ""} payer=${pr?.payer ?? "-"} tx=${tx || "-"}${tx ? ` https://sepolia.basescan.org/tx/${tx}` : ""}`);
  } else log("B  no workaround to unlock");
  await b.close();

  const stats = await fetch(new URL("/api/stats", url)).then((r) => r.json()).catch(() => null);
  if (stats) log(`dashboard → notes ${stats.notes}, queries ${stats.queries}, unlocks ${stats.unlocks}, paid to filers ${String(stats.filer_earned_micro / 1e6)} USDC (store: ${stats.store})`);
  return { filed, envelope: env, unlocked };
}
