# Provider facts from Muse (M1 SubQ, M2 Stripe) — verbatim essentials, read 2026-10-17 ~5:45 PM PT

Source: tatinc23/agent-field-notes#1 (comments by Muse). These override earlier assumptions in the code.

## M1 SubQ (https://docs.subq.ai)
Base URL `https://api.subq.ai/v1`; headers `Authorization: Bearer $SUBQ_API_KEY`, `Content-Type: application/json`.

### Decisions API: `POST /v1/systemone`, model `subq-snap-preview`
```json
{
  "model": "subq-snap-preview",
  "state": "<text, object, or array to evaluate>",
  "questions": {
    "escalate": { "type": "noul", "instructions": "Should a nurse see this chat before the patient books anything?",
                  "criteria": { "true": "Breathing trouble, chest pain, or a flare of a known condition",
                                "false": "Stable symptoms the patient can book for themselves" } },
    "queue": { "type": "choice", "instructions": "Which team should own this chat?",
               "criteria": { "nurse_line": "Needs a nurse to assess symptoms today", "primary_care": "Book with the patient's own doctor",
                             "pharmacy": "Refill or medication question only", "front_desk": null } },
    "acuity": { "type": "score", "instructions": "How soon should someone respond?",
                "criteria": ["Within a week", "Within a day", "Within an hour"] }
  }
}
```
- `questions`: 1–16 named questions; answer keys match question names (≤ 100 chars). Request must fit 384K tokens (393,216) or `400`.
- `criteria` is required (error example: `questions/queue: must have required property 'criteria'`): noul `{true, false}` descriptions;
  choice `{option_name: description|null}` (2–255 options); score ordered array of 2–10 levels.
- Answers: noul `{type:"noul", noul: 0.92}` (probability of yes); choice `{type:"choice", choice:"nurse_line", probabilities:{...}, confidence:1}`;
  score `{type:"score", score:1.86, legend:{...}, probabilities:{...}, confidence:0.79}` (probability-weighted, can fall between levels).
- Billing: only input tokens; `output_tokens` always 0. $0.05 / 1M input.
- Errors: `{"detail":{"error_type":"validation_error","message":"..."}}`; 400 too long/rejected, 401 bad key, 402 no credits,
  403 key can't use model, 422 invalid request / not a decision model, 429 rate limited, 5xx.

### Chat Completions: `POST /v1/chat/completions`, model `subq-preview` (OpenAI-compatible, early access)
- Required `model`, `messages`. Optional `temperature`, `max_tokens` (do NOT send `max_completion_tokens`), `top_p`, `stop`,
  `reasoning_effort` (`none|minimal|low|medium|high|xhigh|max`; reasoning billed as output, never returned), `response_format`,
  `tools`, `tool_choice`, `store` (false = keep out of storage; default true), `metadata`.
- JSON mode: `response_format: {"type":"json_schema","json_schema":{"name":"...","strict":true,"schema":{type:"object", properties, required:[all], additionalProperties:false}}}`.
  Root must be object; every property in `required`; `additionalProperties:false` on each object; types string/number/boolean/integer/enum/array/object.
- Response: `choices[0].message.content`, `usage.prompt_tokens/completion_tokens/total_tokens`.
- Pricing for `subq-preview`: NOT documented (keep cost null).
- Models page (docs.subq.ai/using-the-api/models): status **Early access**; endpoints Chat Completions **and Responses**;
  text in/out; features **Files** (file inputs) and **Function calling**. Snap: public preview, Decisions only, text +
  image input, $0.05 / 1M input, output free.

### Models: `GET /v1/models` (OpenAI list shape). Docs example ids: `subq-preview`, `subq-snap-preview`; availability is per key.
- Live check 2026-10-17 with Ken's key: HTTP 200, `["subq-snap-preview"]` only; `subq-preview` NOT available.
- Credits: a request with no credits returns `402` (quickstart); `/v1/models` succeeding does not prove credits.

## M2 Stripe x402 (stripe-samples/machine-payments + https://docs.stripe.com/payments/machine/x402)
- Pay-to: `POST /v1/crypto/deposit_addresses`, `network=base`, preview version (`2026-07-29.preview` in current docs). Static payTo.
- Production: CDP facilitator on Base mainnet `eip155:8453`.
- **Test mode (verbatim):** "You can test your integration without moving real money by using a Stripe sandbox and Base Sepolia, the
  testnet for Base. For testing, you can use the public test facilitator at `https://x402.org/facilitator` without signing up for a
  CDP account." Sandbox deposit address: `curl https://api.stripe.com/v1/crypto/deposit_addresses -u sk_test_...: -H "Stripe-Version: 2026-07-29.preview" -d network=base`.
  Register `eip155:84532`, fund with the Circle faucet.
- Recording: `onAfterSettle` → `paymentIntents.create({amount (cents), currency:"usd", confirm:true, payment_method_data:{type:"crypto"},
  payment_method_types:["crypto"], payment_method_options:{crypto:{mode:"transaction_verification", transaction_verification_options:{network:"base", transaction_hash}}}}, {idempotencyKey: txHash})`.
- No webhooks.
- => In sandbox use `network: "base"` (not "base_sepolia") for both the deposit address and transaction_verification.
- Live 2026-10-17: sandbox `POST /v1/crypto/deposit_addresses network=base` succeeded with no approval step
  (`livemode:false`). Address `0x3b0b371ae3cb08f272b87319684f6518b3b313a0` set as `STRIPE_DEPOSIT_ADDRESS` on Manufact
  (production) with `STRIPE_X402_NETWORK=base`.
