import type { PromptRow } from "./db";
import { retrievability } from "./scheduler";
import { endOfLocalDay } from "./clock";
import { renderPromptAnswer, renderPromptQuestion, renderSourceLine } from "./markdown";

export async function countDue(db: D1Database, tz: string, now: Date): Promise<number> {
  const cutoff = endOfLocalDay(now, tz).toISOString();
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM prompts WHERE retired = 0 AND due < ?"
  ).bind(cutoff).first<{ n: number }>();
  return row?.n ?? 0;
}

export type SessionCard = {
  id: string; kind: "qa" | "cloze"; questionHtml: string; answerHtml: string;
  topicName: string; sourceHtml: string | null;
};
export type Session = {
  cards: SessionCard[]; dueRemaining: number; nextDue: string | null; nextDueCount: number; ahead: boolean;
};

type Joined = PromptRow & { topic_name: string };

export async function buildSession(
  db: D1Database,
  opts: { ahead: boolean; topicId: string | null; cap: number; tz: string },
  now: Date
): Promise<Session> {
  // "Due" means due on today's local calendar day (spec §6), so the cutoff is local midnight.
  const cutoff = endOfLocalDay(now, opts.tz).toISOString();
  const topicCond = opts.topicId ? "AND p.topic_id = ?" : "";
  const bindings = opts.topicId ? [cutoff, opts.topicId] : [cutoff];

  const dueSql = `
    SELECT p.*, t.name AS topic_name
    FROM prompts p JOIN topics t ON t.id = p.topic_id
    WHERE p.retired = 0 AND p.due < ? ${topicCond}`;
  const aheadSql = `
    SELECT p.*, t.name AS topic_name
    FROM prompts p JOIN topics t ON t.id = p.topic_id
    WHERE p.retired = 0 AND p.due >= ? ${topicCond}
    ORDER BY p.due ASC LIMIT ?`;

  let rows: Joined[];
  let dueRemaining = 0;
  if (opts.ahead) {
    rows = (await db.prepare(aheadSql).bind(...bindings, opts.cap).all<Joined>()).results;
  } else {
    const all = (await db.prepare(dueSql).bind(...bindings).all<Joined>()).results;
    all.sort((a, b) => retrievability(a, now) - retrievability(b, now));
    rows = all.slice(0, opts.cap);
    dueRemaining = Math.max(0, all.length - opts.cap);
  }

  const next = await db.prepare(
    `SELECT MIN(due) AS next_due FROM prompts WHERE retired = 0 AND due >= ?${opts.topicId ? " AND topic_id = ?" : ""}`
  ).bind(...bindings).first<{ next_due: string | null }>();

  let nextDueCount = 0;
  if (next?.next_due) {
    // everything due on the next due day — a local calendar day, like "due" itself
    const dayEnd = endOfLocalDay(new Date(next.next_due), opts.tz).toISOString();
    const countSql = `
      SELECT COUNT(*) AS n FROM prompts
      WHERE retired = 0 AND due >= ?1 AND due < ?2${opts.topicId ? " AND topic_id = ?3" : ""}`;
    const countBindings = opts.topicId ? [next.next_due, dayEnd, opts.topicId] : [next.next_due, dayEnd];
    const count = await db.prepare(countSql).bind(...countBindings).first<{ n: number }>();
    nextDueCount = count?.n ?? 0;
  }

  return {
    ahead: opts.ahead,
    dueRemaining,
    nextDue: next?.next_due ?? null,
    nextDueCount,
    cards: rows.map(r => ({
      id: r.id,
      kind: r.kind,
      questionHtml: renderPromptQuestion(r.kind, r.question),
      answerHtml: renderPromptAnswer(r.kind, r.question, r.answer),
      topicName: r.topic_name,
      sourceHtml: r.source ? renderSourceLine(r.source) : null
    }))
  };
}
