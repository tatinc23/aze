// Stream A replaces this with MemoryRunStore + SupabaseRunStore (tables in supabase/migrations/0003_warehouse.sql).
import type { RunStore } from "./types.js";

export function createRunStore(_env: NodeJS.ProcessEnv): RunStore {
  const empty = { runs: 0, done: 0, failed: 0, running: 0, notes_filed: 0, avg_ms_by_tier: {}, cost_micro_usd_by_tier: {}, compression_ratio: null };
  return {
    listAssets: async () => [],
    upsertAssets: async () => {},
    insertRun: async () => { throw new Error("run store not implemented yet"); },
    finishRun: async () => {},
    listRuns: async () => [],
    runStats: async () => empty,
  };
}
