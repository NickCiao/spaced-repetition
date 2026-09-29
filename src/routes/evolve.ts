/**
 * Prompt evolution: one streamed tutor session per prompt
 * (design: docs/design/2026-09-29-prompt-evolution.md §3, §5, §7).
 *
 * The model loop (src/tutor/loop.ts) only ever creates *proposals*. Every write
 * to `prompts` happens here, behind a user-gated endpoint: accept (new prompt or
 * in-place edit), and fate (retire via the same UPDATE + `events` row as review).
 * D1 is written first; the R2 session log is best-effort and never blocks an accept.
 */
import type { Env } from "../env.d";
import { insertPromptStmt, newId, nowIso, type PromptRow, type TopicRow } from "../db";
import { normalizePromptInput, validatePromptInput } from "../format";
import { newCardFields } from "../scheduler";
import { renderPromptAnswer, renderPromptQuestion, renderSourceLine } from "../markdown";
import { escapeHtml, page, shellFor } from "../html";
import { getTutorConfig } from "../tutor/config";
import { createModel } from "../tutor/provider";
import { sessionStore } from "../tutor/session";
import { lineage } from "../tutor/lineage";
import { runTurn } from "../tutor/loop";
import {
  sessionKey, type Fate, type RunTurnInput, type SessionLog, type TurnEvent, type TutorConfig
} from "../tutor/types";

const ID_RE = /^[a-z0-9]{10}$/;

const notFound = () => Response.json({ error: "unknown prompt" }, { status: 404 });

async function loadPrompt(env: Env, id: string): Promise<PromptRow | null> {
  if (!ID_RE.test(id)) return null;
  return env.DB.prepare("SELECT * FROM prompts WHERE id = ?").bind(id).first<PromptRow>();
}

/** Session id comes from the client; it becomes part of an R2 key, so the charset is strict. */
async function loadSession(env: Env, promptId: string, sessionId: unknown): Promise<SessionLog | null> {
  if (typeof sessionId !== "string" || !ID_RE.test(sessionId)) return null;
  const log = await sessionStore.load(env, promptId, sessionId);
  if (!log || log.promptId !== promptId) return null;
  return log;
}

/** The log is the experiment's dataset, not the source of truth for prompts: a failed save never fails the request. */
async function saveQuietly(env: Env, log: SessionLog): Promise<boolean> {
  try {
    log.updatedAt = nowIso();
    await sessionStore.save(env, log);
    return true;
  } catch (err) {
    console.error("evolve: session log save failed", log.id, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export async function evolvePage(id: string, env: Env): Promise<Response> {
  const p = await loadPrompt(env, id);
  if (!p) return new Response("not found", { status: 404 });
  const shell = await shellFor(env.DB, "browse");
  const topic = await env.DB.prepare("SELECT name FROM topics WHERE id = ?").bind(p.topic_id).first<TopicRow>();
  const config = await getTutorConfig(env.DB);

  const source = p.source ? `<span class="card-meta evo-source">from ${renderSourceLine(p.source)}</span>` : "";
  const context = `
<div class="card elev-sm context-card evo-context">
  <span class="card-kicker">${escapeHtml(topic?.name ?? "")}</span>
  <div class="evo-context-q">${renderPromptQuestion(p.kind, p.question)}</div>
  <div class="session-divider"></div>
  <div class="evo-context-a">${renderPromptAnswer(p.kind, p.question, p.answer)}</div>
  ${source}
</div>`;

  const conversation = config
    ? `<div id="evolve" data-prompt-id="${escapeHtml(p.id)}" data-topic-id="${escapeHtml(p.topic_id)}" data-updated-at="${escapeHtml(p.updated_at)}"></div>`
    : `<div class="card context-card evo-unconfigured">
  <p class="context-text">The tutor isn't configured. Add a provider key in <a href="/settings">Settings → Tutor</a>.</p>
</div>`;

  const body = `
<a class="crumb" href="/prompt/${escapeHtml(p.id)}"><i class="ph ph-arrow-left"></i> Edit prompt</a>
<h1 class="page-title">Evolve</h1>
${context}
${conversation}`;
  return page("Evolve", body, {
    shell,
    bodyClass: "wide",
    script: config ? ["/static/session-card.js", "/static/evolve.js"] : ["/static/session-card.js"]
  });
}

// ---------------------------------------------------------------------------
// Streaming turns (start / turn) — Server-Sent Events, one JSON TurnEvent per `data:` line
// ---------------------------------------------------------------------------

function streamTurn(
  env: Env, log: SessionLog, config: TutorConfig, input: RunTurnInput, announceSession: boolean
): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (e: TurnEvent) => {
        if (!open) return;
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); }
        catch { open = false; } // client went away; keep draining so the log still gets saved
      };
      let finalLog: SessionLog = log;
      try {
        if (announceSession) send({ type: "session", id: log.id });
        const turn = runTurn({ env, model: createModel(config), log, input, now: new Date() });
        // `done` may reject alongside `events` throwing; don't let it surface as unhandled.
        turn.done.catch(() => {});
        for await (const e of turn.events) send(e);
        finalLog = await turn.done;
        // Persist before closing: the client may POST its next turn the moment `done` lands.
        if (!(await saveQuietly(env, finalLog))) {
          send({ type: "error", message: "The session log could not be saved; this session may not continue." });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("evolve: turn failed", log.id, err);
        send({ type: "error", message });
        await saveQuietly(env, finalLog); // keep whatever the loop recorded (turn error included)
      } finally {
        open = false;
        try { controller.close(); } catch { /* already closed */ }
      }
    }
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no"
    }
  });
}

export async function evolveStart(id: string, env: Env): Promise<Response> {
  const p = await loadPrompt(env, id);
  if (!p) return notFound();
  const config = await getTutorConfig(env.DB);
  if (!config) return Response.json({ error: "tutor not configured" }, { status: 503 });
  const log = await sessionStore.create(env, { promptId: p.id, topicId: p.topic_id, config });
  return streamTurn(env, log, config, { start: true }, true);
}

type TurnBody = { session?: unknown; message?: unknown; action?: unknown };

export async function evolveTurn(id: string, request: Request, env: Env): Promise<Response> {
  const b = await request.json<TurnBody>().catch(() => null);
  if (!b || typeof b.session !== "string") return Response.json({ error: "session required" }, { status: 400 });
  let input: RunTurnInput;
  if (b.action === "skip" && b.message === undefined) input = { action: "skip" };
  else if (typeof b.message === "string" && b.message.trim() && b.action === undefined) input = { message: b.message.trim() };
  else return Response.json({ error: "exactly one of message or action:'skip' required" }, { status: 400 });

  const p = await loadPrompt(env, id);
  if (!p) return notFound();
  const config = await getTutorConfig(env.DB);
  if (!config) return Response.json({ error: "tutor not configured" }, { status: 503 });
  const log = await loadSession(env, p.id, b.session);
  if (!log) return Response.json({ error: "unknown session" }, { status: 404 });
  return streamTurn(env, log, config, input, false);
}

// ---------------------------------------------------------------------------
// User-gated writes: accept / discard / fate / worth
// ---------------------------------------------------------------------------

type AcceptBody = { session?: unknown; proposal_id?: unknown; question?: unknown; answer?: unknown };

export async function evolveAccept(id: string, request: Request, env: Env): Promise<Response> {
  const b = await request.json<AcceptBody>().catch(() => null);
  if (!b || typeof b.session !== "string" || typeof b.proposal_id !== "string") {
    return Response.json({ error: "session and proposal_id required" }, { status: 400 });
  }
  const p = await loadPrompt(env, id);
  if (!p) return notFound();
  const log = await loadSession(env, p.id, b.session);
  if (!log) return Response.json({ error: "unknown session" }, { status: 404 });
  const proposal = log.proposals.find(x => x.id === b.proposal_id);
  if (!proposal) return Response.json({ error: "unknown proposal" }, { status: 404 });
  if (proposal.status !== "open") return Response.json({ error: `proposal already ${proposal.status}` }, { status: 409 });

  // The user edits the card before accepting; the body carries what they actually want saved.
  const kind = proposal.kind === "new" ? proposal.promptKind : p.kind;
  const draft = {
    kind,
    question: typeof b.question === "string" ? b.question : proposal.question,
    answer: typeof b.answer === "string" ? b.answer : proposal.answer
  };
  const invalid = validatePromptInput(draft);
  if (invalid) return Response.json({ error: invalid }, { status: 400 });
  const { question, answer } = normalizePromptInput(draft);
  const ts = nowIso();

  if (proposal.kind === "new") {
    // Same placement as refineApi: append to the original's topic, inherit its source line.
    const posRow = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM prompts WHERE topic_id = ?")
      .bind(p.topic_id).first<{ p: number }>();
    const child = newId();
    await insertPromptStmt(env.DB, {
      id: child, topic_id: p.topic_id, kind, question, answer, source: p.source,
      position: posRow?.p ?? 0, created_at: ts, updated_at: ts
    }, newCardFields(new Date())).run();
    await lineage.append(env.DB, {
      child, parent: p.id, move: proposal.move, ts, session: sessionKey(p.id, log.id)
    });
    proposal.status = "accepted";
    proposal.finalQuestion = question;
    proposal.finalAnswer = answer;
    proposal.acceptedPromptId = child;
    await saveQuietly(env, log);
    return Response.json({ ok: true, prompt_id: child });
  }

  // Edit: identity and FSRS history survive; a concurrent edit of the original loses the race (design §7).
  const res = await env.DB.prepare(
    "UPDATE prompts SET question=?, answer=?, updated_at=? WHERE id=? AND updated_at=?"
  ).bind(question, answer, ts, p.id, proposal.basedOnUpdatedAt).run();
  if (!res.meta.changes) return Response.json({ error: "prompt changed, re-open" }, { status: 409 });
  proposal.status = "accepted";
  proposal.finalQuestion = question;
  proposal.finalAnswer = answer;
  await saveQuietly(env, log);
  return Response.json({ ok: true, prompt_id: p.id, updated_at: ts });
}

type DiscardBody = { session?: unknown; proposal_id?: unknown };

export async function evolveDiscard(id: string, request: Request, env: Env): Promise<Response> {
  const b = await request.json<DiscardBody>().catch(() => null);
  if (!b || typeof b.session !== "string" || typeof b.proposal_id !== "string") {
    return Response.json({ error: "session and proposal_id required" }, { status: 400 });
  }
  if (!ID_RE.test(id)) return notFound();
  const log = await loadSession(env, id, b.session);
  if (!log) return Response.json({ error: "unknown session" }, { status: 404 });
  const proposal = log.proposals.find(x => x.id === b.proposal_id);
  if (!proposal) return Response.json({ error: "unknown proposal" }, { status: 404 });
  if (proposal.status !== "open") return Response.json({ error: `proposal already ${proposal.status}` }, { status: 409 });
  proposal.status = "discarded";
  await saveQuietly(env, log);
  return Response.json({ ok: true });
}

type FateBody = { session?: unknown; fate?: unknown };

export async function evolveFate(id: string, request: Request, env: Env): Promise<Response> {
  const b = await request.json<FateBody>().catch(() => null);
  if (!b || typeof b.session !== "string" || (b.fate !== "keep" && b.fate !== "retire")) {
    return Response.json({ error: "session and fate ('keep' | 'retire') required" }, { status: 400 });
  }
  const fate = b.fate as Fate;
  const p = await loadPrompt(env, id);
  if (!p) return notFound();
  const log = await loadSession(env, p.id, b.session);
  if (!log) return Response.json({ error: "unknown session" }, { status: 404 });

  const now = new Date();
  const ts = now.toISOString();
  if (fate === "retire") {
    // Exactly the review path (gradeApi 'retire'): hide from review, log the event, keep FSRS state.
    const elapsed = p.last_review ? (now.getTime() - new Date(p.last_review).getTime()) / 86400_000 : null;
    await env.DB.batch([
      env.DB.prepare("UPDATE prompts SET retired=1, updated_at=? WHERE id=?").bind(ts, p.id),
      env.DB.prepare(
        "INSERT INTO events (ts, prompt_id, action, elapsed_days, state_after) VALUES (?, ?, 'retire', ?, NULL)"
      ).bind(ts, p.id, elapsed)
    ]);
  }
  log.fate.chosen = fate;
  log.fate.chosenAt = ts;
  await saveQuietly(env, log);
  return Response.json({ ok: true, retired: fate === "retire" });
}

type WorthBody = { session?: unknown; worth_it?: unknown };

export async function evolveWorth(id: string, request: Request, env: Env): Promise<Response> {
  const b = await request.json<WorthBody>().catch(() => null);
  if (!b || typeof b.session !== "string" || typeof b.worth_it !== "boolean") {
    return Response.json({ error: "session and worth_it (boolean) required" }, { status: 400 });
  }
  if (!ID_RE.test(id)) return notFound();
  const log = await loadSession(env, id, b.session);
  if (!log) return Response.json({ error: "unknown session" }, { status: 404 });
  log.worthIt = b.worth_it;
  await saveQuietly(env, log);
  return Response.json({ ok: true });
}
