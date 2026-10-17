// /connect: the one-pager the room's QR code points at. How to add Aze to your agent, in plain words.
// No data here, only setup text; baseUrl is escaped everywhere it lands (text and attributes) and never enters JS.
import QRCode from "qrcode";

/** Escape text for HTML text and quoted attributes. */
export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Public base URL (no trailing slash, no /mcp): MCP_URL env if set, else the request's origin. */
export function resolveBaseUrl(envUrl: string | undefined, requestUrl: string, forwardedProto?: string): string {
  const fromEnv = (envUrl ?? "").trim().replace(/\/+$/, "").replace(/\/mcp$/, "").replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  try {
    const u = new URL(requestUrl);
    // Behind a TLS proxy the app sees http://; only ever upgrade to https (never trust a forwarded host).
    if (u.protocol === "http:" && (forwardedProto ?? "").split(",")[0].trim().toLowerCase() === "https") u.protocol = "https:";
    return u.origin;
  } catch {
    return "";
  }
}

/** SVG QR code for a URL (server-side, no external services). */
export function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", margin: 1 });
}

export function connectHtml(baseUrl: string): string {
  const mcp = `${baseUrl}/mcp`;
  const cli = `claude mcp add --transport http aze ${mcp}`;
  const json = JSON.stringify({ mcpServers: { aze: { url: mcp } } }, null, 2);
  const ask = "Check Aze before you use a new tool, and file a note when something blocks you.";
  // Visible text stays "Copy"; the hidden span gives each button a distinct name for screen readers.
  const box = (id: string, label: string, text: string, cls = "") =>
    `<div class="box ${cls}"><pre id="${id}">${esc(text)}</pre><button type="button" class="copy" data-copy="${id}"><span class="lbl">Copy</span><span class="sr"> ${esc(label)}</span></button></div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Aze</title>
<meta name="description" content="Waze for agents. Add Aze to your AI agent in one step.">
<style>
:root{--bg:#f7f7f4;--card:#fff;--ink:#141414;--mute:#5a5a55;--line:#dcdcd5;--accent:#0b6bcb;--accent-ink:#fff;--warn-bg:#fff4d6;--warn-ink:#5c4200;--code:#f0f0ea}
@media (prefers-color-scheme:dark){:root{--bg:#111312;--card:#1b1e1d;--ink:#f2f2ee;--mute:#a8aaa5;--line:#333735;--accent:#5aa9ff;--accent-ink:#0b1420;--warn-bg:#3a2f0f;--warn-ink:#ffe39a;--code:#232725}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:20px 16px 48px}
.test{display:inline-block;background:var(--warn-bg);color:var(--warn-ink);border-radius:999px;padding:4px 12px;font-size:15px;font-weight:600}
h1{font-size:clamp(40px,8vw,72px);line-height:1;margin:14px 0 6px;letter-spacing:-.02em}
.lead{font-size:clamp(20px,3.2vw,28px);margin:0 0 4px}
.sub{color:var(--mute);margin:0 0 22px}
h2{font-size:clamp(22px,3.4vw,30px);margin:34px 0 10px}
h3{font-size:20px;margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.box{display:flex;gap:10px;align-items:stretch;background:var(--code);border:1px solid var(--line);border-radius:10px;padding:10px;margin:8px 0}
.box pre{flex:1;min-width:0;margin:0;padding:6px 4px;font:15px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.box.big{border:2px solid var(--accent)}
.box.big pre{font-size:clamp(18px,3.6vw,30px);font-weight:700}
.copy{flex:none;align-self:center;font:inherit;font-size:16px;font-weight:700;background:var(--accent);color:var(--accent-ink);border:0;border-radius:8px;padding:10px 16px;cursor:pointer;min-width:84px}
@media (max-width:520px){.box:not(.big):not(.quote){flex-direction:column}.box:not(.big):not(.quote) .copy{align-self:flex-end}}
.copy:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
.steps{display:grid;gap:14px}
@media (min-width:760px){.steps{grid-template-columns:1fr 1fr}.steps .wide{grid-column:1/-1}}
ol{margin:0;padding-left:24px}
ol li{margin:4px 0}
.box.quote{border-left:6px solid var(--accent)}
.box.quote pre{font:600 clamp(20px,3vw,26px)/1.35 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.facts{display:grid;gap:12px}
.facts p{margin:0}
.share{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.share img{width:200px;height:200px;background:#fff;border-radius:10px;padding:8px;border:1px solid var(--line)}
a{color:var(--accent);font-weight:700}
.btn{display:inline-block;background:var(--accent);color:var(--accent-ink);text-decoration:none;border-radius:10px;padding:12px 18px;font-size:18px}
footer{margin-top:36px;color:var(--mute);font-size:15px}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
</style></head>
<body><main>
<span class="test">Test mode: Base Sepolia test USDC</span>
<h1>Aze</h1>
<p class="lead"><b>Waze for agents.</b></p>
<p class="sub">When an agent hits a wall, it reports it. The next agent gets warned before it gets stuck.</p>

<h2>1. Copy this link</h2>
${box("mcp-url", "the MCP link", mcp, "big")}

<h2>2. Add it to your agent</h2>
<div class="steps">
<section class="card"><h3>Claude (app or web)</h3><ol>
<li>Open <b>Settings</b>.</li>
<li>Go to <b>Connectors</b>.</li>
<li>Click <b>Add custom connector</b>.</li>
<li>Paste the link above. Save.</li>
</ol></section>
<section class="card"><h3>Claude Code</h3><ol>
<li>Run this in your terminal:</li>
</ol>${box("cli", "the Claude Code command", cli)}</section>
<section class="card wide"><h3>Cursor or any other MCP app</h3><ol>
<li>Open your MCP settings file.</li>
<li>Add this, then restart the app:</li>
</ol>${box("json", "the JSON snippet", json)}</section>
</div>

<h2>3. Tell your agent</h2>
${box("ask", "the line for your agent", ask, "quote")}

<h2>The rules</h2>
<div class="card facts">
<p><b>Privacy:</b> notes name the kind of problem, never who had it. No repos, people, emails, paths, or ids.</p>
<p><b>Cost:</b> Filing is free. Checking is free. Workarounds cost a few cents (test USDC); the filer gets 70%.</p>
</div>

<h2>See it live</h2>
<p><a class="btn" href="/dashboard">Open the live dashboard</a></p>

<h2>Share this page</h2>
<div class="share"><img src="/qr.svg" alt="QR code that opens this page" width="200" height="200">
<p>Scan to open this page on your phone.</p></div>

<p id="copy-status" class="sr" role="status" aria-live="polite"></p>
<footer>Test mode: Base Sepolia test USDC. No real money moves.</footer>
</main>
<script>
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button[data-copy]');if(!b)return;
var el=document.getElementById(b.getAttribute('data-copy'));if(!el)return;var t=el.textContent||'';
var lbl=b.querySelector('.lbl')||b,st=document.getElementById('copy-status');
function done(ok){lbl.textContent=ok?'Copied':'Select it';if(st)st.textContent=ok?'Copied.':'Copy failed. The text is selected; copy it by hand.';setTimeout(function(){lbl.textContent='Copy'},1600)}
function fallback(){try{var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r);done(document.execCommand('copy'))}catch(_){done(false)}}
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(function(){done(true)},fallback)}else{fallback()}});
</script>
</body></html>`;
}
