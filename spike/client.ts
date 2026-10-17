import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { privateKeyToAccount } from "viem/accounts";

const url = process.argv[2] ?? "http://localhost:3000/mcp";
const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`);
const client = createx402MCPClient({
  name: "spike-buyer", version: "0.0.1",
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
  autoPayment: true,
  onPaymentRequested: async ({ paymentRequired }: any) => { console.log("PAYMENT REQUESTED", JSON.stringify(paymentRequired.accepts[0]).slice(0, 200)); return true; },
} as any);
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
console.log("ping →", JSON.stringify((await client.callTool("ping", {})).content));
const r: any = await client.callTool("hello", { name: "spike" });
console.log("hello →", JSON.stringify(r.content), "isError:", r.isError, "paymentMade:", r.paymentMade, "tx:", r.paymentResponse?.transaction);
await client.close();
