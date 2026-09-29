/**
 * Shared contract for the prompt-evolution tutor (design:
 * docs/design/2026-09-29-prompt-evolution.md). Three pieces are built against
 * these types: the settings surface (provider/model/keys), the tutor core
 * (agent loop, tools, session log, lineage ledger), and the HTTP routes + page.
 *
 * Branch rule: NO schema migrations. New state lives in `settings` rows, in R2
 * under `evolve/`, or nowhere. The model loop never writes to `prompts`; only the
 * user-gated accept/fate endpoints do.
 */
import type { LanguageModel, ModelMessage } from "ai";
import type { Env } from "../env.d";

// ---------------------------------------------------------------------------
// Settings (rows in the `settings` table; keys are exact)
//   tutor_provider     "anthropic" | "openai"      (default "anthropic")
//   tutor_model        free text; "" = provider default
//   anthropic_api_key  secret — never returned to the client, never exported
//   openai_api_key     secret — never returned to the client, never exported
// ---------------------------------------------------------------------------
export type TutorProvider = "anthropic" | "openai";

export const TUTOR_DEFAULT_MODEL: Record<TutorProvider, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-6-astra"
};

/** Resolved config for one run. `null` from getTutorConfig when the active provider has no key. */
export type TutorConfig = { provider: TutorProvider; model: string; apiKey: string };

// ---------------------------------------------------------------------------
// Proposals — created by the model through tools, acted on by the user.
// ---------------------------------------------------------------------------
export type Move = "reframe" | "deepen" | "compress" | "connect" | "apply" | "second-answer" | "other";
export const MOVES: readonly Move[] = ["reframe", "deepen", "compress", "connect", "apply", "second-answer", "other"];

export type ProposalStatus = "open" | "accepted" | "discarded";

export type NewPromptProposal = {
  id: string;                       // newId()
  kind: "new";
  promptKind: "qa" | "cloze";
  question: string;
  answer: string;                   // "" for cloze
  move: Move;
  rationale: string;                // one line: the gap it closes and what revealed it
  status: ProposalStatus;
  /** Set on accept: what the user actually saved (may differ from question/answer after editing). */
  finalQuestion?: string;
  finalAnswer?: string;
  acceptedPromptId?: string;
};

export type EditProposal = {
  id: string;
  kind: "edit";
  question: string;                 // full proposed replacement text for the original
  answer: string;
  rationale: string;
  /** `prompts.updated_at` of the original when drafted; accept must fail (409) if it changed. */
  basedOnUpdatedAt: string;
  status: ProposalStatus;
  finalQuestion?: string;
  finalAnswer?: string;
};

export type Proposal = NewPromptProposal | EditProposal;

export type Fate = "keep" | "retire";
export type FateRecommendation = { fate: Fate; reasoning: string };

// ---------------------------------------------------------------------------
// Session log — one JSON object in R2 at `evolve/<promptId>/<sessionId>.json`.
// This is the experiment's dataset; keep it complete and append-only in spirit.
// ---------------------------------------------------------------------------
export type SessionLog = {
  id: string;                       // newId()
  promptId: string;
  topicId: string;
  provider: TutorProvider;
  model: string;
  startedAt: string;                // nowIso()
  updatedAt: string;
  /** AI SDK messages exactly as fed to / returned from the model, including tool calls/results. */
  messages: ModelMessage[];
  proposals: Proposal[];
  fate: { recommended: FateRecommendation | null; chosen: Fate | null; chosenAt: string | null };
  /** The private end-of-session question. null = not answered. */
  worthIt: boolean | null;
  /** True once the user pressed "Skip to proposals". */
  skipped: boolean;
  /** Per-turn bookkeeping for the experiment (step counts, tool names, durations). */
  turns: { at: string; userMessage: string | null; steps: number; tools: string[]; ms: number; error?: string }[];
};

export const sessionKey = (promptId: string, sessionId: string): string =>
  `evolve/${promptId}/${sessionId}.json`;

// ---------------------------------------------------------------------------
// Lineage ledger — `settings` row key "lineage", a JSON array of edges.
// Appended atomically: UPDATE settings SET value = json_insert(value, '$[#]', json(?)) WHERE key='lineage'
// (INSERT the row with '[]' on first use). Read only by the tutor's read_prompt tool.
// ---------------------------------------------------------------------------
export type LineageEdge = { child: string; parent: string; move: Move; ts: string; session: string };
export const LINEAGE_KEY = "lineage";

// ---------------------------------------------------------------------------
// Turn streaming — server → client as Server-Sent Events:
//   Content-Type: text/event-stream ; each event is `data: <JSON TurnEvent>\n\n`.
// The client renders text-deltas into the current assistant bubble, status lines
// as a quiet "reading topic…" indicator, proposals as editable cards, fate as the
// keep/retire control. `done` closes the turn; `error` is terminal too.
// ---------------------------------------------------------------------------
export type TurnEvent =
  | { type: "session"; id: string }                       // first event of a new session
  | { type: "text-delta"; text: string }
  | { type: "status"; text: string }                      // e.g. "reading topic…"
  | { type: "proposal"; proposal: Proposal }
  | { type: "fate"; recommendation: FateRecommendation }
  | { type: "done"; log: Pick<SessionLog, "id" | "skipped"> & { proposalCount: number } }
  | { type: "error"; message: string };

/** What the client posts for one turn. Exactly one of message / action. */
export type TurnRequest =
  | { session: string; message: string }
  | { session: string; action: "skip" };

// ---------------------------------------------------------------------------
// Function contracts (implemented in src/tutor/*, consumed by src/routes/evolve.ts)
// ---------------------------------------------------------------------------

/** src/tutor/config.ts — reads the four settings rows. null when the active provider has no key. */
export type GetTutorConfig = (db: D1Database) => Promise<TutorConfig | null>;

/**
 * src/tutor/provider.ts — builds the AI SDK model for a config. Tests replace it with
 * `__setModelOverride(fn)` (a MockLanguageModelV4 from "ai/test"); never import "ai/test"
 * from production code.
 */
export type CreateModel = (config: TutorConfig) => LanguageModel;

/** src/tutor/session.ts — R2-backed session log. */
export type SessionStore = {
  create(env: Env, args: { promptId: string; topicId: string; config: TutorConfig }): Promise<SessionLog>;
  load(env: Env, promptId: string, sessionId: string): Promise<SessionLog | null>;
  save(env: Env, log: SessionLog): Promise<void>;
};

/** src/tutor/lineage.ts */
export type Lineage = {
  append(db: D1Database, edge: LineageEdge): Promise<void>;
  /** Edges where the prompt is parent or child. */
  forPrompt(db: D1Database, promptId: string): Promise<LineageEdge[]>;
};

/**
 * src/tutor/loop.ts — runs one turn. Appends the user message (or the skip marker) to
 * log.messages, streams the model with the tutor tools, yields TurnEvents as they
 * happen, and resolves `done` with the updated log (messages, proposals, fate.recommended,
 * turns) once the stream completes. The caller persists the log and writes the SSE.
 *
 * First turn of a session: `input` is `{ start: true }` — the loop feeds the model a
 * single user message "[session start]" so the tutor opens with orientation.
 */
export type RunTurnInput =
  | { start: true }
  | { message: string }
  | { action: "skip" };

export type RunTurn = (args: {
  env: Env;
  model: LanguageModel;
  log: SessionLog;
  input: RunTurnInput;
  now: Date;
}) => { events: AsyncIterable<TurnEvent>; done: Promise<SessionLog> };

// Limits (design §7)
export const MAX_STEPS = 12;
export const MAX_PROPOSALS = 5;
export const SOURCE_FETCH_MAX_CHARS = 12_000;
