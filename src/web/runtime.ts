// Stream E: swarm admin route, run APIs for the dashboard (grid + economics).
import type { Store } from "../types.js";
import type { RuntimeDeps } from "../runtime/types.js";

export function registerRuntimeWeb(_app: any, _deps: { store: Store; runtime: RuntimeDeps; adminKey?: string; baseUrl?: string }): void {}
