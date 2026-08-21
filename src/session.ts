import type { PromptRow } from "./db";
import { retrievability } from "./scheduler";
import { endOfLocalDay } from "./clock";
import { renderPromptAnswer, renderPromptQuestion } from "./markdown";

export type SessionCard = {
  id: string; kind: "qa" | "cloze"; questionHtml: string; answerHtml: string;
  sourceName: string; sourceUrl: string | null;
};
export type Session = {
  cards: SessionCard[]; dueRemaining: number; nextDue: string | null; nextDueCount: number; ahead: boolean;
};

type Joined = PromptRow & { source_name: string; source_url: string | null };

export async function buildSession(
  db: D1Database,
  opts: { ahead: boolean; sourceId: string | null; cap: number; tz: string },
  now: Date
): Promise<Session> {
  // "Due" means due on today's local calendar day (spec §6), so the cutoff is local midnight.
  const cutoff = endOfLocalDay(now, opts.tz).toISOString();
  const sourceCond = opts.sourceId ? "AND p.source_id = ?" : "";
  const bindings = opts.sourceId ? [cutoff, opts.sourceId] : [cutoff];

  const dueSql = `
    SELECT p.*, s.name AS source_name, s.url AS source_url
    FROM prompts p JOIN sources s ON s.id = p.source_id
    WHERE p.retired = 0 AND p.due < ? ${sourceCond}`;
  const aheadSql = `
    SELECT p.*, s.name AS source_name, s.url AS source_url
    FROM prompts p JOIN sources s ON s.id = p.source_id
    WHERE p.retired = 0 AND p.due >= ? ${sourceCond}
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
    `SELECT MIN(due) AS next_due FROM prompts WHERE retired = 0 AND due >= ?${opts.sourceId ? " AND source_id = ?" : ""}`
  ).bind(...bindings).first<{ next_due: string | null }>();

  let nextDueCount = 0;
  if (next?.next_due) {
    // everything due on the next due day — a local calendar day, like "due" itself
    const dayEnd = endOfLocalDay(new Date(next.next_due), opts.tz).toISOString();
    const countSql = `
      SELECT COUNT(*) AS n FROM prompts
      WHERE retired = 0 AND due >= ?1 AND due < ?2${opts.sourceId ? " AND source_id = ?3" : ""}`;
    const countBindings = opts.sourceId ? [next.next_due, dayEnd, opts.sourceId] : [next.next_due, dayEnd];
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
      sourceName: r.source_name,
      sourceUrl: r.source_url
    }))
  };
}
