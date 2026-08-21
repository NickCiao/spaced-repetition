import type { Env } from "./env.d";
import { getSetting, getSettings, setSetting } from "./db";

export type CadenceState = { unanswered: number; mode: "daily" | "weekly"; last_sent: string | null };

export function localHour(now: Date, timeZone: string): number {
  return parseInt(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(now), 10) % 24;
}

function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now); // YYYY-MM-DD
}

export function decideReminder(a: {
  now: Date; tz: string; hour: number; dueCount: number;
  cadence: CadenceState; lastReviewAt: string | null;
}): { send: boolean; cadence: CadenceState } {
  let c = { ...a.cadence };

  const reviewedSinceLastSend =
    c.last_sent !== null && a.lastReviewAt !== null && a.lastReviewAt > c.last_sent;
  if (reviewedSinceLastSend) c = { ...c, unanswered: 0, mode: "daily" };

  if (a.dueCount === 0) return { send: false, cadence: c };
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
  const due = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts WHERE retired = 0 AND due <= ?")
    .bind(now.toISOString()).first<{ n: number }>();
  const lastReview = await env.DB.prepare(
    "SELECT MAX(ts) AS t FROM events WHERE action IN ('remembered','forgot')"
  ).first<{ t: string | null }>();

  const d = decideReminder({
    now, tz: s.timezone, hour: s.email_hour, dueCount: due?.n ?? 0,
    cadence, lastReviewAt: lastReview?.t ?? null
  });
  if (d.send) {
    const { subject, html } = composeReminder(due!.n, env.BASE_URL);
    await sendReminder(env, subject, html);
  }
  await setSetting(env.DB, "cadence", JSON.stringify(d.cadence));
}
