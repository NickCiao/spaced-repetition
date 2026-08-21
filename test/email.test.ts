import { createExecutionContext, env, fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { composeReminder, decideReminder, sessionReady, type CadenceState } from "../src/email";
import { getSetting, setSetting } from "../src/db";
import type { SchedFields } from "../src/scheduler";
import worker from "../src/index";

const base: CadenceState = { unanswered: 0, mode: "daily", last_sent: null };
const at = (iso: string) => new Date(iso);
const days = (n: number, from: Date) => new Date(from.getTime() + n * 86400_000);

// Fixtures, calibrated against ts-fsrs 5.4.1 (FSRS-6). Cost is marginal: recall when due
// minus recall now. `solid` (stability 100, reviewed 10 days ago) costs ≈0 all week.
// A never-reviewed prompt is modelled as a one-day memory from its due time: it costs
// 0 on the day it comes due, then ≈0.10 / 0.15 / 0.19 after 1 / 2 / 3 days of waiting.
function fresh(due: Date): SchedFields {
  return {
    due: due.toISOString(), stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0,
    reps: 0, lapses: 0, state: 0, last_review: null
  };
}
function learned(due: Date, stability: number, lastReview: Date): SchedFields {
  return {
    due: due.toISOString(), stability, difficulty: 5, elapsed_days: 0, scheduled_days: 0,
    reps: 1, lapses: 0, state: 2, last_review: lastReview.toISOString()
  };
}

describe("sessionReady (pure)", () => {
  const now = at("2026-08-21T09:00:00Z"); // today (UTC) ends at 2026-08-22T00:00Z
  const tz = "UTC";
  const solid = (due: Date) => learned(due, 100, days(-10, now));
  const defaults = { now, tz, cap: 20 };
  const many = (n: number, make: () => SchedFields) => Array.from({ length: n }, make);

  it("is not ready with no active prompts", () => {
    expect(sessionReady({ ...defaults, upcoming: [], activeCount: 0 }))
      .toMatchObject({ ready: false, reason: "nothing-due", dueCount: 0 });
  });

  it("is not ready when nothing is due before tomorrow", () => {
    const upcoming = many(2, () => solid(at("2026-08-22T01:00:00Z")));
    expect(sessionReady({ ...defaults, upcoming, activeCount: 10 }))
      .toMatchObject({ ready: false, reason: "nothing-due", dueCount: 0 });
  });

  it("counts a prompt due later today as due", () => {
    const upcoming = [solid(at("2026-08-21T22:00:00Z"))];
    expect(sessionReady({ ...defaults, upcoming, activeCount: 1 }))
      .toMatchObject({ ready: true, reason: "full-session", dueCount: 1 });
  });

  it("is ready when a full session is due", () => {
    const upcoming = many(3, () => solid(now));
    expect(sessionReady({ ...defaults, cap: 3, upcoming, activeCount: 10 }))
      .toMatchObject({ ready: true, reason: "full-session", dueCount: 3 });
  });

  it("bounds a full session by the number of active prompts", () => {
    const upcoming = many(2, () => solid(now));
    expect(sessionReady({ ...defaults, upcoming, activeCount: 2 }))
      .toMatchObject({ ready: true, reason: "full-session", dueCount: 2 });
  });

  it("waits when well-remembered prompts have a fuller session coming", () => {
    const upcoming = [...many(2, () => solid(now)), ...many(3, () => solid(days(2, now)))];
    expect(sessionReady({ ...defaults, upcoming, activeCount: 10 }))
      .toMatchObject({ ready: false, reason: "fuller-session-soon", dueCount: 2 });
  });

  it("waits for a fuller session on the last day of the lookahead", () => {
    const upcoming = [...many(2, () => solid(now)), ...many(5, () => solid(at("2026-08-27T20:00:00Z")))];
    expect(sessionReady({ ...defaults, upcoming, activeCount: 10 }))
      .toMatchObject({ ready: false, reason: "fuller-session-soon", dueCount: 2 });
  });

  it("is ready when the fuller session is beyond the lookahead", () => {
    const upcoming = [...many(2, () => solid(now)), ...many(5, () => solid(at("2026-08-28T01:00:00Z")))];
    expect(sessionReady({ ...defaults, upcoming, activeCount: 10 }))
      .toMatchObject({ ready: true, reason: "no-better-session-soon", dueCount: 2 });
  });

  it("is ready when answering late already costs an expected forgetting, even with a fuller session tomorrow", () => {
    // scheduled for a day, now six days late: ≈0.17 each, ×8 ≈ 1.4
    const late = () => learned(days(-6, now), 1, days(-7, now));
    const upcoming = [...many(8, late), ...many(5, () => solid(days(1, now)))];
    expect(sessionReady({ ...defaults, upcoming, activeCount: 30 }))
      .toMatchObject({ ready: true, reason: "forgetting-cost", dueCount: 8 });
  });

  it("three new prompts wait for a fuller session", () => {
    const upcoming = [...many(3, () => fresh(now)), ...many(4, () => solid(days(1, now)))];
    expect(sessionReady({ ...defaults, upcoming, activeCount: 10 }))
      .toMatchObject({ ready: false, reason: "fuller-session-soon", dueCount: 3 });
  });

  it("new prompts accrue cost as they wait", () => {
    // six new prompts that have waited three days: ≈0.19 each ≈ 1.15
    const upcoming = [...many(6, () => fresh(days(-3, now))), ...many(4, () => solid(days(1, now)))];
    expect(sessionReady({ ...defaults, upcoming, activeCount: 10 }))
      .toMatchObject({ ready: true, reason: "forgetting-cost", dueCount: 6 });
  });

  it("a prompt that has waited a week earns a session regardless", () => {
    const upcoming = [solid(days(-7, now)), ...many(5, () => solid(days(1, now)))];
    expect(sessionReady({ ...defaults, upcoming, activeCount: 10 }))
      .toMatchObject({ ready: true, reason: "waited-too-long", dueCount: 1 });
  });

  it("measures the week-long wait in local days", () => {
    // due late on Aug 14: seven local days ago, though only 6d10h by the clock
    const upcoming = [solid(at("2026-08-14T23:00:00Z")), ...many(5, () => solid(days(1, now)))];
    expect(sessionReady({ ...defaults, upcoming, activeCount: 10 }))
      .toMatchObject({ ready: true, reason: "waited-too-long", dueCount: 1 });
    // due just after midnight on Aug 15: six local days ago, so not yet
    const notYet = [solid(at("2026-08-15T00:30:00Z")), ...many(5, () => solid(days(1, now)))];
    expect(sessionReady({ ...defaults, upcoming: notYet, activeCount: 10 }))
      .toMatchObject({ ready: false, reason: "fuller-session-soon", dueCount: 1 });
  });

  it("treats a prompt in the New state as never reviewed even if reps is set", () => {
    const odd = () => ({ ...learned(days(-3, now), 1, days(-3, now)), state: 0 });
    const upcoming = [...many(6, odd), ...many(4, () => solid(days(1, now)))];
    expect(sessionReady({ ...defaults, upcoming, activeCount: 10 }))
      .toMatchObject({ ready: true, reason: "forgetting-cost", dueCount: 6 });
  });

  it("does not wait for a fuller session that would itself cost too much", () => {
    // seven new prompts: 0.7 after one day, 1.08 after two — the day-3 session isn't worth the wait
    const upcoming = [...many(7, () => fresh(now)), ...many(8, () => solid(at("2026-08-24T12:00:00Z")))];
    expect(sessionReady({ ...defaults, upcoming, activeCount: 20 }))
      .toMatchObject({ ready: true, reason: "no-better-session-soon", dueCount: 7 });
  });
});

describe("decideReminder (pure)", () => {
  const tz = "America/Los_Angeles";
  const seven = at("2026-08-20T14:00:00Z"); // 07:00 PDT

  it("sends at the configured local hour when a session is ready", () => {
    const d = decideReminder({ now: seven, tz, hour: 7, ready: true, cadence: base, lastReviewAt: null });
    expect(d.send).toBe(true);
    expect(d.cadence.unanswered).toBe(1);
  });

  it("does not send off-hour, when no session is ready, or twice in a day", () => {
    expect(decideReminder({ now: at("2026-08-20T15:00:00Z"), tz, hour: 7, ready: true, cadence: base, lastReviewAt: null }).send).toBe(false);
    expect(decideReminder({ now: seven, tz, hour: 7, ready: false, cadence: base, lastReviewAt: null }).send).toBe(false);
    const already = { ...base, last_sent: "2026-08-20T14:00:00Z" };
    expect(decideReminder({ now: at("2026-08-20T14:59:00Z"), tz, hour: 7, ready: true, cadence: already, lastReviewAt: null }).send).toBe(false);
  });

  it("4 unanswered dailies decay to weekly; weekly waits 7 days", () => {
    let c: CadenceState = { unanswered: 3, mode: "daily", last_sent: "2026-08-19T14:00:00Z" };
    const d = decideReminder({ now: seven, tz, hour: 7, ready: true, cadence: c, lastReviewAt: "2026-08-10T00:00:00Z" });
    expect(d.send).toBe(true);
    expect(d.cadence.mode).toBe("weekly");
    expect(d.cadence.unanswered).toBe(4);

    const tooSoon = decideReminder({
      now: at("2026-08-22T14:00:00Z"), tz, hour: 7, ready: true,
      cadence: d.cadence, lastReviewAt: "2026-08-10T00:00:00Z"
    });
    expect(tooSoon.send).toBe(false);

    const weekLater = decideReminder({
      now: at("2026-08-27T14:00:00Z"), tz, hour: 7, ready: true,
      cadence: d.cadence, lastReviewAt: "2026-08-10T00:00:00Z"
    });
    expect(weekLater.send).toBe(true);
  });

  it("a review since last send resets to daily", () => {
    const c: CadenceState = { unanswered: 4, mode: "weekly", last_sent: "2026-08-19T14:00:00Z" };
    const d = decideReminder({ now: seven, tz, hour: 7, ready: true, cadence: c, lastReviewAt: "2026-08-19T20:00:00Z" });
    expect(d.send).toBe(true);
    expect(d.cadence.mode).toBe("daily");
    expect(d.cadence.unanswered).toBe(1);
  });

  it("compose has no streaks and no token", () => {
    const { subject, html } = composeReminder(6, "https://sr.example");
    expect(subject).toBe("Reminder: 6 prompts due · ~2 min");
    expect(html).toContain("https://sr.example/");
    expect(html.toLowerCase()).not.toContain("streak");
    expect(html).not.toContain("token=");
  });
});

describe("scheduled handler", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  // Storage is shared across files (see vitest.config.ts), so the cron's view of "what's
  // due" must be made deterministic: retire everything else for the duration of a test.
  async function quiesce(): Promise<() => Promise<void>> {
    const ids = (await env.DB.prepare("SELECT id FROM prompts WHERE retired = 0").all<{ id: string }>())
      .results.map(r => r.id);
    await env.DB.prepare("UPDATE prompts SET retired = 1 WHERE retired = 0").run();
    return async () => {
      const stmt = env.DB.prepare("UPDATE prompts SET retired = 0 WHERE id = ?");
      if (ids.length) await env.DB.batch(ids.map(id => stmt.bind(id)));
    };
  }

  async function seed(sourceId: string, prompts: { id: string; f: SchedFields }[], now: string) {
    await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, 'Cron', NULL, '{}', ?)")
      .bind(sourceId, now).run();
    for (const { id, f } of prompts) {
      await env.DB.prepare(
        `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
          due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
         VALUES (?, ?, 'qa', 'q', 'a', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, sourceId, now, now, f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
        f.reps, f.lapses, f.state, f.last_review).run();
    }
  }

  async function unseed(sourceId: string) {
    await env.DB.prepare("DELETE FROM prompts WHERE source_id = ?").bind(sourceId).run();
    await env.DB.prepare("DELETE FROM sources WHERE id = ?").bind(sourceId).run();
  }

  async function pinSettings(tz: string, hour: string) {
    await setSetting(env.DB, "timezone", tz);
    await setSetting(env.DB, "email_hour", hour);
    await setSetting(env.DB, "session_cap", "20");
    await setSetting(env.DB, "desired_retention", "0.9");
    await setSetting(env.DB, "cadence", JSON.stringify(base));
  }

  async function runCron(now: string) {
    const ctx = createExecutionContext();
    await worker.scheduled(
      { scheduledTime: new Date(now).getTime(), cron: "0 * * * *", noRetry() {} } as ScheduledController,
      env, ctx
    );
    await waitOnExecutionContext(ctx);
  }

  it("sends one Resend email, counting only what is due, when a session is ready at the configured hour", async () => {
    let restore: (() => Promise<void>) | null = null;
    const now = "2026-08-21T09:05:00Z";
    const t = at(now);
    try {
      restore = await quiesce();
      await pinSettings("UTC", "9");
      await seed("cronsrc001", [
        // one prompt that has waited more than a week, plus three that aren't due until day 3
        { id: "cronpmt001", f: learned(days(-8, t), 1, days(-9, t)) },
        { id: "cronpmt002", f: learned(days(3, t), 100, days(-10, t)) },
        { id: "cronpmt003", f: learned(days(3, t), 100, days(-10, t)) },
        { id: "cronpmt004", f: learned(days(3, t), 100, days(-10, t)) }
      ], now);
      fetchMock.get("https://api.resend.com")
        .intercept({ path: "/emails", method: "POST", body: (b: string) => b.includes("Reminder: 1 prompt due") })
        .reply(200, { id: "email_1" });
      await runCron(now);
      // assertNoPendingInterceptors in afterEach proves the send happened exactly once
      const cadence = JSON.parse((await getSetting(env.DB, "cadence"))!) as CadenceState;
      expect(cadence.unanswered).toBe(1);
      expect(cadence.last_sent).toBe(t.toISOString());
    } finally {
      if (restore) await restore();
      await unseed("cronsrc001");
      await pinSettings("America/Los_Angeles", "7");
    }
  });

  it("does not send when the due prompts can wait for a fuller session", async () => {
    let restore: (() => Promise<void>) | null = null;
    const now = "2026-08-21T09:05:00Z";
    const t = at(now);
    try {
      restore = await quiesce();
      await pinSettings("UTC", "9");
      const solid = (due: Date) => learned(due, 100, days(-10, t));
      await seed("cronsrc002", [
        { id: "cronpmt101", f: solid(days(-1, t)) },
        { id: "cronpmt102", f: solid(days(2, t)) },
        { id: "cronpmt103", f: solid(days(2, t)) },
        { id: "cronpmt104", f: solid(days(2, t)) }
      ], now);
      await runCron(now); // no interceptor registered: any send would throw
      const cadence = JSON.parse((await getSetting(env.DB, "cadence"))!) as CadenceState;
      expect(cadence.last_sent).toBeNull();
    } finally {
      if (restore) await restore();
      await unseed("cronsrc002");
      await pinSettings("America/Los_Angeles", "7");
    }
  });
});
