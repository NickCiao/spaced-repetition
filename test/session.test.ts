import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newId, nowIso } from "../src/db";
import { buildSession } from "../src/session";

async function seedPrompt(sourceId: string, opts: { due: string; stability?: number; lastReview?: string | null; question?: string }) {
  const id = newId();
  const lastReview = opts.lastReview === undefined ? nowIso() : opts.lastReview; // null = never reviewed
  await env.DB.prepare(
    `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
      due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
     VALUES (?, ?, 'qa', ?, 'ans', 0, ?, ?, ?, ?, 5, 0, 0, ?, 0, 2, ?)`
  ).bind(id, sourceId, opts.question ?? "q?", nowIso(), nowIso(), opts.due,
         opts.stability ?? 10, lastReview ? 1 : 0, lastReview).run();
  return id;
}

describe("buildSession", () => {
  const now = new Date();
  const past = (d: number) => new Date(now.getTime() - d * 86400_000).toISOString();
  const future = (d: number) => new Date(now.getTime() + d * 86400_000).toISOString();
  let src: string;

  beforeAll(async () => {
    src = newId();
    await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, 'Sess Src', 'https://x', '{}', ?)")
      .bind(src, nowIso()).run();
  });

  it("serves due cards weakest-first, reports nextDue, respects cap", async () => {
    const weak = await seedPrompt(src, { due: past(20), stability: 1, lastReview: past(30), question: "weak" });
    const strong = await seedPrompt(src, { due: past(1), stability: 200, lastReview: past(2), question: "strong" });
    await seedPrompt(src, { due: future(3), question: "future" });

    const s = await buildSession(env.DB, { ahead: false, sourceId: src, cap: 20 }, now);
    expect(s.cards.length).toBe(2);
    expect(s.cards[0].id).toBe(weak);
    expect(s.cards[1].id).toBe(strong);
    expect(s.nextDue).not.toBeNull();
    expect(s.nextDueCount).toBeGreaterThanOrEqual(1); // the "future" prompt seeded above
    expect(s.cards[0].sourceName).toBe("Sess Src");

    const capped = await buildSession(env.DB, { ahead: false, sourceId: src, cap: 1 }, now);
    expect(capped.cards.length).toBe(1);
    expect(capped.dueRemaining).toBe(1);
  });

  it("ahead mode serves not-yet-due, soonest first", async () => {
    const s = await buildSession(env.DB, { ahead: true, sourceId: src, cap: 20 }, now);
    expect(s.cards.length).toBeGreaterThanOrEqual(1);
    expect(s.cards[0].questionHtml).toContain("future");
    expect(s.ahead).toBe(true);
  });

  it("excludes retired prompts", async () => {
    const r = await seedPrompt(src, { due: past(5), question: "retiredq" });
    await env.DB.prepare("UPDATE prompts SET retired = 1 WHERE id = ?").bind(r).run();
    const s = await buildSession(env.DB, { ahead: false, sourceId: src, cap: 50 }, now);
    expect(s.cards.some(c => c.id === r)).toBe(false);
  });
});
