// Stream A: registers the `agent_run` MCP tool (runs the pipeline for one task).
import type { Store } from "../types.js";
import type { RuntimeDeps } from "./types.js";

export function registerRuntimeTools(_server: unknown, _deps: { store: Store; runtime: RuntimeDeps; baseUrl?: string }): void {}
