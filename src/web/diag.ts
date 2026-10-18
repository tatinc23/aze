// GET /admin/diag: runs every provider check from the live server (the dev container can't reach the providers).
// Needs x-admin-key. Reports ok/detail/ms per provider; never prints secrets.
import type { ProviderDiag } from "../runtime/types.js";

const TIMEOUT_MS = 15_000;

export async function runDiags(diags: ProviderDiag[]) {
  return Promise.all(
    diags.map(async (d) => {
      const t0 = Date.now();
      try {
        const r = await Promise.race([
          d.check(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)),
        ]);
        return { name: d.name, ...r };
      } catch (e) {
        return { name: d.name, ok: false, detail: (e as Error).message.slice(0, 300), ms: Date.now() - t0 };
      }
    }),
  );
}

export function registerDiag(app: any, deps: { adminKey?: string; diags: ProviderDiag[] }) {
  app.get("/admin/diag", async (c: any) => {
    if (!deps.adminKey || c.req.header("x-admin-key") !== deps.adminKey) return c.json({ ok: false, code: "unauthorized" }, 401);
    const results = await runDiags(deps.diags);
    console.log("DIAG", JSON.stringify(results));
    return c.json({ ok: results.every((r) => r.ok), providers: results });
  });
}
