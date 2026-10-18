// GET /admin/diag: runs every provider check from the live server (the dev container can't reach the providers).
// Needs x-admin-key (constant-time). Reports ok/detail/ms per provider; never prints secrets: each provider redacts its
// own detail, and every detail is scrubbed once more here (secret-looking env values, EVM addresses, key-shaped tokens)
// before it is returned or logged. DIAG_ON_BOOT=1 (index.ts) logs the same results once, 10 s after boot.
import type { ProviderDiag, RuntimeDeps } from "../runtime/types.js";
import { isAdmin, redactPublic } from "./runtime.js";

const TIMEOUT_MS = 15_000;
export const BOOT_DIAG_DELAY_MS = 10_000;
/** Detail length in the one-line DIAG log. */
export const LOG_DETAIL_MAX = 300;

export interface DiagResult { name: string; ok: boolean; detail: string; ms: number }

// Env vars whose values must never appear in a diag detail or log line: anything named like a credential, plus the
// ids and addresses that identify the account (addresses are also masked by pattern).
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|SEED|PASSWORD|PRIVATE|MNEMONIC|CREDENTIAL)/i;
const SECRET_NAMES = ["CF_ACCOUNT_ID", "STRIPE_PROFILE_ID", "SUPABASE_URL", "PLATFORM_ADDRESS", "STRIPE_DEPOSIT_ADDRESS", "DEMO_FILER_ADDRESS"];

/** Values of secret-looking env vars (>= 8 chars), longest first so a value containing another is replaced whole. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    const val = v.trim();
    if (val.length >= 8 && (SECRET_NAME_RE.test(k) || SECRET_NAMES.includes(k))) out.add(val);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** One provider detail made safe to return or log: secret env values, EVM addresses and key-shaped tokens masked. */
export function scrubDetail(detail: unknown, secrets: string[]): string {
  let t = String(detail ?? "");
  for (const s of secrets) t = t.split(s).join("[redacted]");
  return redactPublic(t);
}

export async function runDiags(diags: ProviderDiag[], secrets: string[] = secretValues(process.env)): Promise<DiagResult[]> {
  return Promise.all(
    diags.map(async (d) => {
      const t0 = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const r = await Promise.race([
          d.check(),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS); }),
        ]);
        return { name: d.name, ok: r.ok === true, detail: scrubDetail(r.detail, secrets), ms: Number(r.ms) || Date.now() - t0 };
      } catch (e) {
        return { name: d.name, ok: false, detail: scrubDetail((e as Error)?.message ?? e, secrets).slice(0, 300), ms: Date.now() - t0 };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/** The one-line log: "DIAG " + JSON [{name, ok, ms, detail}] with each detail scrubbed and cut to 300 chars. */
export function diagLogLine(results: DiagResult[], secrets: string[] = []): string {
  return `DIAG ${JSON.stringify(results.map((r) => ({ name: r.name, ok: r.ok, ms: r.ms, detail: scrubDetail(r.detail, secrets).slice(0, LOG_DETAIL_MAX) })))}`;
}

/** Boot line naming which runtime providers are wired (no values, only on/off). */
export function providersLine(rt: RuntimeDeps): string {
  const on = (v: unknown) => (v ? "on" : "off");
  const p = rt.payments;
  const pay = !p ? "off" : `on(${[p.onSettled ? "x402-record" : null, p.registerTools || p.registerRoutes ? "card" : null].filter(Boolean).join(",") || "none"})`;
  const chat = rt.chatBackend ? ` chat=${rt.chatBackend}` : "";
  return `RUNTIME providers: router=${on(rt.router)}${chat} args=${on(rt.args)} distiller=${on(rt.distiller)} notes=${on(rt.noteWriter)} ` +
    `renderer=${on(rt.renderer)} auditor=${on(rt.auditor)} payments=${pay} diags=${rt.diags.length}`;
}

/** DIAG_ON_BOOT=1: run every diag once, `delayMs` after boot, and log one DIAG line. Never throws; unref'd timer. */
export function scheduleBootDiag(
  diags: ProviderDiag[],
  opts: { delayMs?: number; env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {},
): ReturnType<typeof setTimeout> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const timer = setTimeout(() => {
    const secrets = secretValues(opts.env ?? process.env);
    runDiags(diags, secrets)
      .then((results) => log(diagLogLine(results, secrets)))
      .catch((e) => log(`DIAG failed: ${scrubDetail((e as Error)?.message ?? e, secrets).slice(0, LOG_DETAIL_MAX)}`));
  }, opts.delayMs ?? BOOT_DIAG_DELAY_MS);
  timer.unref?.();
  return timer;
}

export function registerDiag(app: any, deps: { adminKey?: string; diags: ProviderDiag[]; env?: NodeJS.ProcessEnv }) {
  app.get("/admin/diag", async (c: any) => {
    if (!isAdmin(c.req.header("x-admin-key"), deps.adminKey)) return c.json({ ok: false, code: "unauthorized" }, 401);
    const secrets = secretValues(deps.env ?? process.env);
    const results = await runDiags(deps.diags, secrets);
    console.log(diagLogLine(results, secrets));
    return c.json({ ok: results.every((r) => r.ok), providers: results });
  });
}
