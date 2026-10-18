// D2: card unlock over MPP (Machine Payments Protocol) with Stripe Shared Payment Tokens, test mode. Mirrors
// stripe-samples/machine-payments mcp/server/node-typescript: an MCP tool hands out a payment link; the link answers
// 402 with an MPP challenge; the agent pays it with an SPT (e.g. @stripe/link-cli) and retries.
// The note is checked BEFORE any charge (404/409 → nobody charged), and the ledger is written after the payment.
import { createHmac, randomUUID } from "node:crypto";
import { Mppx, stripe as mppStripe } from "mppx/server";
import { Challenge, Credential, Receipt } from "mppx";
import { z } from "zod";
import { DEFAULT_SETTINGS, type Settings, type StoredNote, type Store } from "../types.js";
import { split } from "./split.js";
import type { Logger, StripeLike } from "./stripe-record.js";
import { consoleLogger } from "./stripe-record.js";
import { CARD_NETWORK, CARD_PRICE, NOTE_ID_RE, normalizeBaseUrl, redact, unlockCardLink } from "./stripe-wire.js";

export const UNLOCK_CARD_PATH = "/api/unlock-card";
/** Credentialed requests (each one costs a Stripe API call) allowed per minute, server-wide. */
export const CARD_ATTEMPTS_PER_MINUTE = 30;
/** Largest JSON body /api/unlock-card reads (it only needs {"note_id": "<uuid>"}). */
export const MAX_BODY_BYTES = 8 * 1024;
/** How many paid references (Stripe PaymentIntent ids) we remember to refuse a second ledger row for the same payment. */
export const SEEN_REFERENCES = 1_000;

/** mppx needs >= 32 bytes; a shorter MPP_SECRET_KEY is ignored (createCardUnlock warns). */
const usableOverride = (override?: string) => Boolean(override && Buffer.byteLength(override, "utf8") >= 32);

/** HMAC secret binding MPP challenges to this server, derived exactly as the sample does (or MPP_SECRET_KEY). */
export function mppSecretFrom(stripeKey: string, override?: string): string {
  if (usableOverride(override)) return override!;
  return createHmac("sha256", stripeKey).update("mpp-challenge-signing").digest("base64");
}

/**
 * Will mppx send this request's credential to Stripe? Only when its challenge carries our HMAC and hasn't expired; mppx
 * answers everything else (garbage, forged, expired) locally with a 402 and no Stripe call. The attempt limiter counts
 * only these, so junk Authorization headers can't use up the budget and lock real payers out. Uses mppx's own parser,
 * which finds a `Payment` scheme anywhere in a comma-separated Authorization header ("Bearer x, Payment y"), so the
 * limiter and mppx agree on what a credential is.
 * "none": no Payment credential. "local": mppx rejects it without Stripe. "stripe": it reaches Stripe.
 */
export function credentialReach(req: Request, secretKey: string, nowMs: number = Date.now()): "none" | "local" | "stripe" {
  const h = req.headers.get("authorization");
  if (!h) return "none";
  let payment: string | null;
  try {
    payment = Credential.extractPaymentScheme(h);
  } catch {
    return "local"; // mppx's own transport can't read it either
  }
  if (!payment) return "none";
  try {
    const cred = Credential.deserialize(payment);
    if (!Challenge.verify(cred.challenge, { secretKey })) return "local";
    const exp = Date.parse(String(cred.challenge.expires ?? ""));
    if (!Number.isFinite(exp) || exp <= nowMs) return "local"; // mppx fails closed on missing/expired `expires`
    return "stripe";
  } catch {
    return "local";
  }
}

/** Read a small JSON body without buffering an arbitrarily large one. null if absent, too big or not JSON. */
export async function readJsonLimited(req: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const body = req.clone().body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Don't await: this is a branch of the clone()'s tee, and a tee branch's cancel() only settles once the other
        // branch is cancelled too, so awaiting it would hang this request forever.
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const jsonResponse = (status: number, data: Record<string, unknown>) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const toolJson = (data: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
  ...(isError ? { isError: true } : {}),
});

function createLimiter(max: number, windowMs: number, now: () => number) {
  const hits: number[] = [];
  return () => {
    const t = now();
    while (hits.length && t - hits[0] >= windowMs) hits.shift();
    if (hits.length >= max) return false;
    hits.push(t);
    return true;
  };
}

/** Parse the Payment-Receipt header mppx attaches; null if absent/unparseable. */
export function readReceipt(res: Response): Receipt.Receipt | null {
  const h = res.headers.get("Payment-Receipt");
  if (!h) return null;
  try {
    return Receipt.deserialize(h);
  } catch {
    return null;
  }
}

export interface CardUnlockOptions {
  stripe: StripeLike;
  stripeKey: string;
  profileId: string;
  mppSecretKey?: string;
  realm?: string;
  baseUrl?: string;
  log?: Logger;
  now?: () => number;
}

export function createCardUnlock(opts: CardUnlockOptions) {
  const log = opts.log ?? consoleLogger;
  const secrets = [opts.stripeKey, opts.mppSecretKey ?? ""];
  if (opts.mppSecretKey && !usableOverride(opts.mppSecretKey)) {
    log.warn("[stripe] MPP_SECRET_KEY is shorter than 32 bytes: ignored; challenges are signed with a secret derived from the Stripe key.");
  }
  let baseUrl = normalizeBaseUrl(opts.baseUrl);
  const now = opts.now ?? Date.now;
  const allowAttempt = createLimiter(CARD_ATTEMPTS_PER_MINUTE, 60_000, now);
  const secretKey = mppSecretFrom(opts.stripeKey, opts.mppSecretKey);
  // Stripe payment ids already in the ledger. mppx refuses a replayed credential (Stripe's idempotent-replayed
  // header), but if one ever got through, the payer still gets the workaround and the filer is not paid twice.
  const seenRefs = new Set<string>();
  const markSeen = (ref: string) => {
    seenRefs.add(ref);
    if (seenRefs.size > SEEN_REFERENCES) seenRefs.delete(seenRefs.values().next().value as string);
  };

  function build() {
    const machine = mppStripe.create({
      client: opts.stripe,
      networkId: opts.profileId,
      livemode: false, // test mode only: createStripeRail refuses anything but sk_test_ keys
    });
    return Mppx.create({
      methods: [machine.spt.charge()],
      secretKey,
      ...(opts.realm ? { realm: opts.realm } : {}),
    });
  }
  let mppx: ReturnType<typeof build> | null = null;
  const getMppx = () => (mppx ??= build());

  const chargeOptions = (noteId: string) => ({
    amount: CARD_PRICE.amount,
    currency: CARD_PRICE.currency,
    decimals: CARD_PRICE.decimals,
    description: "Aze: unlock one field-note workaround (Stripe test mode)",
    // Bound into the HMAC'd challenge (opaque), so a payment for one note can't be replayed on another.
    meta: { note_id: noteId },
  });

  async function noteIdOf(req: Request): Promise<string | null> {
    const fromQuery = new URL(req.url).searchParams.get("note_id");
    if (fromQuery) return fromQuery.trim();
    if (req.method === "POST" && (req.headers.get("content-type") ?? "").includes("json")) {
      const body = (await readJsonLimited(req)) as { note_id?: unknown } | null;
      return typeof body?.note_id === "string" ? body.note_id.trim() : null;
    }
    return null;
  }

  type Checked = { ok: true; note: StoredNote; settings: Settings } | { ok: false; status: number; body: Record<string, unknown> };
  /** Every check that must pass before anyone is charged. */
  async function check(store: Store, noteId: string | null): Promise<Checked> {
    if (!noteId || !NOTE_ID_RE.test(noteId)) {
      return { ok: false, status: 400, body: { ok: false, code: "bad_request", hint: "Pass note_id (from notes_query). Nobody was charged." } };
    }
    let settings: Settings;
    try {
      settings = await store.getSettings();
    } catch (e) {
      log.error(`unlock-card settings unavailable: ${redact((e as Error)?.message ?? String(e)).slice(0, 200)}`);
      return { ok: false, status: 503, body: { ok: false, code: "store_unavailable", hint: "Could not check the note right now; nobody was charged. Try again in a minute." } };
    }
    if (!settings.unlock_enabled) return { ok: false, status: 503, body: { ok: false, code: "paused", hint: "Unlocks are paused by the operator; nobody was charged." } };
    let note: StoredNote | null;
    try {
      note = await store.getNote(noteId);
    } catch (e) {
      log.error(`unlock-card store error: ${redact((e as Error)?.message ?? String(e)).slice(0, 200)}`);
      return { ok: false, status: 503, body: { ok: false, code: "store_unavailable", hint: "Could not look up that note right now; nobody was charged." } };
    }
    if (!note || note.hidden) return { ok: false, status: 404, body: { ok: false, code: "not_found", hint: "No such note; nobody was charged." } };
    if (!note.workaround) return { ok: false, status: 409, body: { ok: false, code: "no_workaround", hint: "This note has no workaround to unlock; nobody was charged." } };
    return { ok: true, note, settings };
  }

  /**
   * mppx answers with a 402 whose challenge is in WWW-Authenticate and whose body is RFC 9457 problem+json (for an
   * unpaid request too, in mppx 0.8.19). Agents that only read bodies need to know what to do, so answer JSON with our
   * hint and mppx's problem nested (redacted). Status and headers (WWW-Authenticate, Cache-Control) are kept.
   */
  async function withChallengeHint(challenge: Response, link: string): Promise<Response> {
    let problem: Record<string, unknown> | null = null;
    try {
      const text = challenge.body ? (await challenge.text()).slice(0, 4_000) : "";
      const parsed = text ? JSON.parse(text) : null;
      if (parsed && typeof parsed === "object") {
        problem = {};
        for (const k of ["type", "title", "status", "detail", "hint"]) {
          const v = (parsed as Record<string, unknown>)[k];
          if (typeof v === "string") problem[k] = redact(v, secrets).slice(0, 300);
          else if (typeof v === "number") problem[k] = v;
        }
      }
    } catch {
      problem = null; // not JSON (or unreadable): the header still carries the challenge
    }
    const unpaid = !problem || String(problem.type ?? "").endsWith("/payment-required");
    const headers = new Headers(challenge.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");
    headers.delete("content-length");
    const retry = `npx @stripe/link-cli mpp pay "${link}" -X POST`;
    return new Response(JSON.stringify({
      ok: false,
      code: unpaid ? "payment_required" : "payment_failed",
      price: CARD_PRICE.display,
      rail: "Stripe MPP (Shared Payment Token), test mode: no real money moves",
      hint: unpaid
        ? `Nobody was charged. The MPP challenge is in the WWW-Authenticate header. Pay it with a Stripe test-mode Shared Payment Token and retry, e.g. ${retry}`
        : `The payment did not complete, so the workaround was not returned (see problem). A fresh MPP challenge is in the WWW-Authenticate header; pay it and retry, e.g. ${retry}`,
      ...(problem ? { problem } : {}),
    }), { status: challenge.status, headers });
  }

  /** GET/POST /api/unlock-card?note_id=… Never throws: before payment → nobody charged; after → workaround delivered. */
  async function handle(req: Request, store: Store): Promise<Response> {
    let paidBody: Record<string, unknown> | null = null;
    try {
      const noteId = await noteIdOf(req);
      const checked = await check(store, noteId);
      if (!checked.ok) return jsonResponse(checked.status, checked.body);
      const { note, settings } = checked;

      // Only credentials mppx would send to Stripe count (each costs a Stripe API call); mppx rejects the rest locally.
      // Expiry is judged on mppx's own clock (Date.now), not the limiter's injectable one.
      if (credentialReach(req, secretKey) === "stripe" && !allowAttempt()) {
        return jsonResponse(429, { ok: false, code: "rate_limited", hint: "Too many payment attempts right now; nobody was charged. Retry in a minute." });
      }

      let result: Awaited<ReturnType<ReturnType<ReturnType<typeof build>["compose"]>>>;
      try {
        result = await getMppx().compose(["stripe/charge", chargeOptions(note.id)])(req);
      } catch (e) {
        log.error(`unlock-card payment error: ${redact((e as Error)?.message ?? String(e), secrets).slice(0, 300)}`);
        return jsonResponse(503, { ok: false, code: "payment_unavailable", hint: "Card payments are unavailable right now; nobody was charged." });
      }
      // Unpaid (or the credential failed verification): the MPP challenge, nothing charged.
      if (result.status !== 200) return await withChallengeHint(result.challenge, link(note.id));

      // Paid: Stripe confirmed the PaymentIntent inside compose(). From here on, deliver the workaround whatever fails.
      paidBody = {
        ok: true,
        note_id: note.id,
        surface: note.surface_display,
        what: note.what,
        workaround: note.workaround,
        label: note.attestation === "verified" ? "VERIFIED" : "UNVERIFIED",
        paid: { amount: CARD_PRICE.display, rail: "Stripe MPP Shared Payment Token (test mode)" },
      };
      let receipt: Receipt.Receipt | null = null;
      try {
        receipt = readReceipt(result.withReceipt(new Response(null)));
      } catch (e) {
        log.error(`unlock-card receipt unreadable after payment: ${redact((e as Error)?.message ?? String(e), secrets).slice(0, 200)}`);
      }
      paidBody.receipt = receipt;
      const { filer, platform } = split(CARD_PRICE.micro, settingsBps(settings));
      const ledger = {
        note_id: note.id,
        amount_micro: CARD_PRICE.micro,
        filer_micro: filer,
        platform_micro: platform,
        tx_hash: receipt?.reference ?? `mpp-receipt-unparsed-${randomUUID()}`,
        network: CARD_NETWORK,
      };
      if (receipt?.reference && seenRefs.has(receipt.reference)) {
        log.error(`!!! unlock-card payment ${receipt.reference} was already recorded: workaround re-delivered, no second ledger row (note=${note.id})`);
      } else {
        try {
          await store.recordUnlock(ledger);
          if (receipt?.reference) markSeen(receipt.reference);
          log.log(`UNLOCK card settled note=${note.id} ref=${ledger.tx_hash} filer=${filer} platform=${platform}`);
        } catch (e) {
          log.error(`!!! LEDGER WRITE FAILED after card payment !!! ${JSON.stringify(ledger)} ${redact((e as Error)?.message ?? String(e)).slice(0, 200)}`);
        }
      }
      try {
        return result.withReceipt(jsonResponse(200, paidBody));
      } catch (e) {
        log.error(`unlock-card could not attach the receipt header: ${redact((e as Error)?.message ?? String(e), secrets).slice(0, 200)}`);
        return jsonResponse(200, paidBody);
      }
    } catch (e) {
      log.error(`unlock-card internal error${paidBody ? " AFTER PAYMENT" : ""}: ${redact((e as Error)?.message ?? String(e), secrets).slice(0, 200)}`);
      if (paidBody) return jsonResponse(200, paidBody);
      return jsonResponse(500, { ok: false, code: "internal_error", hint: "Something went wrong before payment; nobody was charged. Try again in a minute." });
    }
  }

  function link(noteId: string): string {
    return baseUrl ? unlockCardLink(baseUrl, noteId) : unlockCardLink("", noteId);
  }

  function registerTool(server: any, store: Store): void {
    server.tool(
      {
        name: "notes_unlock_card",
        title: "Unlock a workaround by card (Stripe test mode)",
        description:
          `Card alternative to notes_unlock, via Stripe machine payments (MPP, Shared Payment Tokens), test mode: ${CARD_PRICE.display} (Stripe's card minimum). Returns a payment_link: POST to it, answer the 402 MPP challenge with a test-mode Shared Payment Token (e.g. @stripe/link-cli) and retry to receive the workaround. Nobody is charged unless the workaround is returned; the agent who filed it earns a share.`,
        inputSchema: z.object({ note_id: z.string().describe("note_id from notes_query") }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      async (args: { note_id: string }) => {
        const noteId = typeof args?.note_id === "string" ? args.note_id.trim() : null;
        let checked: Checked;
        try {
          checked = await check(store, noteId);
        } catch (e) {
          log.error(`notes_unlock_card internal error: ${redact((e as Error)?.message ?? String(e), secrets).slice(0, 200)}`);
          return toolJson({ ok: false, code: "internal_error", hint: "Could not prepare a card unlock right now; nobody was charged." }, true);
        }
        if (!checked.ok) return toolJson(checked.body, true);
        const paymentLink = link(checked.note.id);
        const pct = settingsBps(checked.settings) / 100;
        return toolJson({
          ok: true,
          note_id: checked.note.id,
          payment_link: paymentLink,
          method: "POST",
          price: CARD_PRICE.display,
          rail: "Stripe MPP (Shared Payment Token), test mode: no real money moves",
          instructions:
            `POST to payment_link${baseUrl ? "" : " (a path on this MCP server's origin)"}. The server answers 402 with an MPP challenge (WWW-Authenticate: Payment). Pay it with a Stripe Shared Payment Token in test mode, e.g. \`npx @stripe/link-cli mpp pay "${paymentLink}" -X POST --context "Unlock an Aze field-note workaround (test mode)"\`, and retry with the credential; the response carries the workaround and a Payment-Receipt. The filer earns ${pct}%.`,
        });
      },
    );
  }

  function registerRoutes(app: any, store: Store, routeBaseUrl?: string): void {
    const fromRoutes = normalizeBaseUrl(routeBaseUrl);
    if (fromRoutes) baseUrl = fromRoutes;
    const route = (c: any) => handle(c.req.raw as Request, store);
    app.get(UNLOCK_CARD_PATH, route);
    app.post(UNLOCK_CARD_PATH, route);
  }

  /** Build one challenge locally (no network) to prove the MPP config; for /admin/diag. */
  async function probeChallenge(): Promise<Record<string, unknown>> {
    const ch = await getMppx().challenge.stripe.charge(chargeOptions("00000000-0000-0000-0000-000000000000"));
    return { method: ch.method, intent: ch.intent, realm: ch.realm, expires: ch.expires, request: ch.request };
  }

  return { handle, registerTool, registerRoutes, probeChallenge, link };
}

function settingsBps(s: Settings): number {
  const bps = s?.filer_bps;
  return Number.isInteger(bps) && bps >= 0 && bps <= 10_000 ? bps : DEFAULT_SETTINGS.filer_bps;
}

export type CardUnlock = ReturnType<typeof createCardUnlock>;
