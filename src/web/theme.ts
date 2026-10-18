// Shared look for the public pages (landing, dashboard, connect): color tokens, type, the site header and the logo.
// Pages stay one HTML string each (no build step, nothing loaded from other origins), so this module only exports
// strings. The road metaphor is the one bold element: kind markers (stop / hazard / clear) are shared by every page.

/** System font stack: Avenir Next on Apple, Segoe UI Variable on Windows, the platform UI face elsewhere. */
export const FONT = `"Avenir Next","Avenir","Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,sans-serif`;
export const MONO = `ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace`;

const LIGHT = `
  color-scheme:light;
  --page:#f5f7fa;--surface:#ffffff;--raise:#eef2f7;
  --ink:#16202f;--ink-2:#4b5565;--muted:#6b7483;--line:#dce1e8;--line-2:#c9d0da;
  --route:#1d5fd6;--route-ink:#ffffff;--route-bg:#e8effc;
  --asphalt:#263041;--asphalt-2:#33405a;--lane:#f2c94c;
  --stop:#be3a22;--stop-bg:#fbe9e5;--hazard:#a86400;--hazard-bg:#fdf1dc;--clear:#1d7a4c;--clear-bg:#e4f4ea;
  --focus:#1d5fd6;`;
const DARK = `
  color-scheme:dark;
  --page:#0e1420;--surface:#151d2b;--raise:#1b2536;
  --ink:#e8ecf3;--ink-2:#b4bccb;--muted:#8f99aa;--line:#273246;--line-2:#34415a;
  --route:#6ea2ff;--route-ink:#0e1420;--route-bg:#17284a;
  --asphalt:#0a0f18;--asphalt-2:#1d2738;--lane:#e5b93c;
  --stop:#ff8a73;--stop-bg:#3a1c17;--hazard:#f2b552;--hazard-bg:#33260f;--clear:#5fd394;--clear-bg:#14301f;
  --focus:#6ea2ff;`;

export const TOKENS = `
:root{${LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
html,body{margin:0}
body{background:var(--page);color:var(--ink);font:16px/1.55 ${FONT};font-feature-settings:"tnum" 0}
a{color:var(--route)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:6px}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.site{border-bottom:1px solid var(--line);background:var(--surface)}
.site-in{max-width:1200px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;gap:8px 20px;flex-wrap:wrap}
.logo{display:flex;align-items:center;gap:9px;color:var(--ink);text-decoration:none;font-weight:750;font-size:21px;letter-spacing:-.02em}
.logo svg{width:28px;height:28px;flex:none}
.lg-pin{fill:var(--route)}.lg-lane{fill:var(--route-ink)}
.nav{display:flex;gap:4px;margin:0;padding:0;list-style:none;flex-wrap:wrap}
.nav a{display:block;padding:6px 12px;border-radius:8px;color:var(--ink-2);text-decoration:none;font-weight:600;font-size:15px}
.nav a:hover{background:var(--raise);color:var(--ink)}
.nav a[aria-current="page"]{color:var(--ink);background:var(--raise)}
.site-end{margin-left:auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.test{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;background:var(--hazard-bg);color:var(--hazard);font-weight:650;font-size:13px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 18px;border-radius:10px;font:inherit;font-weight:700;font-size:15px;text-decoration:none;border:1px solid transparent;cursor:pointer}
.btn-primary{background:var(--route);color:var(--route-ink)}
.btn-primary:hover{filter:brightness(1.08)}
.btn-quiet{background:transparent;color:var(--ink);border-color:var(--line-2)}
.btn-quiet:hover{background:var(--raise)}
.mk{position:relative;display:inline-block;flex:none;width:22px;height:22px;forced-color-adjust:none}
.mk::after{content:"";position:absolute;background:#fff}
.mk-stop{background:var(--stop);clip-path:polygon(29% 0,71% 0,100% 29%,100% 71%,71% 100%,29% 100%,0 71%,0 29%)}
.mk-stop::after{left:24%;right:24%;top:43%;height:14%;border-radius:1px}
.mk-hazard{background:var(--hazard);clip-path:polygon(50% 3%,100% 97%,0 97%)}
.mk-hazard::after{left:45%;width:10%;top:36%;height:30%;border-radius:1px;box-shadow:0 .2em 0 -.02em #fff}
.mk-clear{background:var(--clear);border-radius:50%}
.mk-clear::after{left:30%;top:22%;width:22%;height:42%;background:transparent;border:solid #fff;border-width:0 .16em .16em 0;transform:rotate(45deg);transform-origin:center}
.mk-note{background:var(--route);border-radius:50% 50% 50% 0;transform:rotate(-45deg) scale(.86)}
.mk-note::after{left:34%;top:34%;width:32%;height:32%;border-radius:50%}
@media (max-width:640px){.site-end .test{display:none}}
@media (max-width:520px){.site-end{display:none}}
@media (forced-colors:active){.btn,.test{border:1px solid CanvasText}}
`;

/** The Aze mark: a map pin with a dashed lane through it, colored by theme tokens via classes. */
export const LOGO_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M16 2C9.9 2 5 6.8 5 12.8 5 21 16 30 16 30s11-9 11-17.2C27 6.8 22.1 2 16 2z" class="lg-pin"/><rect x="14.6" y="6.5" width="2.8" height="4.2" rx="1.2" class="lg-lane"/><rect x="14.6" y="12.3" width="2.8" height="4.2" rx="1.2" class="lg-lane"/><rect x="14.6" y="18.1" width="2.8" height="3" rx="1.2" class="lg-lane"/></svg>`;

/** Kind -> road marker, drawn in CSS (no inline SVG, so rendered note rows never contain markup beyond spans).
 * barrier = stop sign, friction/cost/trust/missing data = hazard triangle, worked_well = green check, else a pin. */
export type Marker = "stop" | "hazard" | "clear" | "note";
export const markerHtml = (m: Marker) => `<span class="mk mk-${m}" aria-hidden="true"></span>`;

/** Client-side JS (string concatenation only, no template syntax) mapping a note kind to its marker span. */
export const MARKER_JS = `
  function markerOf(kind){
    var k = String(kind || '');
    var t = k === 'barrier' ? 'stop' : (k === 'friction' || k === 'cost' || k === 'trust' || k === 'missing_data') ? 'hazard' : k === 'worked_well' ? 'clear' : 'note';
    return '<span class="mk mk-' + t + '" aria-hidden="true"></span>';
  }
`;

export type Page = "home" | "dashboard" | "connect";

/** Site header: logo, three links, test-mode pill and one call to action. */
export function siteHeader(active: Page): string {
  const link = (href: string, label: string, page: Page) =>
    `<li><a href="${href}"${active === page ? ' aria-current="page"' : ""}>${label}</a></li>`;
  return `<header class="site"><div class="site-in">
<a class="logo" href="/">${LOGO_SVG}<span>Aze</span></a>
<nav aria-label="Site"><ul class="nav">${link("/", "Overview", "home")}${link("/dashboard", "Live map", "dashboard")}${link("/connect", "Connect", "connect")}</ul></nav>
<div class="site-end"><span class="test">Test mode: Base Sepolia test USDC</span>${active === "connect" ? "" : `<a class="btn btn-primary" href="/connect">Add to your agent</a>`}</div>
</div></header>`;
}
