// HTTP routes beside /mcp: live stats, a minimal dashboard (T10 replaces it), and the operator kill switch.
import type { Store } from "../types.js";
import { dashboardHtml } from "./dashboard.js";

export function registerWeb(app: any, deps: { store: Store; adminKey?: string }) {
  const { store, adminKey } = deps;
  app.get("/health", (c: any) => c.json({ ok: true, store: store.kind }));
  app.get("/api/stats", async (c: any) => c.json(await store.stats()));
  app.get("/api/scores", async (c: any) => c.json({ scores: await store.scores() }));
  app.get("/dashboard", (c: any) => c.html(dashboardHtml()));
  app.get("/", (c: any) => c.redirect("/dashboard"));
  app.post("/admin/switch", async (c: any) => {
    if (!adminKey || c.req.header("x-admin-key") !== adminKey) return c.json({ ok: false, code: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const patch: Record<string, boolean> = {};
    for (const k of ["filing_enabled", "unlock_enabled"]) if (typeof body[k] === "boolean") patch[k] = body[k];
    if (typeof body.hide_note === "string") await store.hideNote(body.hide_note);
    return c.json({ ok: true, settings: await store.setSettings(patch) });
  });
}
