import type { Env } from "../env.d";
import { insertPromptStmt, insertTopic, newId, nowIso, type PromptRow, type TopicRow } from "../db";
import { normalizePromptInput, normalizeSourceInput, validatePromptInput, validateSourceInput } from "../format";
import { newCardFields } from "../scheduler";
import { escapeHtml, hostOnly, jsonForScript, navCounts, page, shellFor } from "../html";

export async function browseIndex(env: Env): Promise<Response> {
  const shell = await shellFor(env.DB, "browse");
  const rows = (await env.DB.prepare(`
    SELECT t.id, t.name, COUNT(p.id) AS n
    FROM topics t LEFT JOIN prompts p ON p.topic_id = t.id AND p.retired = 0
    GROUP BY t.id ORDER BY t.created_at DESC`).all<{ id: string; name: string; n: number }>()).results;
  const list = rows.map(r =>
    `<div class="row">
      <div class="row-main"><div class="row-text"><a href="/browse/${r.id}">${escapeHtml(r.name)}</a></div></div>
      <span class="row-count">${r.n} prompts</span>
    </div>`
  ).join("") || "<p class='empty'>No topics yet.</p>";
  // Names feed the duplicate hint client-side.
  const names = jsonForScript(rows.map(r => ({ id: r.id, name: r.name })));
  const body = `
<div class="page-head">
  <h1 class="page-title" style="margin:0">Browse</h1>
  <button type="button" class="btn btn-secondary" id="new-topic"><i class="ph ph-plus"></i> New topic</button>
</div>
<div class="rows">
  <div class="row row-create" id="create-row" hidden>
    <div class="form-grid">
      <div class="field">
        <label for="nt-name">Name</label>
        <input class="input" type="text" id="nt-name" placeholder="Project, theme, book…" autocomplete="off">
      </div>
      <div class="field">
        <label for="nt-url">URL <span class="note">— optional</span></label>
        <input class="input" type="text" id="nt-url" placeholder="https://…" autocomplete="off">
      </div>
    </div>
    <p class="field-hint" id="nt-hint" hidden></p>
    <div class="form-actions" style="margin-top:0">
      <button type="button" class="btn btn-primary" id="nt-create">Create</button>
      <button type="button" class="btn btn-ghost" id="nt-cancel">Cancel</button>
      <p class="flash" id="nt-flash"></p>
    </div>
  </div>
  ${list}
</div>
<script>
const TOPICS = ${names};
const row = document.getElementById("create-row");
const nameEl = document.getElementById("nt-name"), urlEl = document.getElementById("nt-url");
const hint = document.getElementById("nt-hint"), flash = document.getElementById("nt-flash");
function toggle(open) {
  row.hidden = !open;
  if (open) nameEl.focus();
  else { nameEl.value = ""; urlEl.value = ""; flash.textContent = ""; hint.hidden = true; }
}
document.getElementById("new-topic").onclick = () => toggle(row.hidden);
document.getElementById("nt-cancel").onclick = () => toggle(false);
nameEl.oninput = () => {
  flash.textContent = "";
  const dup = TOPICS.find(t => t.name.toLowerCase() === nameEl.value.trim().toLowerCase());
  hint.hidden = !dup;
  if (dup) hint.textContent = "\\u201C" + dup.name + "\\u201D already exists — Create will open it.";
};
async function create() {
  const name = nameEl.value.trim();
  if (!name) { flash.textContent = "topic name required"; return; }
  const res = await fetch("/api/topic", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, url: urlEl.value.trim() || undefined }) });
  if (!res.ok) { flash.textContent = (await res.json()).error; return; }
  const body = await res.json();
  location.href = body.existed ? "/browse/" + body.id : "/prompt/new?topic=" + body.id;
}
document.getElementById("nt-create").onclick = create;
[nameEl, urlEl].forEach(el => el.onkeydown = (e) => {
  if (e.key === "Enter") { e.preventDefault(); create(); }
  if (e.key === "Escape") toggle(false);
});
</script>`;
  return page("Browse", body, { shell });
}

type TopicBody = { name?: string; url?: string };

export async function topicApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<TopicBody>().catch(() => null);
  const name = b?.name?.trim();
  if (!name) return Response.json({ error: "topic name required" }, { status: 400 });
  // Same dedupe as refineApi, but case-insensitive so "gwern" opens "Gwern"
  // instead of creating a near-duplicate (matches the client-side hint).
  const existing = await env.DB.prepare("SELECT id FROM topics WHERE name = ? COLLATE NOCASE")
    .bind(name).first<TopicRow>();
  if (existing) return Response.json({ ok: true, id: existing.id, existed: true });
  const id = await insertTopic(env.DB, { name, url: b?.url?.trim() || null, created_at: nowIso() });
  return Response.json({ ok: true, id, existed: false });
}

export async function browseTopic(topicId: string, env: Env): Promise<Response> {
  const shell = await shellFor(env.DB, "browse");
  const topic = await env.DB.prepare("SELECT * FROM topics WHERE id = ?").bind(topicId).first<TopicRow>();
  if (!topic) return new Response("not found", { status: 404 });
  const prompts = (await env.DB.prepare(
    "SELECT * FROM prompts WHERE topic_id = ? ORDER BY position").bind(topicId).all<PromptRow>()).results;
  const active = prompts.filter(p => !p.retired).length;
  const list = prompts.map(p => `
    <div class="row${p.retired ? " retired" : ""}">
      <div class="row-main"><div class="row-text"><a href="/prompt/${p.id}">${escapeHtml(p.question.slice(0, 120))}</a></div></div>
      ${p.flag_note ? '<span class="tag tag-outline">flagged</span>' : ""}
      ${p.retired ? '<span class="tag tag-neutral">retired</span>' : ""}
    </div>`).join("") ||
    `<p class='empty'>No prompts yet — add your first with <a href="/prompt/new?topic=${topic.id}">+ Prompt</a>.</p>`;
  const urlLine = topic.url && /^https?:\/\//i.test(topic.url)
    ? `<p class="topic-url"><a href="${escapeHtml(topic.url)}" target="_blank" rel="noopener">${escapeHtml(hostOnly(topic.url))}</a></p>`
    : "";
  const body = `
<a class="crumb" href="/browse"><i class="ph ph-arrow-left"></i> Browse</a>
<h1 class="page-title topic-title">${escapeHtml(topic.name)}</h1>
${urlLine}
<div class="topic-actions">
  <a class="btn btn-primary" href="/?topic=${topic.id}"><i class="ph ph-cards"></i> Review now</a>
  <a class="btn btn-secondary" href="/?topic=${topic.id}&ahead=1">Review ahead</a>
  <a class="btn btn-secondary" href="/prompt/new?topic=${topic.id}"><i class="ph ph-plus"></i> Prompt</a>
</div>
<h6 class="kicker">Prompts <span class="count">${active}</span></h6>
<div class="rows">${list}</div>`;
  return page(topic.name, body, { shell });
}

export async function promptForm(idOrNew: string, request: Request, env: Env): Promise<Response> {
  const shell = await shellFor(env.DB, "browse");
  let p: PromptRow | null = null;
  let topicId = new URL(request.url).searchParams.get("topic") ?? "";
  let topicName = "";
  if (idOrNew !== "new") {
    p = await env.DB.prepare("SELECT * FROM prompts WHERE id = ?").bind(idOrNew).first<PromptRow>();
    if (!p) return new Response("not found", { status: 404 });
    topicId = p.topic_id;
  } else {
    // Query param is attacker-reachable: require a well-formed id naming a real topic.
    if (!/^[a-z0-9]{10}$/.test(topicId)) return new Response("not found", { status: 404 });
    const topic = await env.DB.prepare("SELECT id, name FROM topics WHERE id = ?").bind(topicId).first<TopicRow>();
    if (!topic) return new Response("not found", { status: 404 });
    topicName = topic.name;
  }
  if (!topicName) {
    const topic = await env.DB.prepare("SELECT name FROM topics WHERE id = ?").bind(topicId).first<TopicRow>();
    topicName = topic?.name ?? "";
  }
  const flagCard = p?.flag_note ? `
<div class="card elev-sm context-card">
  <span class="card-kicker"><i class="ph ph-flag"></i> Flagged during review</span>
  <p class="context-text">${escapeHtml(p.flag_note)}</p>
  <span class="card-meta">Saving clears the flag.</span>
</div>` : "";
  const body = `
<a class="crumb" href="/browse/${escapeHtml(topicId)}"><i class="ph ph-arrow-left"></i> ${escapeHtml(topicName)}</a>
<h1 class="page-title">${p ? "Edit prompt" : "New prompt"}</h1>
${flagCard}
<form class="form" method="post" action="/api/prompt" onsubmit="return submitPrompt(event)">
  <input type="hidden" id="pid" value="${escapeHtml(p?.id ?? "")}">
  <input type="hidden" id="tid" value="${escapeHtml(topicId)}">
  <input type="hidden" id="kind" value="${p?.kind === "cloze" ? "cloze" : "qa"}">
  <div class="seg" role="tablist" aria-label="Prompt kind">
    <button type="button" class="seg-opt${p?.kind !== "cloze" ? " checked" : ""}" data-kind="qa" role="tab" aria-selected="${p?.kind !== "cloze" ? "true" : "false"}">Q / A</button>
    <button type="button" class="seg-opt${p?.kind === "cloze" ? " checked" : ""}" data-kind="cloze" role="tab" aria-selected="${p?.kind === "cloze" ? "true" : "false"}">Cloze</button>
  </div>
  <div class="field">
    <label for="q">Question</label>
    <textarea class="input" id="q">${escapeHtml(p?.question ?? "")}</textarea>
  </div>
  <div class="field" id="answer-field">
    <label for="a">Answer</label>
    <textarea class="input" id="a">${escapeHtml(p?.answer ?? "")}</textarea>
  </div>
  <div class="field">
    <label for="psource">Source <span class="note">— optional; where this came from, markdown links work</span></label>
    <input class="input" type="text" id="psource" value="${escapeHtml(p?.source ?? "")}" placeholder="[Title](https://…) or plain text" autocomplete="off">
  </div>
  <label class="check"><input type="checkbox" id="retired"${p?.retired ? " checked" : ""}> Retired <span class="note">hidden from review; recoverable</span></label>
  <div class="form-actions">
    <button type="submit" class="btn btn-primary">Save</button>
  </div>
  <p class="flash" id="flash"></p>
</form>
${p ? `<div class="danger">
  <button type="button" class="btn btn-secondary" id="delete-prompt">Delete permanently</button>
  <p class="danger-note">Removes this prompt and its review history. Cannot be undone.</p>
</div>` : ""}
<script>
function setKind(k) {
  document.getElementById("kind").value = k;
  document.querySelectorAll(".seg-opt").forEach(b => {
    const on = b.dataset.kind === k;
    b.classList.toggle("checked", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.getElementById("answer-field").style.display = k === "cloze" ? "none" : "";
}
document.querySelectorAll(".seg-opt").forEach(b => b.onclick = () => setKind(b.dataset.kind));
setKind(document.getElementById("kind").value);
async function submitPrompt(e) {
  e.preventDefault();
  const body = {
    id: document.getElementById("pid").value || undefined,
    topic_id: document.getElementById("tid").value,
    kind: document.getElementById("kind").value,
    question: document.getElementById("q").value,
    answer: document.getElementById("a").value,
    source: document.getElementById("psource").value,
    retired: document.getElementById("retired").checked,
    clear_flag: true
  };
  const res = await fetch("/api/prompt", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) location.href = "/browse/" + body.topic_id;
  else document.getElementById("flash").textContent = (await res.json()).error;
  return false;
}
${p ? `
document.getElementById("delete-prompt").onclick = async () => {
  if (!confirm("Delete this prompt permanently? Its review history will be gone and this cannot be undone.")) return;
  const res = await fetch("/api/prompt/${p.id}/delete", { method: "POST" });
  if (res.ok) location.href = "/browse/${p.topic_id}";
  else document.getElementById("flash").textContent = (await res.json()).error ?? "Delete failed";
};` : ""}
</script>`;
  return page(p ? "Edit prompt" : "New prompt", body, { shell });
}

type PromptBody = {
  id?: string; topic_id?: string; kind?: "qa" | "cloze"; question?: string;
  answer?: string; source?: string; retired?: boolean; clear_flag?: boolean;
};

export async function promptApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<PromptBody>().catch(() => null);
  if (!b?.topic_id) return Response.json({ error: "topic_id required" }, { status: 400 });
  const invalid = validatePromptInput(b);
  if (invalid) return Response.json({ error: invalid }, { status: 400 });
  const badSource = validateSourceInput(b.source);
  if (badSource) return Response.json({ error: badSource }, { status: 400 });
  const source = normalizeSourceInput(b.source);

  const ts = nowIso();
  const { question, answer } = normalizePromptInput(b);
  if (b.id) {
    const existing = await env.DB.prepare("SELECT id FROM prompts WHERE id = ?").bind(b.id).first();
    if (!existing) return Response.json({ error: "unknown prompt" }, { status: 404 });
    await env.DB.prepare(
      `UPDATE prompts SET kind=?, question=?, answer=?, source=?, retired=?, updated_at=?
        ${b.clear_flag ? ", flag_note=NULL" : ""} WHERE id=?`
    ).bind(b.kind, question, answer, source, b.retired ? 1 : 0, ts, b.id).run();
    return Response.json({ ok: true, id: b.id });
  }
  const id = newId();
  const posRow = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM prompts WHERE topic_id = ?")
    .bind(b.topic_id).first<{ p: number }>();
  await insertPromptStmt(env.DB, {
    id, topic_id: b.topic_id, kind: b.kind!, question, answer, source,
    position: posRow?.p ?? 0, created_at: ts, updated_at: ts
  }, newCardFields(new Date())).run();
  return Response.json({ ok: true, id });
}

export async function deletePrompt(id: string, env: Env): Promise<Response> {
  if (!/^[a-z0-9]{10}$/.test(id)) return new Response("not found", { status: 404 });
  const p = await env.DB.prepare("SELECT id FROM prompts WHERE id = ?").bind(id).first();
  if (!p) return Response.json({ error: "unknown prompt" }, { status: 404 });
  await env.DB.prepare("DELETE FROM events WHERE prompt_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM prompts WHERE id = ?").bind(id).run();
  return Response.json({ ok: true, ...(await navCounts(env.DB)) });
}
