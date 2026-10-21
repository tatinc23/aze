// HTTP routes beside /mcp: live stats, a minimal dashboard (T10 replaces it), and the operator kill switch.
import type { Store } from "../types.js";
import { dashboardHtml } from "./dashboard.js";
import { landingHtml } from "./landing.js";
import { docsHtml } from "./docs.js";
import { connectHtml, qrSvg, resolveBaseUrl } from "./connect.js";
import type { RuntimeDeps } from "../runtime/types.js";
import { registerDiag } from "./diag.js";
import { isAdmin, registerRuntimeWeb } from "./runtime.js";

export function registerWeb(app: any, deps: { store: Store; adminKey?: string; runtime?: RuntimeDeps | null; baseUrl?: string }) {
  const { store, adminKey } = deps;
  if (deps.runtime) {
    registerDiag(app, { adminKey, diags: deps.runtime.diags });
    registerRuntimeWeb(app, { store, runtime: deps.runtime, adminKey, baseUrl: deps.baseUrl });
    deps.runtime.payments?.registerRoutes?.(app, { store, baseUrl: deps.baseUrl });
  }
  app.get("/health", (c: any) => c.json({ ok: true, store: store.kind }));
  // Manufact answers /health itself at its edge; /api/health reaches the app.
  app.get("/api/health", (c: any) => c.json({ ok: true, store: store.kind }));
  const safe = (f: () => Promise<unknown>) => async (c: any) => {
    try { return c.json(await f()); } catch (e) { console.error("api store error:", (e as Error).message); return c.json({ ok: false, code: "store_unavailable" }, 503); }
  };
  app.get("/api/stats", safe(() => store.stats()));
  app.get("/api/scores", safe(async () => ({ scores: await store.scores() })));
  // The runtime strip and panels show only when the agent runtime has a provider on (or DASHBOARD_RUNTIME=1 forces them).
  const rt = deps.runtime;
  const runtimePanels = process.env.DASHBOARD_RUNTIME === "1" || Boolean(rt?.router);
  app.get("/dashboard", (c: any) => c.html(dashboardHtml({ runtimePanels })));
  // Public base URL: MCP_URL (minus /mcp) if set, else the request origin.
  const base = (c: any) => resolveBaseUrl(process.env.MCP_URL, c.req.url, c.req.header("x-forwarded-proto"));
  app.get("/connect", (c: any) => c.html(connectHtml(base(c))));
  app.get("/docs", (c: any) => c.html(docsHtml(base(c))));
  app.get("/qr.svg", async (c: any) =>
    c.body(await qrSvg(`${base(c)}/connect`), 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "private, max-age=300" }));
  app.get("/", (c: any) => c.html(landingHtml()));
  app.post("/admin/switch", async (c: any) => {
    if (!isAdmin(c.req.header("x-admin-key"), adminKey)) return c.json({ ok: false, code: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const patch: Record<string, boolean> = {};
    for (const k of ["filing_enabled", "unlock_enabled"]) if (typeof body[k] === "boolean") patch[k] = body[k];
    if (typeof body.hide_note === "string") await store.hideNote(body.hide_note);
    return c.json({ ok: true, settings: await store.setSettings(patch) });
  });
}
