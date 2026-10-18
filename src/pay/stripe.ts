// Stream D: Stripe machine payments. D1: record x402 settlements as Stripe PaymentIntents (transaction_verification).
// D2: MPP (Shared Payment Tokens) card path for unlocks, test mode. Never live mode.
import type { PaymentsPlugin, ProviderDiag } from "../runtime/types.js";

export function createStripeRail(_env: NodeJS.ProcessEnv): { plugin: PaymentsPlugin | null; diags: ProviderDiag[] } {
  return { plugin: null, diags: [] };
}
