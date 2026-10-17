import type { Store } from "../types.js";
import { MemoryStore } from "./memory.js";
import { SupabaseStore } from "./supabase.js";

export { MemoryStore, SupabaseStore };

/** Supabase when both env vars are set, else an in-memory store (data is lost on restart). */
export function createStore(env: NodeJS.ProcessEnv = process.env): Store {
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    console.log("[store] supabase");
    return new SupabaseStore(url, key);
  }
  console.warn("[store] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set: using in-memory store (data resets on restart)");
  return new MemoryStore();
}
