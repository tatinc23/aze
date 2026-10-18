// Stream C: Workers AI renderer over the Cloudflare REST API (primary GLM-5.3 Flash, fallback gpt-oss-120b).
import type { ProviderDiag, Renderer } from "../runtime/types.js";

export function createRenderer(_env: NodeJS.ProcessEnv): { renderer: Renderer | null; diags: ProviderDiag[] } {
  return { renderer: null, diags: [] };
}
