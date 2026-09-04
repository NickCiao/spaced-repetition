import type { Env } from "../env.d";
import { hourLabel, timeZoneOptions, timeZoneRegions } from "../clock";
import { getSettings, setSetting } from "../db";
import { escapeHtml, page, shellFor } from "../html";

function selectWrap(id: string, options: string): string {
  return `<div class="select-wrap">
      <select class="input" id="${id}">${options}</select>
      <i class="ph ph-caret-down" aria-hidden="true"></i>
    </div>`;
}

function hourSelect(selected: number): string {
  const options = Array.from({ length: 24 }, (_, h) => {
    const sel = h === selected ? " selected" : "";
    return `<option value="${h}"${sel}>${hourLabel(h)}</option>`;
  }).join("");
  return selectWrap("email_hour", options);
}

function timezoneSelect(selected: string): string {
  const zones = timeZoneOptions(selected);
  const byRegion = new Map<string, typeof zones>();
  for (const z of zones) {
    const list = byRegion.get(z.region) ?? [];
    list.push(z);
    byRegion.set(z.region, list);
  }
  const options = timeZoneRegions(zones).map(region => {
    const inner = (byRegion.get(region) ?? []).map(z => {
      const sel = z.id === selected ? " selected" : "";
      return `<option value="${escapeHtml(z.id)}"${sel}>${escapeHtml(z.label)}</option>`;
    }).join("");
    return `<optgroup label="${escapeHtml(region)}">${inner}</optgroup>`;
  }).join("");
  return selectWrap("timezone", options);
}

export async function settingsPage(env: Env): Promise<Response> {
  const s = await getSettings(env.DB);
  const shell = await shellFor(env.DB, "settings");
  const keyHint = s.resend_key_set
    ? "Key is set — leave blank to keep, or paste a new one to replace."
    : "From resend.com (free tier). Reminders stay off until this and Email to are set.";
  const body = `
<h1 class="page-title">Settings</h1>
<form id="settings-form" class="form">
  <h6 class="kicker">Scheduler</h6>
  <div class="form-grid">
    <div class="field"><label for="session_cap">Session cap</label><input class="input" type="text" id="session_cap" value="${s.session_cap}"></div>
    <div class="field"><label for="desired_retention">Desired retention (0.7–0.97)</label><input class="input" type="text" id="desired_retention" value="${s.desired_retention}"></div>
  </div>
  <h6 class="kicker">Reminder</h6>
  <div class="form-grid">
    <div class="field"><label for="email_hour">Hour</label>${hourSelect(s.email_hour)}</div>
    <div class="field"><label for="timezone">Timezone</label>${timezoneSelect(s.timezone)}</div>
  </div>
  <div class="form-grid">
    <div class="field"><label for="email_to">Email to</label><input class="input" type="email" id="email_to" value="${escapeHtml(s.email_to)}" placeholder="you@example.com" autocomplete="email"></div>
    <div class="field"><label for="resend_api_key">Resend API key</label><input class="input" type="password" id="resend_api_key" value="" placeholder="${s.resend_key_set ? "••••••••" : "re_…"}" autocomplete="off"><p class="field-hint">${keyHint}</p></div>
  </div>
  <div class="field"><label for="base_url">App URL</label><input class="input" type="url" id="base_url" value="${escapeHtml(s.base_url)}" placeholder="https://…workers.dev"><p class="field-hint">Auto-filled on first visit; override if you use a custom domain. Used as the link in reminder emails.</p></div>
  <div class="form-actions">
    <button type="submit" class="btn btn-primary">Save</button>
    <button type="button" class="btn btn-ghost" id="clear-resend" ${s.resend_key_set ? "" : "hidden"}>Clear API key</button>
    <span class="flash" id="flash"></span>
  </div>
</form>

<h6 class="kicker">Backup</h6>
<div class="card elev-sm">
  <a href="/export.zip" class="export-link">
    <span>
      <span class="export-title">Export everything</span>
      <span class="export-meta">export.zip — prompts, assets, review log</span>
    </span>
    <i class="ph ph-download-simple"></i>
  </a>
</div>

<h6 class="kicker">Import</h6>
<div class="card elev-sm import-card">
  <div class="seg" role="tablist" aria-label="Import intent">
    <button type="button" class="seg-opt checked" data-mode="native" role="tab" aria-selected="true">Restore / refactor</button>
    <button type="button" class="seg-opt" data-mode="foreign" role="tab" aria-selected="false">Migrate in</button>
  </div>
  <form id="import-form">
    <div class="file-row">
      <div>
        <div class="file-row-name" id="file-name">Select a file to import</div>
        <div class="file-row-hint" id="file-hint">.zip export from this app</div>
        <div class="file-row-hint" id="file-meta" hidden></div>
      </div>
      <label class="btn btn-secondary">Choose file<input type="file" id="import-file" hidden></label>
    </div>
    <div class="import-slot" id="import-slot">
      <div class="field" id="foreign-topic-wrap">
        <label for="foreigntopic">Topic name (headerless Anki export)</label>
        <input class="input" type="text" id="foreigntopic" value="Anki import">
      </div>
    </div>
    <p class="import-consequence" id="import-consequence">Can edit, add, and retire existing prompts — preview first.</p>
    <div class="import-warn" id="import-file-warn" hidden>
      <span id="import-file-warn-text"></span>
      <button type="button" class="btn btn-ghost" id="import-switch-btn"></button>
    </div>
    <div class="form-actions" style="margin-top:0">
      <button type="submit" class="btn btn-secondary" id="import-dry">Preview changes</button>
      <button type="submit" class="btn btn-primary" id="import-apply">Apply changes</button>
    </div>
    <pre class="import-out" id="importout"></pre>
  </form>
</div>`;
  return page("Settings", body, { script: "/static/settings.js", shell });
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function settingsApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<{
    session_cap?: number;
    desired_retention?: number;
    email_hour?: number;
    timezone?: string;
    email_to?: string;
    resend_api_key?: string;
    clear_resend_api_key?: boolean;
    base_url?: string;
  }>().catch(() => null);
  if (!b) return Response.json({ error: "bad body" }, { status: 400 });
  if (!Number.isInteger(b.session_cap) || b.session_cap! < 1 || b.session_cap! > 100)
    return Response.json({ error: "session_cap must be an integer 1–100" }, { status: 400 });
  if (typeof b.desired_retention !== "number" || b.desired_retention < 0.7 || b.desired_retention > 0.97)
    return Response.json({ error: "desired_retention must be 0.7–0.97" }, { status: 400 });
  if (!Number.isInteger(b.email_hour) || b.email_hour! < 0 || b.email_hour! > 23)
    return Response.json({ error: "email_hour must be 0–23" }, { status: 400 });
  if (typeof b.timezone !== "string" || !b.timezone.trim())
    return Response.json({ error: "timezone required" }, { status: 400 });
  try { new Intl.DateTimeFormat("en-US", { timeZone: b.timezone }); }
  catch { return Response.json({ error: "unknown timezone" }, { status: 400 }); }

  const emailTo = typeof b.email_to === "string" ? b.email_to.trim() : "";
  if (emailTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTo))
    return Response.json({ error: "email_to looks invalid" }, { status: 400 });

  const baseUrl = typeof b.base_url === "string" ? b.base_url.trim().replace(/\/$/, "") : "";
  if (baseUrl && !isHttpUrl(baseUrl))
    return Response.json({ error: "base_url must be an http(s) URL" }, { status: 400 });

  await setSetting(env.DB, "session_cap", String(b.session_cap));
  await setSetting(env.DB, "desired_retention", String(b.desired_retention));
  await setSetting(env.DB, "email_hour", String(b.email_hour));
  await setSetting(env.DB, "timezone", b.timezone!);
  await setSetting(env.DB, "email_to", emailTo);
  await setSetting(env.DB, "base_url", baseUrl);

  if (b.clear_resend_api_key) {
    await setSetting(env.DB, "resend_api_key", "");
  } else if (typeof b.resend_api_key === "string" && b.resend_api_key.trim()) {
    await setSetting(env.DB, "resend_api_key", b.resend_api_key.trim());
  }

  return Response.json({ ok: true });
}
