// Stream A: executors for aze (MCP to self), mcp (other Manufact servers), http_fetch; S3: instabox, inkbox.
import type { Store } from "../types.js";
import type { Executor, ExecutorKind, ProviderDiag } from "./types.js";

export function createExecutors(_env: NodeJS.ProcessEnv, _store: Store): { executors: Partial<Record<ExecutorKind, Executor>>; diags: ProviderDiag[] } {
  return { executors: {}, diags: [] };
}
