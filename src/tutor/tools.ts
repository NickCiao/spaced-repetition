import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Env } from "../env.d";
import { newId, type EventRow, type PromptRow } from "../db";
import { normalizePromptInput, validatePromptInput } from "../format";
import { lineage } from "./lineage";
import {
  MAX_PROPOSALS, MOVES, SOURCE_FETCH_MAX_CHARS, sessionKey,
  type EditProposal, type Move, type NewPromptProposal, type Proposal, type SessionLog, type TurnEvent
} from "./types";

/** Everything a tool needs for one turn. Built by runTurn; tests build it by hand. */
export type ToolContext = {
  env: Env;
  promptId: string;
  log: SessionLog;
  /** Proposals created during this turn; runTurn moves them onto log.proposals when the stream ends. */
  proposalsThisTurn: Proposal[];
  emit: (e: TurnEvent) => void;
  now: Date;
  /** Used by fetch_source; defaults to the global fetch. Tests inject a stub so no network is touched. */
  fetchImpl?: typeof fetch;
};

type PromptWithTopic = PromptRow & { topic_name: string };

const SOURCE_FETCH_TIMEOUT_MS = 6_000;
const URL_RE = /https?:\/\/[^\s)\]>"'`]+/;

async function loadPrompt(db: D1Database, id: string): Promise<PromptWithTopic | null> {
  return db.prepare(
    "SELECT p.*, t.name AS topic_name FROM prompts p JOIN topics t ON t.id = p.topic_id WHERE p.id = ?"
  ).bind(id).first<PromptWithTopic>();
}

/** Number of session logs already stored for this prompt, not counting the running one. */
async function priorSessionCount(env: Env, promptId: string, sessionId: string): Promise<number> {
  const prefix = `evolve/${promptId}/`;
  const self = sessionKey(promptId, sessionId);
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, cursor });
    for (const obj of page.objects) if (obj.key !== self) count++;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return count;
}

const day = (iso: string | null | undefined): string => (iso ?? "").slice(0, 10);

/** One line the tutor can quote: reviews, lapses, stability, next due. */
export function reviewSummary(
  p: Pick<PromptRow, "stability" | "scheduled_days" | "due" | "reps" | "lapses">,
  events: Pick<EventRow, "ts" | "action">[]
): string {
  const graded = events.filter(e => e.action === "remembered" || e.action === "forgot");
  const forgot = events.filter(e => e.action === "forgot").map(e => day(e.ts));
  const parts: string[] = [];
  if (graded.length === 0) {
    parts.push("no reviews yet");
  } else {
    parts.push(`${graded.length} review${graded.length === 1 ? "" : "s"} since ${day(graded[0].ts)}`);
    const lapses = Math.max(p.lapses, forgot.length);
    if (lapses === 0) parts.push("no lapses");
    else parts.push(`${lapses} lapse${lapses === 1 ? "" : "s"}${forgot.length ? ` (${forgot.join(", ")})` : ""}`);
    parts.push(`stability ${Math.round(p.stability)}d`);
    if (p.scheduled_days > 0) parts.push(`interval ${Math.round(p.scheduled_days)}d`);
  }
  parts.push(`next due ${day(p.due)}`);
  return parts.join(", ");
}

/** Crude HTML → text: drop scripts/styles/comments/tags, decode a few entities, collapse whitespace. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(p|div|br|li|h[1-6]|tr|section|article|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function countProposals(ctx: ToolContext): number {
  const live = (p: Proposal) => p.status !== "discarded";
  return ctx.log.proposals.filter(live).length + ctx.proposalsThisTurn.filter(live).length;
}

export function makeTools(ctx: ToolContext): ToolSet {
  const { env, promptId, log } = ctx;
  const db = env.DB;

  return {
    read_prompt: tool({
      description:
        "The prompt this session is about: question, answer, kind, topic, source line, whether it is retired, " +
        "what earlier sessions grew from it (lineage), and how many earlier sessions there were.",
      inputSchema: z.object({}),
      execute: async () => {
        ctx.emit({ type: "status", text: "reading the prompt…" });
        const p = await loadPrompt(db, promptId);
        if (!p) return { error: "prompt not found" };
        const [edges, prior] = await Promise.all([
          lineage.forPrompt(db, promptId),
          priorSessionCount(env, promptId, log.id)
        ]);
        return {
          id: p.id,
          kind: p.kind,
          question: p.question,
          answer: p.answer,
          topic: { id: p.topic_id, name: p.topic_name },
          source: p.source,
          retired: p.retired === 1,
          lineage: edges,
          priorSessionCount: prior
        };
      }
    }),

    read_review_history: tool({
      description:
        "The prompt's review events (timestamp, action, days elapsed since the previous review), oldest first, " +
        "plus a one-line summary of reviews, lapses, current stability and next due date.",
      inputSchema: z.object({}),
      execute: async () => {
        ctx.emit({ type: "status", text: "reading review history…" });
        const p = await loadPrompt(db, promptId);
        if (!p) return { error: "prompt not found" };
        const recent = await db.prepare(
          "SELECT ts, action, elapsed_days FROM events WHERE prompt_id = ? ORDER BY ts DESC LIMIT 60"
        ).bind(promptId).all<Pick<EventRow, "ts" | "action" | "elapsed_days">>();
        const events = recent.results.slice().reverse();
        return {
          summary: reviewSummary(p, events),
          state: {
            stability: p.stability,
            scheduled_days: p.scheduled_days,
            due: p.due,
            reps: p.reps,
            lapses: p.lapses,
            last_review: p.last_review
          },
          events: events.map(e => ({
            ts: e.ts,
            action: e.action,
            elapsed_days: e.elapsed_days == null ? null : Math.round(e.elapsed_days * 10) / 10
          }))
        };
      }
    }),

    read_topic_siblings: tool({
      description:
        "Every other active prompt in the same topic (id, kind, question, answer), in deck order. " +
        "Read this before proposing anything so nothing duplicates a neighbour.",
      inputSchema: z.object({}),
      execute: async () => {
        ctx.emit({ type: "status", text: "reading the topic…" });
        const p = await loadPrompt(db, promptId);
        if (!p) return { error: "prompt not found" };
        const rows = await db.prepare(
          `SELECT id, kind, question, answer FROM prompts
           WHERE topic_id = ? AND id != ? AND retired = 0 ORDER BY position, created_at LIMIT 80`
        ).bind(p.topic_id, promptId).all<Pick<PromptRow, "id" | "kind" | "question" | "answer">>();
        return rows.results;
      }
    }),

    fetch_source: tool({
      description:
        "Fetch the text of the prompt's source when its source line contains an http(s) URL. " +
        "Returns { url, text } (text truncated) or { url: null, text: null, reason }.",
      inputSchema: z.object({}),
      execute: async () => {
        ctx.emit({ type: "status", text: "reading the source…" });
        try {
          const p = await loadPrompt(db, promptId);
          if (!p) return { url: null, text: null, reason: "prompt not found" };
          const m = p.source ? URL_RE.exec(p.source) : null;
          if (!m) return { url: null, text: null, reason: "source has no http(s) URL" };
          const url = m[0].replace(/[.,;:!?]+$/, "");
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
          try {
            const doFetch = ctx.fetchImpl ?? fetch;
            const res = await doFetch(url, {
              signal: controller.signal,
              headers: { Accept: "text/html, text/plain;q=0.9, text/*;q=0.8" },
              redirect: "follow"
            });
            if (!res.ok) return { url, text: null, reason: `fetch failed: HTTP ${res.status}` };
            const type = (res.headers.get("content-type") ?? "").toLowerCase();
            if (!type.startsWith("text/")) return { url, text: null, reason: `unsupported content-type: ${type || "unknown"}` };
            const raw = await res.text();
            const text = type.startsWith("text/html") ? htmlToText(raw) : raw.replace(/[ \t]+/g, " ").trim();
            const truncated = text.length > SOURCE_FETCH_MAX_CHARS;
            return { url, text: truncated ? text.slice(0, SOURCE_FETCH_MAX_CHARS) : text, truncated };
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          const msg = err instanceof Error ? (err.name === "AbortError" ? "timed out" : err.message) : String(err);
          return { url: null, text: null, reason: `fetch failed: ${msg}` };
        }
      }
    }),

    propose_prompt: tool({
      description:
        "Draft a new prompt as an editable card for the user. It is NOT saved until the user accepts it. " +
        "Name in `rationale` the gap it closes and what in this session revealed it. " +
        "Cloze questions must contain at least one {{span}} and leave `answer` empty.",
      inputSchema: z.object({
        promptKind: z.enum(["qa", "cloze"]).describe("qa = question with answer; cloze = text with {{hidden spans}}"),
        question: z.string().describe("Markdown. The cue, or the cloze text."),
        answer: z.string().default("").describe("Markdown. Empty for cloze."),
        move: z.enum(MOVES as unknown as [Move, ...Move[]]).describe("Bookkeeping tag for the kind of move this is."),
        rationale: z.string().describe("One line: the gap this closes and what revealed it.")
      }),
      execute: async ({ promptKind, question, answer, move, rationale }) => {
        const error = validatePromptInput({ kind: promptKind, question, answer });
        if (error) return { ok: false as const, error };
        if (countProposals(ctx) >= MAX_PROPOSALS) return { ok: false as const, error: "proposal cap reached" };
        const norm = normalizePromptInput({ kind: promptKind, question, answer });
        const proposal: NewPromptProposal = {
          id: newId(),
          kind: "new",
          promptKind,
          question: norm.question,
          answer: norm.answer,
          move,
          rationale: rationale.trim(),
          status: "open"
        };
        ctx.proposalsThisTurn.push(proposal);
        ctx.emit({ type: "proposal", proposal });
        return { ok: true as const, id: proposal.id };
      }
    }),

    propose_edit: tool({
      description:
        "Propose a rewrite of the original prompt (full replacement question and answer; the kind stays the same). " +
        "Shown to the user as a before/after card; nothing changes until they accept. " +
        "Use for a vague cue, a canonical answer that wants a second one, a weasel word, a yes/no shape.",
      inputSchema: z.object({
        question: z.string().describe("Full replacement question (or cloze text)."),
        answer: z.string().default("").describe("Full replacement answer. Empty for cloze."),
        rationale: z.string().describe("One line: what was wrong and what revealed it.")
      }),
      execute: async ({ question, answer, rationale }) => {
        const p = await loadPrompt(db, promptId);
        if (!p) return { ok: false as const, error: "prompt not found" };
        const error = validatePromptInput({ kind: p.kind, question, answer });
        if (error) return { ok: false as const, error };
        if (countProposals(ctx) >= MAX_PROPOSALS) return { ok: false as const, error: "proposal cap reached" };
        const norm = normalizePromptInput({ kind: p.kind, question, answer });
        const proposal: EditProposal = {
          id: newId(),
          kind: "edit",
          question: norm.question,
          answer: norm.answer,
          rationale: rationale.trim(),
          basedOnUpdatedAt: p.updated_at,
          status: "open"
        };
        ctx.proposalsThisTurn.push(proposal);
        ctx.emit({ type: "proposal", proposal });
        return { ok: true as const, id: proposal.id };
      }
    }),

    recommend_fate: tool({
      description:
        "Recommend what happens to the original prompt: keep or retire, with one line of reasoning. " +
        "Call once, near the end of the session. The user decides; this only renders the control.",
      inputSchema: z.object({
        fate: z.enum(["keep", "retire"]),
        reasoning: z.string().describe("One line.")
      }),
      execute: async ({ fate, reasoning }) => {
        const recommendation = { fate, reasoning: reasoning.trim() };
        log.fate.recommended = recommendation;
        ctx.emit({ type: "fate", recommendation });
        return { ok: true as const };
      }
    })
  };
}
