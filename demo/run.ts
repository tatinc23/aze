// The stage loop: Agent A files a real incident; Agent B checks known issues, hits the paywall, pays, unlocks.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

export const DEMO_NOTE = {
  kind: "barrier",
  category: "signup",
  surface: "Inkbox",
  what: "Signup blocks on a 6-digit code sent to a human inbox, so an unattended agent cannot finish creating its identity.",
  tool: "signup form",
  workaround: "Ask your human for the 6-digit code once at the start, finish signup, then reuse the session; do not retry signup in a loop (it re-sends codes and rate-limits).",
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
  const b = createx402MCPClient({
    name: "agent-b", version: "1.0.0",
    schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(privateKeyToAccount(o.buyerKey as `0x${string}`)) }],
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
    log(`B  paid: ${!!r.paymentMade} tx: ${r.paymentResponse?.transaction ?? "-"}${r.paymentResponse?.transaction ? ` (https://sepolia.basescan.org/tx/${r.paymentResponse.transaction})` : ""}`);
  } else log("B  no workaround to unlock");
  await b.close();

  const stats = await fetch(new URL("/api/stats", url)).then((r) => r.json()).catch(() => null);
  if (stats) log(`dashboard → notes ${stats.notes}, queries ${stats.queries}, unlocks ${stats.unlocks}, paid to filers ${String(stats.filer_earned_micro / 1e6)} USDC (store: ${stats.store})`);
  return { filed, envelope: env, unlocked };
}
