import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { newId, nowIso } from "../src/db";
import { buildSession } from "../src/session";
import { endOfLocalDay } from "../src/clock";

async function seedPrompt(topicId: string, opts: { due: string; stability?: number; lastReview?: string | null; question?: string; source?: string | null }) {
  const id = newId();
  const lastReview = opts.lastReview === undefined ? nowIso() : opts.lastReview; // null = never reviewed
  await env.DB.prepare(
    `INSERT INTO prompts (id, topic_id, kind, question, answer, source, position, created_at, updated_at,
      due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
     VALUES (?, ?, 'qa', ?, 'ans', ?, 0, ?, ?, ?, ?, 5, 0, 0, ?, 0, 2, ?)`
  ).bind(id, topicId, opts.question ?? "q?", opts.source ?? null, nowIso(), nowIso(), opts.due,
         opts.stability ?? 10, lastReview ? 1 : 0, lastReview).run();
  return id;
}

describe("buildSession", () => {
  const now = new Date();
  const past = (d: number) => new Date(now.getTime() - d * 86400_000).toISOString();
  const future = (d: number) => new Date(now.getTime() + d * 86400_000).toISOString();
  let topic: string;

  beforeAll(async () => {
    topic = newId();
    await env.DB.prepare("INSERT INTO topics (id, name, url, meta, created_at) VALUES (?, 'Sess Topic', 'https://x', '{}', ?)")
      .bind(topic, nowIso()).run();
  });

  it("serves due cards weakest-first, reports nextDue, respects cap", async () => {
    const weak = await seedPrompt(topic, { due: past(20), stability: 1, lastReview: past(30), question: "weak", source: "[Paper](https://ex.com/p)" });
    const strong = await seedPrompt(topic, { due: past(1), stability: 200, lastReview: past(2), question: "strong" });
    await seedPrompt(topic, { due: future(3), question: "future" });

    const s = await buildSession(env.DB, { ahead: false, topicId: topic, cap: 20, tz: "UTC" }, now);
    expect(s.cards.length).toBe(2);
    expect(s.cards[0].id).toBe(weak);
    expect(s.cards[1].id).toBe(strong);
    expect(s.nextDue).not.toBeNull();
    expect(s.nextDueCount).toBeGreaterThanOrEqual(1); // the "future" prompt seeded above
    expect(s.cards[0].topicName).toBe("Sess Topic");
    // Attribution renders as inline markdown; absent source is null, not "".
    expect(s.cards[0].sourceHtml).toContain('<a href="https://ex.com/p"');
    expect(s.cards[0].sourceHtml).toContain("Paper");
    expect(s.cards[1].sourceHtml).toBeNull();

    const capped = await buildSession(env.DB, { ahead: false, topicId: topic, cap: 1, tz: "UTC" }, now);
    expect(capped.cards.length).toBe(1);
    expect(capped.dueRemaining).toBe(1);
  });

  it("ahead mode serves not-yet-due, soonest first", async () => {
    const s = await buildSession(env.DB, { ahead: true, topicId: topic, cap: 20, tz: "UTC" }, now);
    expect(s.cards.length).toBeGreaterThanOrEqual(1);
    expect(s.cards[0].questionHtml).toContain("future");
    expect(s.ahead).toBe(true);
  });

  it("excludes retired prompts", async () => {
    const r = await seedPrompt(topic, { due: past(5), question: "retiredq" });
    await env.DB.prepare("UPDATE prompts SET retired = 1 WHERE id = ?").bind(r).run();
    const s = await buildSession(env.DB, { ahead: false, topicId: topic, cap: 50, tz: "UTC" }, now);
    expect(s.cards.some(c => c.id === r)).toBe(false);
  });

  it("counts a prompt due later today as due, and one due after midnight as ahead", async () => {
    const end = endOfLocalDay(now, "UTC");
    const later = await seedPrompt(topic, { due: new Date(end.getTime() - 60_000).toISOString(), question: "later-today" });
    const next = await seedPrompt(topic, { due: new Date(end.getTime() + 60_000).toISOString(), question: "after-midnight" });
    const s = await buildSession(env.DB, { ahead: false, topicId: topic, cap: 50, tz: "UTC" }, now);
    expect(s.cards.some(c => c.id === later)).toBe(true);
    expect(s.cards.some(c => c.id === next)).toBe(false);
    const ahead = await buildSession(env.DB, { ahead: true, topicId: topic, cap: 50, tz: "UTC" }, now);
    expect(ahead.cards.some(c => c.id === next)).toBe(true);
  });

  it("counts the next due day by local calendar day, not UTC day", async () => {
    const topic2 = newId();
    await env.DB.prepare("INSERT INTO topics (id, name, url, meta, created_at) VALUES (?, 'Sess Topic 2', NULL, '{}', ?)")
      .bind(topic2, nowIso()).run();
    // 01:00 and 20:00 PDT on Aug 22 — the same local day, two different UTC days
    await seedPrompt(topic2, { due: "2026-08-22T08:00:00.000Z", question: "early" });
    await seedPrompt(topic2, { due: "2026-08-23T03:00:00.000Z", question: "late" });
    const fixedNow = new Date("2026-08-21T14:00:00Z");
    const s = await buildSession(env.DB, { ahead: false, topicId: topic2, cap: 50, tz: "America/Los_Angeles" }, fixedNow);
    expect(s.cards.length).toBe(0);
    expect(s.nextDue).toBe("2026-08-22T08:00:00.000Z");
    expect(s.nextDueCount).toBe(2);
  });
});
