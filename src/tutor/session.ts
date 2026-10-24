import { newId, nowIso } from "../db";
import { sessionKey, type SessionLog, type SessionStore } from "./types";

/** How long the log's lists were when a turn started; the turn's additions come after. */
export type TurnMark = { messages: number; proposals: number; turns: number };

export const turnMark = (log: SessionLog): TurnMark =>
  ({ messages: log.messages.length, proposals: log.proposals.length, turns: log.turns.length });

/**
 * Replay one turn's additions onto the latest stored log. A turn holds its own copy for
 * the whole stream while accept / discard / fate / worth save theirs, so saving that copy
 * as-is would erase their changes. A turn only appends (messages, proposals, turns) and
 * sets `skipped` and `fate.recommended`; the user-gated endpoints only settle a proposal,
 * `fate.chosen` and `worthIt`. The two never write the same field.
 */
export function mergeTurn(latest: SessionLog, mark: TurnMark, turn: SessionLog): void {
  latest.messages.push(...turn.messages.slice(mark.messages));
  latest.proposals.push(...turn.proposals.slice(mark.proposals));
  latest.turns.push(...turn.turns.slice(mark.turns));
  if (turn.skipped) latest.skipped = true;
  if (turn.fate.recommended) latest.fate.recommended = turn.fate.recommended;
}

const ID_RE = /^[a-z0-9]{10}$/;

function assertId(id: string, what: string): void {
  if (!ID_RE.test(id)) throw new Error(`bad ${what} id`);
}

/**
 * R2-backed session log: one JSON object per session at `evolve/<promptId>/<sessionId>.json`.
 * The log is the experiment's dataset (design §5); nothing else reads it yet.
 */
export const sessionStore: SessionStore = {
  async create(env, { promptId, topicId, config }) {
    assertId(promptId, "prompt");
    const ts = nowIso();
    const log: SessionLog = {
      id: newId(),
      promptId,
      topicId,
      provider: config.provider,
      model: config.model,
      startedAt: ts,
      updatedAt: ts,
      messages: [],
      proposals: [],
      fate: { recommended: null, chosen: null, chosenAt: null },
      worthIt: null,
      skipped: false,
      turns: []
    };
    await env.BUCKET.put(sessionKey(promptId, log.id), JSON.stringify(log), {
      httpMetadata: { contentType: "application/json" }
    });
    return log;
  },

  async load(env, promptId, sessionId) {
    if (!ID_RE.test(promptId) || !ID_RE.test(sessionId)) return null;
    const obj = await env.BUCKET.get(sessionKey(promptId, sessionId));
    if (!obj) return null;
    return await obj.json<SessionLog>();
  },

  async save(env, log) {
    assertId(log.promptId, "prompt");
    assertId(log.id, "session");
    log.updatedAt = nowIso();
    await env.BUCKET.put(sessionKey(log.promptId, log.id), JSON.stringify(log), {
      httpMetadata: { contentType: "application/json" }
    });
  }
};
