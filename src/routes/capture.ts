import type { Env } from "../env.d";
import { getSettings, newId, nowIso } from "../db";
import { localDate } from "../clock";
import { page } from "../html";

export function capturePage(): Response {
  const body = `
<nav><a href="/">Review</a> <a href="/capture">Capture</a> <a href="/inbox">Inbox</a> <a href="/browse">Browse</a> <a href="/settings">Settings</a></nav>
<h1>Capture</h1>
<form id="cap">
  <label for="text">What's worth keeping?</label>
  <textarea id="text" required></textarea>
  <label for="source">Source (optional)</label>
  <input type="text" id="source" list="source-list" autocomplete="off">
  <datalist id="source-list"></datalist>
  <label for="photo">Photo (optional)</label>
  <input type="file" id="photo" accept="image/*">
  <div class="btnrow"><button class="primary" type="submit">Save</button></div>
  <p class="flash" id="flash"></p>
</form>
<h2>Today</h2>
<div id="today"></div>`;
  return page("Capture", body, {
    extraHead: `<link rel="manifest" href="/static/manifest.webmanifest" crossorigin="use-credentials">`,
    script: "/static/capture.js"
  });
}

export async function captureApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<{ text?: string; url?: string; title?: string; note?: string; image_id?: string }>()
    .catch(() => null);
  const text = (b?.text ?? "").trim();
  if (!text) return Response.json({ error: "text required" }, { status: 400 });
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO captures (id, created_at, text, url, title, note, image_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, nowIso(), text, b?.url ?? null, b?.title ?? null, b?.note ?? null, b?.image_id ?? null).run();
  return Response.json({ ok: true, id });
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

export async function sourcesApi(request: Request, env: Env): Promise<Response> {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const rows = await env.DB.prepare(
    "SELECT id, name FROM sources WHERE name LIKE ? ORDER BY created_at DESC LIMIT 10"
  ).bind(`%${q}%`).all();
  return Response.json({ items: rows.results });
}
