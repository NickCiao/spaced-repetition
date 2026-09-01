import type { Env } from "../env.d";
import { getSettings, newId, nowIso } from "../db";
import { localDate } from "../clock";
import { navCounts, page, shellFor } from "../html";

export async function capturePage(env: Env): Promise<Response> {
  const shell = await shellFor(env.DB, "capture");
  const body = `
<h1 class="page-title">Capture</h1>
<form id="cap" class="form">
  <div class="field">
    <label for="text">What's worth keeping?</label>
    <textarea class="input capture-box" id="text" required></textarea>
  </div>
  <div class="attach-row">
    <div class="field">
      <label for="topic">Topic (optional)</label>
      <div class="topic-picker" id="topic-picker">
        <input class="input" type="text" id="topic" placeholder="New or existing topic" autocomplete="off">
      </div>
    </div>
    <label class="btn btn-secondary"><i class="ph ph-camera"></i> Photo<input type="file" id="photo" accept="image/*" hidden></label>
  </div>
  <div class="form-actions">
    <button class="btn btn-primary" type="submit">Save</button>
    <span class="flash" id="flash"></span>
  </div>
</form>
<h6 class="kicker">Today <span class="count" id="today-count"></span></h6>
<div class="rows" id="today"></div>`;
  return page("Capture", body, {
    script: ["/static/topic-picker.js", "/static/capture.js"],
    shell
  });
}

export async function captureApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<{ text?: string; url?: string; title?: string; note?: string; image_id?: string; topic?: string }>()
    .catch(() => null);
  const text = (b?.text ?? "").trim();
  if (!text) return Response.json({ error: "text required" }, { status: 400 });
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO captures (id, created_at, text, url, title, note, image_id, topic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, nowIso(), text, b?.url ?? null, b?.title ?? null, b?.note ?? null, b?.image_id ?? null,
         b?.topic?.trim() || null).run();
  return Response.json({ ok: true, id, ...(await navCounts(env.DB)) });
}

export async function capturesToday(env: Env): Promise<Response> {
  const now = new Date();
  const settings = await getSettings(env.DB);
  // Widen the SQL filter to the last 48h (cheap, timezone-agnostic index scan), then
  // narrow to "today" in the user's own timezone in JS — a UTC day boundary would
  // misclassify captures made near midnight local time.
  const cutoff = new Date(now.getTime() - 48 * 3600_000).toISOString();
  const rows = await env.DB.prepare(
    "SELECT id, text, created_at FROM captures WHERE status='pending' AND created_at >= ? ORDER BY created_at DESC"
  ).bind(cutoff).all<{ id: string; text: string; created_at: string }>();
  const today = localDate(now, settings.timezone);
  const items = rows.results.filter(r => localDate(new Date(r.created_at), settings.timezone) === today);
  return Response.json({ items });
}

/**
 * Every topic, most recently used first (last prompt touched, falling back to
 * the topic's own creation). The picker filters client-side — at single-user
 * scale the whole list is cheaper than a query per keystroke.
 */
export async function topicsApi(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(`
    SELECT t.id, t.name, COUNT(p.id) AS count,
           COALESCE(MAX(p.updated_at), t.created_at) AS last_used
    FROM topics t LEFT JOIN prompts p ON p.topic_id = t.id
    GROUP BY t.id ORDER BY last_used DESC`
  ).all<{ id: string; name: string; count: number }>();
  return Response.json({ items: rows.results.map(r => ({ id: r.id, name: r.name, count: r.count })) });
}
