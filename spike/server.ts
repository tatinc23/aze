// T2 spike: does @x402/mcp's payment wrapper compose with an mcp-use MCPServer tool handler?
import { MCPServer } from "mcp-use";
import { z } from "zod";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const server = new MCPServer({ name: "spike", version: "0.0.1", description: "x402 spike" });
const facilitator = new HTTPFacilitatorClient({ url: process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator" });
const rs = new x402ResourceServer(facilitator);
rs.register("eip155:84532", new ExactEvmScheme());
await rs.initialize();
const accepts = await rs.buildPaymentRequirements({
  scheme: "exact", network: "eip155:84532", payTo: process.env.PLATFORM_ADDRESS!, price: "$0.01",
});
const paid = createPaymentWrapper(rs, {
  accepts, resource: { url: "mcp://tool/hello", description: "paid hello" },
  hooks: { onAfterSettlement: async (c: any) => console.log("SETTLED", JSON.stringify(c.settlement ?? c).slice(0, 300)) },
});

server.tool({ name: "ping", description: "free", inputSchema: z.object({}) },
  async () => ({ content: [{ type: "text", text: "pong" }] }));

const helloHandler = paid(async (args: { name: string }) => ({ content: [{ type: "text", text: `hello ${args.name}, you paid` }] }));
server.tool({ name: "hello", description: "paid $0.01", inputSchema: z.object({ name: z.string() }) },
  async (args: any, ctx: any) => {
    console.log("meta keys", Object.keys(ctx?.params?._meta ?? {}));
    return helloHandler(args, { _meta: ctx?.params?._meta }) as any;
  });

server.listen(Number(process.env.PORT ?? 3000));
