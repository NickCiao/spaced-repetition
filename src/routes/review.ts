import type { Env } from "../env.d";
import { getSettings, nowIso, type PromptRow } from "../db";
import { applyGrade } from "../scheduler";
import { buildSession } from "../session";
import { jsonForScript, navCounts, page, shellFor } from "../html";

export async function reviewPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const settings = await getSettings(env.DB);
  const now = new Date();
  const shell = await shellFor(env.DB, "review", now);
  const sourceId = url.searchParams.get("source");
  const session = await buildSession(env.DB, {
    ahead: url.searchParams.get("ahead") === "1",
    sourceId,
    cap: settings.session_cap,
    tz: settings.timezone
  }, now);

  const sessionPayload = { ...session, sourceId };
  const body = `<div id="review"></div>
<script type="application/json" id="session">${jsonForScript(sessionPayload)}</script>`;

  return page("Review", body, {
    script: "/static/review.js",
    shell
  });
}

export async function gradeApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<{ prompt_id?: string; action?: string; note?: string }>().catch(() => null);
  const actions = ["remembered", "forgot", "skip", "flag", "retire"];
  if (!b?.prompt_id || !b.action || !actions.includes(b.action)) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const p = await env.DB.prepare("SELECT * FROM prompts WHERE id = ?").bind(b.prompt_id).first<PromptRow>();
  if (!p) return Response.json({ error: "unknown prompt" }, { status: 404 });

  const now = new Date();
  const ts = nowIso();
  let stateAfter: string | null = null;
  let due: string | null = p.due;
  let elapsed: number | null = p.last_review
    ? (now.getTime() - new Date(p.last_review).getTime()) / 86400_000 : null;

  if (b.action === "remembered" || b.action === "forgot") {
    const settings = await getSettings(env.DB);
    const f = applyGrade(p, b.action, now, settings.desired_retention);
    stateAfter = JSON.stringify(f);
    due = f.due;
    await env.DB.prepare(
      `UPDATE prompts SET due=?, stability=?, difficulty=?, elapsed_days=?, scheduled_days=?,
        reps=?, lapses=?, state=?, last_review=?, updated_at=? WHERE id=?`
    ).bind(f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
           f.reps, f.lapses, f.state, f.last_review, ts, p.id).run();
  } else if (b.action === "flag") {
    await env.DB.prepare("UPDATE prompts SET flag_note=?, updated_at=? WHERE id=?")
      .bind((b.note ?? "").trim() || "flagged", ts, p.id).run();
  } else if (b.action === "retire") {
    await env.DB.prepare("UPDATE prompts SET retired=1, updated_at=? WHERE id=?").bind(ts, p.id).run();
  } // skip: event only

  await env.DB.prepare(
    "INSERT INTO events (ts, prompt_id, action, elapsed_days, state_after) VALUES (?, ?, ?, ?, ?)"
  ).bind(ts, p.id, b.action, elapsed, stateAfter).run();

  return Response.json({ ok: true, due, ...(await navCounts(env.DB, now)) });
}
