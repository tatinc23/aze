# Hybrid execution harness (big picture, Ken 2026-10-20)

Status: idea, not built. These are Ken's research notes, summarized. The sources were an AI search answer, and
the claims about specific models and products haven't been verified here yet. Check the current docs before
building on them.

## The model plan
- **Decide needs two models with two jobs** (Ken):
  - a deterministic decision model that gives fast, typed answers with probabilities;
  - a language model that reasons over long context and can write.
- **Both should be SubQ:**
  - **SubQ Snap** for the typed decisions. It's live on our key as `subq-snap-preview`.
  - **A SubQ language model** for the long-context language work: SubQ-Preview (`subq-preview`) first, expected before SubQ 1.1 Small (2026-10-22). Neither is on our key yet; Snap is the only model until further notice.
- **For now: Snap only.**
- **Clef is skipped.** Cloudflare's Clef / Clef-flash / Clef-Omni are decision models, so they would duplicate Snap,
  not add language. Clairic, their extraction model, doesn't fit Aze either.

## The pattern: wrap probabilistic models in a rule-based harness
An agent asks to call a tool. Before the tool runs, the call passes three layers:

1. **Deterministic rules (plain code).**
   - Schema validation (zod or Pydantic), permission checks and exact-match blockers.
   - Never pass a raw shell command or SQL string. Tools take structured arguments only.
   - A call that fails here stops before any model looks at it.
2. **Context-aware safety check (a decision model).**
   - The full state (logs, repo, history) plus the validated call go to Snap as a typed choice, e.g.
     `SAFE_TO_EXECUTE | BLOCKED | NEEDS_HUMAN_APPROVAL`.
   - The code acts on the returned label and its probability, never on prose.
   - A risky call pauses the loop for a human.
3. **Context enrichment.**
   - Before the tool runs, inject current warnings, tips and doc snippets for that tool.

The generative agent never decides whether it is allowed to use a tool, and a prompt injection can't talk its way
past code.

## How Aze already maps onto it
- **Layer 1** is Aze's privacy gate (`src/gate/`): deterministic rules, not a model. The tool input schemas are now
  typed too.
- **Layer 2** is Snap: routing in `agent_run`, and the note audit in `notes_file`.
- **Layer 3** is `notes_query`. The "registry of warnings and tips" is the map of known walls that agents file.
  This is where Aze's data plugs into any harness. That suggests a product shape: Aze as the enrichment layer for
  other people's harnesses.

## Open questions
- Should Aze ship the whole harness, or just be the enrichment and decision service other harnesses call?
- Workers AI (args, distill, note drafts) was removed 2026-10-20. The SubQ language model's intended job (Ken, 2026-10-20) is synthesizing filed notes into bottleneck reports; the SubQ chat client (`src/subq/chat.ts`) is kept unwired for SubQ-Preview. Which other jobs, if any, should it do, and at what cost?
