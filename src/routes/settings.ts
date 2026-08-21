import type { Env } from "../env.d";
import { getSettings, setSetting } from "../db";
import { page } from "../html";

export async function settingsPage(env: Env): Promise<Response> {
  const s = await getSettings(env.DB);
  const body = `
<nav><a href="/">Review</a> <a href="/capture">Capture</a> <a href="/inbox">Inbox</a> <a href="/browse">Browse</a> <a href="/settings">Settings</a></nav>
<h1>Settings</h1>
<form onsubmit="return saveSettings(event)">
  <label>Session cap</label><input type="text" id="session_cap" value="${s.session_cap}">
  <label>Desired retention (0.7–0.97)</label><input type="text" id="desired_retention" value="${s.desired_retention}">
  <label>Reminder hour (0–23, local)</label><input type="text" id="email_hour" value="${s.email_hour}">
  <label>Timezone</label><input type="text" id="timezone" value="${s.timezone}">
  <div class="btnrow"><button class="primary">Save</button></div>
  <p class="flash" id="flash"></p>
</form>
<h2>Data</h2>
<p><a href="/export.zip">Download everything</a></p>
<form method="post" action="/import?apply=0" onsubmit="return doImport(event)">
  <label>Import zip (dry-run first)</label>
  <input type="file" id="zipfile" accept=".zip">
  <div class="btnrow"><button id="dry">Dry-run</button><button id="apply" class="primary">Apply</button></div>
  <pre id="importout"></pre>
</form>
<script>
async function saveSettings(e) {
  e.preventDefault();
  const body = {
    session_cap: parseInt(document.getElementById("session_cap").value, 10),
    desired_retention: parseFloat(document.getElementById("desired_retention").value),
    email_hour: parseInt(document.getElementById("email_hour").value, 10),
    timezone: document.getElementById("timezone").value.trim()
  };
  const res = await fetch("/api/settings", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  document.getElementById("flash").textContent = res.ok ? "Saved ✓" : (await res.json()).error;
  return false;
}
async function doImport(e) {
  e.preventDefault();
  const f = document.getElementById("zipfile").files[0];
  if (!f) return false;
  const apply = e.submitter && e.submitter.id === "apply" ? 1 : 0;
  const res = await fetch("/import?apply=" + apply, { method: "POST", body: f });
  document.getElementById("importout").textContent = JSON.stringify(await res.json(), null, 2);
  return false;
}
</script>`;
  return page("Settings", body);
}

export async function settingsApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<{ session_cap?: number; desired_retention?: number; email_hour?: number; timezone?: string }>()
    .catch(() => null);
  if (!b) return Response.json({ error: "bad body" }, { status: 400 });
  if (!Number.isInteger(b.session_cap) || b.session_cap! < 1 || b.session_cap! > 100)
    return Response.json({ error: "session_cap must be an integer 1–100" }, { status: 400 });
  if (typeof b.desired_retention !== "number" || b.desired_retention < 0.7 || b.desired_retention > 0.97)
    return Response.json({ error: "desired_retention must be 0.7–0.97" }, { status: 400 });
  if (!Number.isInteger(b.email_hour) || b.email_hour! < 0 || b.email_hour! > 23)
    return Response.json({ error: "email_hour must be 0–23" }, { status: 400 });
  try { new Intl.DateTimeFormat("en-US", { timeZone: b.timezone }); }
  catch { return Response.json({ error: "unknown timezone" }, { status: 400 }); }

  await setSetting(env.DB, "session_cap", String(b.session_cap));
  await setSetting(env.DB, "desired_retention", String(b.desired_retention));
  await setSetting(env.DB, "email_hour", String(b.email_hour));
  await setSetting(env.DB, "timezone", b.timezone!);
  return Response.json({ ok: true });
}
