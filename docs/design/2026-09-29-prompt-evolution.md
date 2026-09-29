# Prompt evolution — an AI tutor for prompts that have stuck

**Status**: Experiment on branch `feature/prompt-evolution` · 2026-09-29

Extends `2026-08-20-spaced-repetition-design.md`. Replaces its §11 *progressive memory prompts* direction (pre-authored stages) with a just-in-time model, and — **on this branch only** — relaxes two of its rules: the tool may generate and act, not just scaffold; and the runtime dependency list grows by the Vercel AI SDK. Both relaxations are recorded in `AGENTS.md` under the branch note and must be re-decided before any merge to `main`.

## 1. Problem

Once a prompt has stabilized (FSRS intervals of months), review offers only keep or retire. A kept prompt fossilizes: the cue is the exact wording, so success comes to mean *recognizing the card*, not *having the idea available in thought*. Nielsen names this directly — Anki's "cues don't correspond to actual situations of use" — and his memorization notes add the mirror case: a lapse on a mature card "was usually not a failure of memory so much as a failure to understand."

A teacher, at the moment a concept has clearly stuck, does one of a few things: re-frames it from another angle, deepens into adjacent material, asks for a compression, connects it to something else, or asks for an application. Only the first modifies the existing prompt; the rest author *new* prompts with the old one as source material.

The design doc's §11 imagined pre-authored stages written at refine time. That is the moment the author understands the material *least*. This design evolves prompts **after** they stick, when understanding is greatest and adjacent reading has accumulated.

## 2. What stays true

- **Curation stays human.** The tutor proposes — as captures — and nothing enters review until refined. Deleting a proposal at refine is legitimate triage and is the experiment's primary signal.
- **Retire is a first-class outcome.** The tutor's first question is whether the idea is still worth carrying. Elaborating things one feels one *should* care about is the failure mode Nielsen warns about most.
- **No metrics.** No mastery levels. The only new number shown is one already permitted — when the next review lands.
- **Bounded.** Evolve is pull (manual from Browse or the review overflow) plus one quiet affordance in review. Nothing accumulates unattended; no inbox item is created without an explicit action.
- **Binary grades, deterministic FSRS, event-log replay** — untouched. Evolution never edits FSRS state; a re-framed prompt is a new card with fresh state and a lineage edge, and the parent is kept or retired through the existing `retire` path.

## 3. The moment

Two triggers, computed in `POST /api/grade` from the prompt's pre- and post-grade FSRS fields and returned as `evolvable: true` (nothing stored):

| Grade | Condition | Reading |
|---|---|---|
| Remembered | `scheduled_days` after grading ≥ 90 | It has stuck; you won't see it for a season |
| Forgot | `stability` before grading ≥ 90 days | A mature card lapsed; the cue was shallow |

When `evolvable`, the post-grade footer shows the existing "Next: {weekday}" line with a quiet `Evolve` link beside it. `Evolve` is also always available from the review overflow (Skip · Flag · Retire · **Evolve**) and from the prompt editor footer, so iteration on the tutor does not wait for cards to mature.

## 4. The tutor

An agent loop over the Vercel AI SDK (`ai@^7`, `@ai-sdk/anthropic@^4`, `@ai-sdk/openai@^4`, `zod`), run inside the Worker request, provider chosen in Settings. Default models: `claude-opus-5-5` (Anthropic), `gpt-6-astra` (OpenAI; `gpt-6-sol` if the key lacks access). Model ids are settings, not code.

Two levels, both available from the same page so they can be compared:

- **Probe → propose** (default). The tutor first tests transfer — explain it in your own words; apply it to a situation the card never mentioned; what does it contrast with — then proposes prompts aimed at where you stumbled.
- **Propose directly** ("skip the questions"). Drafts candidates from the card and its context without a dialogue.

Tools the tutor can call (all read from D1 or write captures; none touch prompts or FSRS state):

| Tool | Does |
|---|---|
| `read_prompt` | The prompt, its topic, source line, and lineage (ancestors, children) |
| `read_topic_siblings` | Other prompts in the topic, so it knows what is already covered |
| `read_review_history` | The prompt's events — lapses, elapsed days, current interval |
| `fetch_source` | The prompt's source URL, if any and if http(s), text-only |
| `propose_prompt` | Writes a capture (see §5) tagged with a move; returns its id |
| `recommend_parent_fate` | keep / retire / replace, with one line of reasoning, shown to the user for the refine step |

Every proposal carries a **move**: `reframe` · `deepen` · `compress` · `connect` · `apply` · `second-answer`. The tag is what makes the kept-vs-deleted data say which moves earn their place.

System prompt commitments (the tutor's brief): prefer specific questions with specific answers; avoid yes/no; prefer "two different ways…" over canonical answers; never propose a prompt about something the siblings already cover; cap proposals per session (default 5); ask whether the idea is still worth carrying before anything else; treat the user's stumbles as the primary source of proposals.

Transcripts persist to R2 at `evolve/<prompt_id>/<session_id>.json` (messages, tool calls, proposals, fate recommendation). Not indexed in `assets`; not exported in v1.

## 5. Proposals are captures

`propose_prompt` inserts into `captures`:

- `text` — the proposal in interchange form: a `Q:`/`A:` block or a `C:` cloze block, parsed at refine with the existing `format.ts` block parser
- `note` — `evolve:<move>:<parent_id>:<session_id>` (machine prefix; refine renders it as a lineage card, not as a note)
- `topic` — the parent's topic name
- `url`, `title`, `image_id` — null

Refine, on this branch, recognises the `evolve:` prefix: the context card shows the **parent prompt** (question, answer, source) instead of raw capture text; kind/question/answer are pre-filled from the block; the source input is pre-filled from the parent's `source` (same reading, same provenance); a **Parent** control offers *keep* (default) / *retire* with the tutor's recommendation shown beside it. On save, one lineage edge is appended per created prompt (§6) and, if chosen, the parent is retired through the existing retire path (existing `retire` event). On `main`, the same rows are ordinary captures — refinable, deletable, harmless.

## 6. Lineage ledger (zero-schema)

A `settings` row, key `lineage`, holding a JSON array of edges:

```json
{ "child": "k3j9…", "parent": "a7f2…", "move": "reframe", "ts": "2026-10-03T14:02:11Z", "session": "evolve/a7f2…/s01…" }
```

Appended atomically with `UPDATE settings SET value = json_insert(value, '$[#]', json(?)) WHERE key = 'lineage'` (row created on first use). `getSettings()` ignores the key; `exportableSettings()` excludes it. Export writes it as **`lineage.jsonl`** (one edge per line) so backups carry it and offline agents can read it; `import` on this branch restores it when present and `main`'s importer ignores the file. `read_prompt` and Browse read ancestors/children from it.

This is deliberately temporary. Promotion path when the experiment graduates: one additive migration adding `prompts.parent_id` (nullable) and `prompts.move`, backfilled from the array; `<!-- id: …; parent: … -->` in the interchange format.

## 7. Settings

New keys, all in the existing `settings` table: `tutor_provider` (`anthropic` | `openai`), `tutor_model` (free text, provider default when blank), `anthropic_api_key`, `openai_api_key`. Keys are stored like `resend_api_key` — never returned to the client, never exported; the UI shows only *set / not set*. Settings page gains a **Tutor** section.

## 8. Surfaces

- **Review** — `evolvable` footer link; `Evolve` in the overflow.
- **Evolve page** `GET /evolve/:id` — the prompt at top; a conversation with the tutor; proposals render as cards as they are written (each already in the Inbox); the fate recommendation at the end; *Skip the questions* switches to direct proposals. `POST /api/evolve/:id/turn` carries one user message; the server loads the transcript from R2, runs the loop, persists, returns the new assistant turn and any proposals.
- **Inbox** — evolve captures show as "Evolve · reframe of: {parent question}" rows.
- **Refine** — §5.
- **Browse / prompt editor** — a *Lineage* block listing parent and children with their moves; `Evolve` in the footer.

## 9. Deployability and rollback

No migrations on this branch. Everything new lives in `settings` rows, `captures` rows, R2 objects under `evolve/`, and code. `npm run deploy` from the branch replaces the production Worker; `git checkout main && npm run deploy` rolls back, leaving behind only inert settings rows, ordinary captures, and unreferenced R2 objects. `events.action` has a `CHECK` constraint, so no new event action is introduced — adding one would require a table rebuild.

## 10. Failure modes

| Failure | Behavior |
|---|---|
| Provider down / key invalid | Evolve page shows the error; review is never blocked on the tutor |
| Tool loop runs long | `stopWhen` caps steps (default 12); proposals cap at 5 per session |
| Proposal fails to parse at refine | Falls back to raw text in the question field; the capture is never lost |
| `lineage` JSON corrupted | Appends fail loudly; Browse shows "lineage unavailable"; prompts and review unaffected |
| Deploy of `main` over this branch | See §9 — nothing to undo |

## 11. Testing

Pure logic first: trigger rule (`evolvable` from before/after fields), `evolve:` note parse/render, lineage append and read (against local D1 via the vitest pool), proposal block → refine pre-fill. The tutor loop is tested with a fake model (AI SDK's mock provider) asserting tool sequencing and the proposal cap; no network in tests.

## 12. What the experiment must answer

1. **Keep rate** — of proposals, how many survive refine and a week of honest review.
2. **Probe vs. propose** — does the dialogue produce better-kept prompts, and is it worth the minutes.
3. **Context** — card only / siblings / source text / lapse history: which changes the proposals.
4. **Moves** — which tags survive; which the tutor should stop offering.
5. **Rate** — evolutions per week before it feels like a treadmill.
6. **Parent fate** — whether replacing feels right or both should stay live.

## 13. References

- Nielsen, *Building a better memory system* — "we need to go deeper"; "pay for real testing"; memory coach; beware canonical answers; compress understanding.
- Nielsen, *How I use memory systems* — the "should" warning; card-culling; a stance of improvement toward cards.
- Nielsen, *Using memory systems to memorize text passages* — mistakes as a source of insight; understanding never saturates.
- Vercel AI SDK 7 — `generateText`, `tools`, `stopWhen`.
