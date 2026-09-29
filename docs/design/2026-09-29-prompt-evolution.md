# Prompt evolution — a tutor session for a prompt that has stuck

**Status**: Experiment on branch `feature/prompt-evolution` · 2026-09-29 (rewritten same day; supersedes the first draft)

Extends `2026-08-20-spaced-repetition-design.md` and replaces its §11 *progressive memory prompts* direction. **On this branch only**, two of its rules are relaxed: the tool may generate prompts and act through tools, and the runtime dependency list grows by the Vercel AI SDK. Recorded in `AGENTS.md`; re-decide before any merge.

## 1. What this is

You pick a prompt you already know well. A tutor that has read your deck spends a few minutes with you on it: shows what it noticed, tests whether you can *use* the idea rather than recognize the card, tells you what it found, and drafts a small number of follow-on prompts — each tied to something that happened in the conversation. You edit and accept the ones worth keeping, decide what happens to the original, and leave.

The product of a session is the **insight**, not the cards. If you leave with a sharper sense of what you actually understand and accept zero proposals, the session worked. Cards are the residue that makes the insight durable.

Scope is deliberately one thing: make that session feel worth its minutes. Entry is manual. No triggers, no inbox integration, no lineage UI. Those are easy to add once the session itself has earned them, and worthless if it hasn't.

## 2. Why a tutor, not a checklist

A static list of moves ("ask it from the other direction", "one-sentence compression") can't do the two things that make a teacher valuable at this moment:

- **Test transfer.** Put the idea in a situation the card never mentioned and see whether you can use it. Recognition of the card tells you nothing about this; a probe does.
- **Ground proposals in what just happened.** "You hesitated on when heartbeats fail — so here's an *apply* prompt about exactly that." A proposal that cites your own stumble is one you take seriously; a generic one you nod at and delete (Nielsen's footnote: people discount suggestions they believe come from a model — grounding in *your* data is the counter).

Both require an agent that reads your deck and your history, so the tutor is agentic: it decides what context to pull and drafts through tools. Writes to your prompts stay gated by you.

## 3. The session

`GET /evolve/:id`, reached from an **Evolve** button in the prompt editor footer (`/prompt/:id`). One page, one conversation, streamed. Five beats, each skippable:

**1 · Orientation.** Before asking anything, the tutor shows it has done its reading: the review history in one line ("14 reviews since March 2025, one lapse last November, next due in five months"), what the topic's neighbouring prompts already cover, and what they don't. Then the first real question: *is this still worth carrying?* Retire is a first-class outcome, offered with reasons, before any elaboration.

**2 · Probe.** One to three exchanges, chosen for the kind of prompt: a fact gets *why* / *when does this matter*; a concept gets a *boundary* or *contrast* ("what does this look like when it's almost-but-not X?"); a procedure gets a *failure mode*. Always at least one transfer probe — a concrete situation the card never mentioned. Short answers from you; the tutor does not lecture. **Skip to proposals** is visible throughout.

**3 · Diagnosis.** The tutor says what it noticed, specifically: where your account matched the card, where it drifted, what you reached for that the card doesn't test. This is the "memory coach" beat and the most valuable one; it is delivered even if you skipped the probes (then it is a critique of the card itself — vague cue, canonical answer, yes/no shape).

**4 · Proposals.** Two to four, never more than five. Each is one of:

- a **new prompt** (Q/A or cloze) with a **move** — `reframe` · `deepen` · `compress` · `connect` · `apply` · `second-answer` — and a one-line rationale that points back at the probe or the diagnosis;
- an **edit to the original** — reworded cue, a second answer added, a weasel-word removed. Edits keep the prompt's identity and FSRS history (the design doc's rule: identity survives rewording).

Proposals render as editable cards inside the session. You change the wording (this is where the encoding still happens), then **Accept** or **Discard**. Accept writes immediately: a new prompt lands in the same topic with fresh FSRS state and the parent's source line; an edit updates the original in place. Nothing is written without an Accept. Closing the page discards whatever is still open.

**5 · Fate.** The tutor recommends *keep* or *retire* for the original, with one line of reasoning. One tap either way; retire uses the existing path and event. Then a single private question for the experiment's sake — *worth the minutes?* yes / no — stored in the session log, never shown anywhere.

A typical session: two to four minutes. Latency is part of value: assistant text streams; tool activity shows as a quiet status line ("reading topic…") rather than a spinner.

## 4. The agent

Vercel AI SDK 7 (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `zod`), `streamText` with tools and `stopWhen`, run inside the Worker request. Provider and model from Settings; defaults `claude-opus-5-5` and `gpt-6-astra`.

Read tools (D1, unrestricted):

| Tool | Returns |
|---|---|
| `read_prompt` | Question, answer, kind, topic, source line, prior sessions on this prompt (from the ledger, §6) |
| `read_review_history` | The prompt's events with elapsed days; current stability and interval |
| `read_topic_siblings` | Every other active prompt in the topic — so proposals never duplicate |
| `fetch_source` | Text of the prompt's source URL when it is http(s); truncated |

Write tools (all gated — they create *proposals*, not prompts):

| Tool | Effect |
|---|---|
| `propose_prompt` | A new-prompt card with kind, question, answer, move, rationale |
| `propose_edit` | An edit card showing before/after for the original |
| `recommend_fate` | keep / retire with reasoning; renders the fate control |

The user's Accept on a card is what calls the real write (`insertPromptStmt`, `UPDATE prompts`, `retire`) — from a normal authenticated endpoint, not from the model.

The tutor's brief (system prompt), in short: read before speaking; open with orientation; offer retire honestly; probe transfer, don't quiz; diagnose specifically; prefer specific questions with specific answers, prefer "two different ways" over canonical answers, never yes/no; never duplicate a sibling; every proposal cites something from this conversation or from the card's own weaknesses; stop at five; be brief. The brief lives in `src/tutor/brief.ts` and is expected to change more than any other file on this branch.

## 5. State

No migrations. Everything new lives in existing tables, R2, and code:

- **Session log** — R2 `evolve/<prompt_id>/<session_id>.json`: transcript, tool calls, each proposal with its move and outcome (accepted / edited-then-accepted / discarded), the fate choice, the worth-it answer, provider and model. This is the experiment's dataset. Each turn is `POST /api/evolve/:id/turn` with one user message (or a `skip` / `accept` / `discard` / `fate` action); the server loads the log, runs the loop, appends, persists, streams back.
- **Settings** — `tutor_provider`, `tutor_model`, `anthropic_api_key`, `openai_api_key` in the `settings` table; keys handled like `resend_api_key` (never returned, never exported; UI shows set / not set). Settings page gains a **Tutor** section.
- **Lineage ledger** — one `settings` row, key `lineage`, a JSON array of `{ child, parent, move, ts, session }` appended atomically with `json_insert` on each accepted new prompt. Read only by `read_prompt` so a later session on the same prompt knows what already grew from it. No UI. Promotion path when this graduates: an additive `prompts.parent_id` migration backfilled from the array.

Rollback is `git checkout main && npm run deploy`. Left behind: inert settings rows, R2 objects under `evolve/`, and ordinary prompts that happen to have been written in a session.

## 6. Cut from the first draft, and why

| Cut | Reason |
|---|---|
| Review-time `evolvable` trigger and footer link | Entry point, not value. Manual entry from the editor is enough to iterate on the session |
| `Evolve` in the review overflow | Same |
| Proposals as inbox captures; refine pre-fill; parent control in refine | The best moment to edit a proposal is inside the session, while the concept is in hand. Round-tripping through the inbox added three surfaces and a delay for no gain |
| Two tutor "levels" as separate modes | One flow with **Skip to proposals** covers the comparison |
| Lineage in Browse; `lineage.jsonl` in export | Nothing reads it yet except the tutor |

## 7. Failure modes

| Failure | Behavior |
|---|---|
| Provider down or key invalid | The session page shows the error inline; nothing else in the app depends on the tutor |
| Loop runs long | `stopWhen` caps steps (12); proposals cap at 5; streaming keeps the page alive |
| Accept races a concurrent edit of the original | Edit proposals carry the `updated_at` they were drafted against; stale → rejected with "prompt changed, re-open" |
| Session log write fails | Accepts still succeed (they write D1 first); the log is best-effort and says so |

## 8. Testing

Pure first: proposal card → prompt input normalisation reuses `validatePromptInput` / `normalizePromptInput`; ledger append/read against local D1; the accept endpoint (new prompt, edit, retire) via `exports.default.fetch`. The agent loop runs against the AI SDK mock provider asserting tool sequencing, the proposal cap, and that no write tool ever touches `prompts`. No network in tests. The brief is not unit-tested; it is judged by sessions.

## 9. What decides whether this graduates

After a few weeks of sessions, from the logs:

1. **Worth-it rate** — the yes/no at the end. The primary signal.
2. **Keep rate** — accepted / proposed, and accepted-after-edit vs accepted-as-is.
3. **Moves** — which tags get accepted; which get discarded on sight.
4. **Probe vs skip** — whether sessions that ran the probes accept more, and whether you kept choosing to run them.
5. **Retire rate** — how often the honest answer to "still worth carrying?" was no.

If the worth-it rate is high, the next work is entry points (the review-time trigger from the first draft) and lineage promotion. If it is low, the brief and the probes are what to change — not the surfaces.

## 10. References

- Nielsen, *Building a better memory system* — "pay for real testing"; memory coach; "we need to go deeper"; beware canonical answers.
- Nielsen, *How I use memory systems* — the "should" warning; a stance of improvement toward cards; Anki as a context to think in.
- Nielsen, *Using memory systems to memorize text passages* — mistakes as a source of insight; understanding never saturates.
- Vercel AI SDK 7 — `streamText`, tools, `stopWhen`.
