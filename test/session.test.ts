import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { newId, nowIso } from "../src/db";
import { buildSession, interleave } from "../src/session";
import { endOfLocalDay } from "../src/clock";
import { wipeData } from "./helpers";

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

  it("selects due cards weakest-first under the cap, reports nextDue", async () => {
    const weak = await seedPrompt(topic, { due: past(20), stability: 1, lastReview: past(30), question: "weak", source: "[Paper](https://ex.com/p)" });
    const strong = await seedPrompt(topic, { due: past(1), stability: 200, lastReview: past(2), question: "strong" });
    await seedPrompt(topic, { due: future(3), question: "future" });

    const s = await buildSession(env.DB, { ahead: false, topicId: topic, cap: 20, tz: "UTC" }, now);
    expect(s.cards.map(c => c.id).sort()).toEqual([weak, strong].sort());
    expect(s.nextDue).not.toBeNull();
    expect(s.nextDueCount).toBeGreaterThanOrEqual(1); // the "future" prompt seeded above
    const w = s.cards.find(c => c.id === weak)!;
    expect(w.topicName).toBe("Sess Topic");
    // Attribution renders as inline markdown; absent source is null, not "".
    expect(w.sourceHtml).toContain('<a href="https://ex.com/p"');
    expect(w.sourceHtml).toContain("Paper");
    expect(s.cards.find(c => c.id === strong)!.sourceHtml).toBeNull();

    // The cap keeps the weakest; presentation order is shuffled (see interleave).
    const capped = await buildSession(env.DB, { ahead: false, topicId: topic, cap: 1, tz: "UTC" }, now);
    expect(capped.cards.map(c => c.id)).toEqual([weak]);
    expect(capped.dueRemaining).toBe(1);
  });

  it("ahead mode serves not-yet-due, soonest first under the cap", async () => {
    const later = await seedPrompt(topic, { due: future(9), question: "later" });
    const s = await buildSession(env.DB, { ahead: true, topicId: topic, cap: 1, tz: "UTC" }, now);
    expect(s.cards.length).toBe(1);
    expect(s.cards[0].questionHtml).toContain("future");
    await env.DB.prepare("DELETE FROM prompts WHERE id = ?").bind(later).run();
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

function seeded(seed: number) {
  // mulberry32 — deterministic rand for order tests
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("interleave", () => {
  const items = (spec: Record<string, number>) =>
    Object.entries(spec).flatMap(([k, n]) => Array.from({ length: n }, (_, i) => ({ k, i })));

  it("keeps every card exactly once", () => {
    const xs = items({ a: 4, b: 3, c: 1 });
    const out = interleave(xs, x => x.k, seeded(1));
    expect(out.length).toBe(xs.length);
    expect(new Set(out).size).toBe(xs.length);
  });

  it("never puts two cards from one source back to back when the mix allows", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const out = interleave(items({ a: 5, b: 3, c: 2 }), x => x.k, seeded(seed));
      for (let i = 1; i < out.length; i++) expect(out[i].k).not.toBe(out[i - 1].k);
    }
  });

  it("does not replay a fixed order", () => {
    const xs = items({ a: 8 });
    const orders = new Set(Array.from({ length: 20 }, (_, s) =>
      interleave(xs, x => x.k, seeded(s + 1)).map(x => x.i).join(",")));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("still serves everything when one source dominates", () => {
    const out = interleave(items({ a: 5, b: 1 }), x => x.k, seeded(3));
    expect(out.filter(x => x.k === "a").length).toBe(5);
    expect(out.filter(x => x.k === "b").length).toBe(1);
  });
});

describe("buildSession order", () => {
  it("never serves two prompts from one topic back to back when the mix allows", async () => {
    await wipeData();
    const now = new Date();
    const past = new Date(now.getTime() - 5 * 86400_000).toISOString();
    const reviewed = new Date(now.getTime() - 10 * 86400_000).toISOString();
    // Identical schedule state, inserted grouped by topic: priority order alone
    // would serve A A A B B B.
    for (const name of ["Topic A", "Topic B"]) {
      const tid = newId();
      await env.DB.prepare("INSERT INTO topics (id, name, url, meta, created_at) VALUES (?, ?, NULL, '{}', ?)")
        .bind(tid, name, nowIso()).run();
      for (let i = 0; i < 3; i++) await seedPrompt(tid, { due: past, stability: 5, lastReview: reviewed });
    }
    for (let run = 0; run < 5; run++) {
      const s = await buildSession(env.DB, { ahead: false, topicId: null, cap: 20, tz: "UTC" }, now);
      expect(s.cards.length).toBe(6);
      for (let i = 1; i < s.cards.length; i++) expect(s.cards[i].topicName).not.toBe(s.cards[i - 1].topicName);
    }
  });
});
