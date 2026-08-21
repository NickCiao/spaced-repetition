import { createExecutionContext, env, fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { composeReminder, decideReminder, localHour, type CadenceState } from "../src/email";
import { setSetting } from "../src/db";
import worker from "../src/index";

const base: CadenceState = { unanswered: 0, mode: "daily", last_sent: null };
const at = (iso: string) => new Date(iso);

describe("decideReminder (pure)", () => {
  const tz = "America/Los_Angeles";
  const seven = at("2026-08-20T14:00:00Z"); // 07:00 PDT

  it("sends at the configured local hour when prompts are due", () => {
    const d = decideReminder({ now: seven, tz, hour: 7, dueCount: 6, cadence: base, lastReviewAt: null });
    expect(d.send).toBe(true);
    expect(d.cadence.unanswered).toBe(1);
  });

  it("does not send off-hour, when zero due, or twice in a day", () => {
    expect(decideReminder({ now: at("2026-08-20T15:00:00Z"), tz, hour: 7, dueCount: 6, cadence: base, lastReviewAt: null }).send).toBe(false);
    expect(decideReminder({ now: seven, tz, hour: 7, dueCount: 0, cadence: base, lastReviewAt: null }).send).toBe(false);
    const already = { ...base, last_sent: "2026-08-20T14:00:00Z" };
    expect(decideReminder({ now: at("2026-08-20T14:59:00Z"), tz, hour: 7, dueCount: 6, cadence: already, lastReviewAt: null }).send).toBe(false);
  });

  it("4 unanswered dailies decay to weekly; weekly waits 7 days", () => {
    let c: CadenceState = { unanswered: 3, mode: "daily", last_sent: "2026-08-19T14:00:00Z" };
    const d = decideReminder({ now: seven, tz, hour: 7, dueCount: 3, cadence: c, lastReviewAt: "2026-08-10T00:00:00Z" });
    expect(d.send).toBe(true);
    expect(d.cadence.mode).toBe("weekly");
    expect(d.cadence.unanswered).toBe(4);

    const tooSoon = decideReminder({
      now: at("2026-08-22T14:00:00Z"), tz, hour: 7, dueCount: 3,
      cadence: d.cadence, lastReviewAt: "2026-08-10T00:00:00Z"
    });
    expect(tooSoon.send).toBe(false);

    const weekLater = decideReminder({
      now: at("2026-08-27T14:00:00Z"), tz, hour: 7, dueCount: 3,
      cadence: d.cadence, lastReviewAt: "2026-08-10T00:00:00Z"
    });
    expect(weekLater.send).toBe(true);
  });

  it("a review since last send resets to daily", () => {
    const c: CadenceState = { unanswered: 4, mode: "weekly", last_sent: "2026-08-19T14:00:00Z" };
    const d = decideReminder({ now: seven, tz, hour: 7, dueCount: 2, cadence: c, lastReviewAt: "2026-08-19T20:00:00Z" });
    expect(d.send).toBe(true);
    expect(d.cadence.mode).toBe("daily");
    expect(d.cadence.unanswered).toBe(1);
  });

  it("localHour respects timezones; compose has no streaks and no token", () => {
    expect(localHour(at("2026-08-20T14:00:00Z"), "America/Los_Angeles")).toBe(7);
    expect(localHour(at("2026-08-20T14:00:00Z"), "UTC")).toBe(14);
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

  it("sends one Resend email when due at the configured hour", async () => {
    await setSetting(env.DB, "timezone", "UTC");
    await setSetting(env.DB, "email_hour", "9");
    await setSetting(env.DB, "cadence", JSON.stringify(base));
    // seed one due prompt
    const now = "2026-08-21T09:05:00Z";
    await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES ('cronsrc001', 'Cron', NULL, '{}', ?)")
      .bind(now).run();
    await env.DB.prepare(
      `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
        due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
       VALUES ('cronpmt001', 'cronsrc001', 'qa', 'q', 'a', 0, ?, ?, '2026-08-20T00:00:00Z', 1, 5, 0, 1, 1, 0, 2, '2026-08-19T00:00:00Z')`
    ).bind(now, now).run();

    fetchMock.get("https://api.resend.com")
      .intercept({ path: "/emails", method: "POST" })
      .reply(200, { id: "email_1" });

    const ctx = createExecutionContext();
    await worker.scheduled(
      { scheduledTime: new Date(now).getTime(), cron: "0 * * * *", noRetry() {} } as ScheduledController,
      env, ctx
    );
    await waitOnExecutionContext(ctx);
    // assertNoPendingInterceptors in afterEach proves the send happened exactly once

    // restore for other tests (shared, non-isolated storage)
    await setSetting(env.DB, "timezone", "America/Los_Angeles");
    await setSetting(env.DB, "email_hour", "7");
    await setSetting(env.DB, "cadence", JSON.stringify(base));
  });
});
