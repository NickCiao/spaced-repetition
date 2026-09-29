import { newId, nowIso } from "../db";
import { sessionKey, type SessionLog, type SessionStore } from "./types";

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
