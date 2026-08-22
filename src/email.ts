import type { Env } from "./env.d";
import { getSetting, getSettings, setSetting } from "./db";
import { endOfLocalDay, localDate, localHour } from "./clock";
import { retrievability, type SchedFields } from "./scheduler";

export type CadenceState = { unanswered: number; mode: "daily" | "weekly"; last_sent: string | null };

// Session-worthiness (spec §4, after Orbit's reviewSessionScheduling): a reminder is only
// worth sending when a full session is due, or a prompt has waited too long, or answering
// late is already expected to cost a forgotten prompt, or no fuller session is coming
// within the lookahead. All three numbers are deliberately constants, not settings.
//
// The threshold is 1 expected forgetting where Orbit uses 2: FSRS-6's curve past the due
// date is about half as steep as Orbit's 0.9^n heuristic, so the two fire at similar lateness.
export const FORGETTING_COST_THRESHOLD = 1;
export const LOOKAHEAD_DAYS = 7; // today plus the six days after it
export const MAX_WAIT_DAYS = 7;

export type SessionDecision =
  | { ready: true; reason: "full-session" | "waited-too-long" | "forgetting-cost" | "no-better-session-soon"; dueCount: number }
  | { ready: false; reason: "nothing-due" | "fuller-session-soon"; dueCount: number };

// A never-reviewed prompt has no FSRS state, so model its first retrieval as a one-day
// memory from the moment it came due (the same one-day unit Orbit uses): waiting then
// accrues cost instead of costing nothing — or everything.
function curve(p: SchedFields): SchedFields {
  return p.reps === 0 || p.state === 0 || !p.last_review
    ? { ...p, stability: 1, reps: 1, state: 2, last_review: p.due }
    : p;
}

// Expected extra forgettings from answering at `t` instead of when due: recall at the due
// date (the retention each prompt was scheduled for) minus recall at `t`. On time costs nothing.
function lateCost(items: SchedFields[], t: Date): number {
  return items.reduce((sum, p) => {
    const c = curve(p);
    return sum + Math.max(0, retrievability(c, new Date(c.due)) - retrievability(c, t));
  }, 0);
}

export function sessionReady(a: {
  now: Date; tz: string; upcoming: SchedFields[]; activeCount: number; cap: number;
}): SessionDecision {
  if (a.activeCount === 0) return { ready: false, reason: "nothing-due", dueCount: 0 };
  const full = Math.min(a.activeCount, a.cap);

  // Day k is judged as the user would experience it: what's due by the end of that local
  // day, answered at that day's review moment.
  const reviewAt = (k: number) => new Date(a.now.getTime() + k * 86400_000);
  const dueBy = (k: number) => {
    const end = endOfLocalDay(reviewAt(k), a.tz).getTime();
    return a.upcoming.filter(p => new Date(p.due).getTime() < end);
  };

  const due = dueBy(0);
  if (due.length >= full) return { ready: true, reason: "full-session", dueCount: due.length };
  if (due.length === 0) return { ready: false, reason: "nothing-due", dueCount: 0 };

  // "Waited a week" in local days: due on or before the day seven days ago.
  const weekAgo = endOfLocalDay(new Date(a.now.getTime() - MAX_WAIT_DAYS * 86400_000), a.tz).getTime();
  if (due.some(p => new Date(p.due).getTime() < weekAgo))
    return { ready: true, reason: "waited-too-long", dueCount: due.length };
  if (lateCost(due, a.now) >= FORGETTING_COST_THRESHOLD)
    return { ready: true, reason: "forgetting-cost", dueCount: due.length };

  for (let k = 1; k < LOOKAHEAD_DAYS; k++) {
    const queue = dueBy(k);
    // Waiting this long (or longer) costs too much — send now rather than hold out.
    if (lateCost(queue, reviewAt(k)) >= FORGETTING_COST_THRESHOLD) break;
    if (queue.length > due.length) return { ready: false, reason: "fuller-session-soon", dueCount: due.length };
  }
  return { ready: true, reason: "no-better-session-soon", dueCount: due.length };
}

export function decideReminder(a: {
  now: Date; tz: string; hour: number; ready: boolean;
  cadence: CadenceState; lastReviewAt: string | null;
}): { send: boolean; cadence: CadenceState } {
  let c = { ...a.cadence };

  const reviewedSinceLastSend =
    c.last_sent !== null && a.lastReviewAt !== null && a.lastReviewAt > c.last_sent;
  if (reviewedSinceLastSend) c = { ...c, unanswered: 0, mode: "daily" };

  if (!a.ready) return { send: false, cadence: c };
  if (localHour(a.now, a.tz) !== a.hour) return { send: false, cadence: c };
  if (c.last_sent && localDate(new Date(c.last_sent), a.tz) === localDate(a.now, a.tz))
    return { send: false, cadence: c };
  if (c.mode === "weekly" && c.last_sent &&
      a.now.getTime() - new Date(c.last_sent).getTime() < 7 * 86400_000)
    return { send: false, cadence: c };

  const unanswered = c.unanswered + 1;
  return {
    send: true,
    cadence: {
      unanswered,
      mode: unanswered >= 4 ? "weekly" : c.mode,
      last_sent: a.now.toISOString()
    }
  };
}

export function composeReminder(count: number, baseUrl: string): { subject: string; html: string } {
  const mins = Math.max(1, Math.ceil((count * 20) / 60));
  const subject = `Reminder: ${count} prompt${count === 1 ? "" : "s"} due · ~${mins} min`;
  const html = `
<p>Take a minute to reinforce ${count} detail${count === 1 ? "" : "s"} you wanted to keep.</p>
<p><a href="${baseUrl}/">Start review</a> (~${mins} min)</p>
<p style="color:#888;font-size:13px">This is the only email this system sends. It backs off if you're busy.</p>`;
  return { subject, html };
}

async function sendReminder(env: Env, subject: string, html: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: env.EMAIL_TO, subject, html })
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
}

export async function runReminderCron(env: Env, now: Date): Promise<void> {
  const s = await getSettings(env.DB);
  const cadence = JSON.parse((await getSetting(env.DB, "cadence")) ?? '{"unanswered":0,"mode":"daily","last_sent":null}') as CadenceState;

  // Everything due by the end of the last lookahead day — exactly what sessionReady evaluates.
  const horizon = endOfLocalDay(new Date(now.getTime() + (LOOKAHEAD_DAYS - 1) * 86400_000), s.timezone).toISOString();
  const upcoming = (await env.DB.prepare(
    `SELECT due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review
     FROM prompts WHERE retired = 0 AND due < ?`
  ).bind(horizon).all<SchedFields>()).results;
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts WHERE retired = 0").first<{ n: number }>();
  const session = sessionReady({
    now, tz: s.timezone, upcoming, activeCount: active?.n ?? 0, cap: s.session_cap
  });

  const lastReview = await env.DB.prepare(
    "SELECT MAX(ts) AS t FROM events WHERE action IN ('remembered','forgot')"
  ).first<{ t: string | null }>();

  const d = decideReminder({
    now, tz: s.timezone, hour: s.email_hour, ready: session.ready,
    cadence, lastReviewAt: lastReview?.t ?? null
  });
  console.log(JSON.stringify({ reminder: session.reason, ready: session.ready, due: session.dueCount, send: d.send }));
  if (d.send) {
    const { subject, html } = composeReminder(session.dueCount, env.BASE_URL);
    await sendReminder(env, subject, html);
  }
  await setSetting(env.DB, "cadence", JSON.stringify(d.cadence));
}
