// x402 paywall for notes_unlock. Pattern proven in spike/server.ts (T2).
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { formatUsdc } from "../advise/index.js";

export const NETWORK = "eip155:84532"; // Base Sepolia
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export interface Settled { note_id: string; tx_hash: string; network: string; amount_micro: number }
// A type alias (not an interface) so it satisfies @x402/mcp's index-signature ToolResult.
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export async function createPaywall(opts: {
  facilitatorUrl: string;
  payTo: string;
  priceMicro: number;
  onSettled: (args: Settled) => Promise<void>;
}): Promise<{ wrap: <A extends Record<string, unknown>>(handler: (args: A) => Promise<ToolResult>) => (args: A, ctx: any) => Promise<any> }> {
  const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: opts.facilitatorUrl }));
  rs.register(NETWORK, new ExactEvmScheme());
  await rs.initialize();
  const accepts = await rs.buildPaymentRequirements({
    scheme: "exact", network: NETWORK, payTo: opts.payTo, price: "$" + formatUsdc(opts.priceMicro),
  });
  const paid = createPaymentWrapper(rs, {
    accepts,
    resource: { url: "mcp://tool/notes_unlock", description: "Full workaround for a field note" },
    hooks: {
      // SettlementContext extends ServerHookContext, whose `arguments` field holds the tool args.
      onAfterSettlement: async (c) => {
        const settled: Settled = {
          note_id: String(c.arguments?.note_id),
          tx_hash: c.settlement.transaction,
          network: c.settlement.network,
          amount_micro: opts.priceMicro,
        };
        // The payment already settled on-chain: a ledger failure must not turn the paid response into an error.
        try {
          await opts.onSettled(settled);
        } catch (err) {
          console.error("!!! LEDGER WRITE FAILED after settled payment !!!", JSON.stringify(settled), err);
        }
      },
    },
  });
  return {
    // mcp-use passes the payment in ctx.params._meta, not ctx._meta.
    wrap: (handler) => {
      const wrapped = paid(handler);
      return async (args, ctx) => wrapped(args, { _meta: ctx?.params?._meta });
    },
  };
}
