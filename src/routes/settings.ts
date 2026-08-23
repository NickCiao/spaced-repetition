import type { Env } from "../env.d";
import { getSettings, setSetting } from "../db";
import { escapeHtml, page } from "../html";

export async function settingsPage(env: Env): Promise<Response> {
  const s = await getSettings(env.DB);
  const body = `
<nav><a href="/">Review</a> <a href="/capture">Capture</a> <a href="/inbox">Inbox</a> <a href="/browse">Browse</a> <a href="/settings">Settings</a></nav>
<h1>Settings</h1>
<form id="settings-form">
  <label>Session cap</label><input type="text" id="session_cap" value="${s.session_cap}">
  <label>Desired retention (0.7–0.97)</label><input type="text" id="desired_retention" value="${s.desired_retention}">
  <label>Reminder hour (0–23, local)</label><input type="text" id="email_hour" value="${s.email_hour}">
  <label>Timezone</label><input type="text" id="timezone" value="${escapeHtml(s.timezone)}">
  <div class="btnrow"><button class="primary">Save</button></div>
  <p class="flash" id="flash"></p>
</form>

<div class="settings-section">
  <h2>Backup</h2>
  <p class="source section-lead">Full snapshot for safekeeping, or the first step of the refactor loop (export → edit → import).</p>
  <div class="card backup-card">
    <a href="/export.zip" class="backup-export-link">
      <span>
        <strong>Export everything</strong>
        <span class="source">export.zip — prompts, assets, log</span>
      </span>
      <span class="backup-export-icon" aria-hidden="true">↓</span>
    </a>
  </div>
</div>

<div class="settings-section">
  <h2>Import</h2>
  <p class="source section-lead">What do you want to do?</p>
  <div class="card import-card">
    <div class="segmented" role="tablist" aria-label="Import intent">
      <button type="button" class="segmented-btn active" data-mode="native" role="tab" aria-selected="true">Restore / refactor</button>
      <button type="button" class="segmented-btn" data-mode="foreign" role="tab" aria-selected="false">Migrate in</button>
    </div>
    <p class="import-blurb" id="import-blurb-text">Put back a zip you exported from this app, after editing offline.</p>
    <form id="import-form">
      <div class="file-drop">
        <div class="file-drop-inner">
          <div class="file-drop-text">
            <span class="file-drop-name" id="file-name">Select a file to import</span>
            <span class="file-drop-meta" id="file-meta" hidden></span>
            <span class="file-drop-hint" id="file-hint">.zip export from this app</span>
          </div>
          <label class="file-drop-btn">
            <input type="file" id="import-file" hidden>
            Choose file
          </label>
        </div>
      </div>
      <div class="import-field-slot">
        <div id="foreign-source-wrap" class="import-field-panel">
          <label>Source name (headerless Anki export)</label>
          <input type="text" id="foreignsource" value="Anki import">
        </div>
      </div>
      <p class="import-consequence" id="import-consequence">Can edit, add, and retire existing prompts. Preview first to see exactly what changes.</p>
      <div class="import-file-warn" id="import-file-warn" hidden>
        <span id="import-file-warn-text"></span>
        <button type="button" class="import-switch-btn" id="import-switch-btn"></button>
      </div>
      <div class="import-btnstack">
        <button type="submit" id="import-dry">Preview changes</button>
        <button type="submit" class="primary" id="import-apply">Apply changes</button>
      </div>
      <pre id="importout"></pre>
    </form>
  </div>
</div>`;
  return page("Settings", body, { script: "/static/settings.js" });
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
  if (typeof b.timezone !== "string" || !b.timezone.trim())
    return Response.json({ error: "timezone required" }, { status: 400 }); // undefined never throws in Intl
  try { new Intl.DateTimeFormat("en-US", { timeZone: b.timezone }); }
  catch { return Response.json({ error: "unknown timezone" }, { status: 400 }); }

  await setSetting(env.DB, "session_cap", String(b.session_cap));
  await setSetting(env.DB, "desired_retention", String(b.desired_retention));
  await setSetting(env.DB, "email_hour", String(b.email_hour));
  await setSetting(env.DB, "timezone", b.timezone!);
  return Response.json({ ok: true });
}
