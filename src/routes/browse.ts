import type { Env } from "../env.d";
import { newId, nowIso, type PromptRow, type SourceRow } from "../db";
import { newCardFields } from "../scheduler";
import { escapeHtml, hostOnly, page, shellFor } from "../html";

export async function browseIndex(env: Env): Promise<Response> {
  const shell = await shellFor(env.DB, "browse");
  const rows = (await env.DB.prepare(`
    SELECT s.id, s.name, COUNT(p.id) AS n
    FROM sources s LEFT JOIN prompts p ON p.source_id = s.id AND p.retired = 0
    GROUP BY s.id ORDER BY s.created_at DESC`).all<{ id: string; name: string; n: number }>()).results;
  const list = rows.map(r =>
    `<div class="row">
      <div class="row-main"><div class="row-text"><a href="/browse/${r.id}">${escapeHtml(r.name)}</a></div></div>
      <span class="row-count">${r.n} prompts</span>
    </div>`
  ).join("") || "<p class='empty'>No sources yet.</p>";
  const body = `<h1 class="page-title">Browse</h1><div class="rows">${list}</div>`;
  return page("Browse", body, { shell });
}

export async function browseSource(sourceId: string, env: Env): Promise<Response> {
  const shell = await shellFor(env.DB, "browse");
  const src = await env.DB.prepare("SELECT * FROM sources WHERE id = ?").bind(sourceId).first<SourceRow>();
  if (!src) return new Response("not found", { status: 404 });
  const prompts = (await env.DB.prepare(
    "SELECT * FROM prompts WHERE source_id = ? ORDER BY position").bind(sourceId).all<PromptRow>()).results;
  const active = prompts.filter(p => !p.retired).length;
  const list = prompts.map(p => `
    <div class="row${p.retired ? " retired" : ""}">
      <div class="row-main"><div class="row-text"><a href="/prompt/${p.id}">${escapeHtml(p.question.slice(0, 120))}</a></div></div>
      ${p.flag_note ? '<span class="tag tag-outline">flagged</span>' : ""}
      ${p.retired ? '<span class="tag tag-neutral">retired</span>' : ""}
    </div>`).join("") || "<p class='empty'>No prompts.</p>";
  const urlLine = src.url && /^https?:\/\//i.test(src.url)
    ? `<p class="source-url"><a href="${escapeHtml(src.url)}" target="_blank" rel="noopener">${escapeHtml(hostOnly(src.url))}</a></p>`
    : "";
  const body = `
<a class="crumb" href="/browse"><i class="ph ph-arrow-left"></i> Browse</a>
<h1 class="page-title source-title">${escapeHtml(src.name)}</h1>
${urlLine}
<div class="source-actions">
  <a class="btn btn-primary" href="/?source=${src.id}"><i class="ph ph-cards"></i> Review now</a>
  <a class="btn btn-secondary" href="/?source=${src.id}&ahead=1">Review ahead</a>
  <a class="btn btn-secondary" href="/prompt/new?source=${src.id}"><i class="ph ph-plus"></i> Prompt</a>
</div>
<h6 class="kicker">Prompts <span class="count">${active}</span></h6>
<div class="rows">${list}</div>`;
  return page(src.name, body, { shell });
}

export async function promptForm(idOrNew: string, request: Request, env: Env): Promise<Response> {
  const shell = await shellFor(env.DB, "browse");
  let p: PromptRow | null = null;
  let sourceId = new URL(request.url).searchParams.get("source") ?? "";
  let sourceName = "";
  if (idOrNew !== "new") {
    p = await env.DB.prepare("SELECT * FROM prompts WHERE id = ?").bind(idOrNew).first<PromptRow>();
    if (!p) return new Response("not found", { status: 404 });
    sourceId = p.source_id;
  } else {
    // Query param is attacker-reachable: require a well-formed id naming a real source.
    if (!/^[a-z0-9]{10}$/.test(sourceId)) return new Response("not found", { status: 404 });
    const src = await env.DB.prepare("SELECT id, name FROM sources WHERE id = ?").bind(sourceId).first<SourceRow>();
    if (!src) return new Response("not found", { status: 404 });
    sourceName = src.name;
  }
  if (!sourceName) {
    const src = await env.DB.prepare("SELECT name FROM sources WHERE id = ?").bind(sourceId).first<SourceRow>();
    sourceName = src?.name ?? "";
  }
  const flagCard = p?.flag_note ? `
<div class="card elev-sm context-card">
  <span class="card-kicker"><i class="ph ph-flag"></i> Flagged during review</span>
  <p class="context-text">${escapeHtml(p.flag_note)}</p>
  <span class="card-meta">Saving clears the flag.</span>
</div>` : "";
  const body = `
<a class="crumb" href="/browse/${escapeHtml(sourceId)}"><i class="ph ph-arrow-left"></i> ${escapeHtml(sourceName)}</a>
<h1 class="page-title">${p ? "Edit prompt" : "New prompt"}</h1>
${flagCard}
<form class="form" method="post" action="/api/prompt" onsubmit="return submitPrompt(event)">
  <input type="hidden" id="pid" value="${escapeHtml(p?.id ?? "")}">
  <input type="hidden" id="sid" value="${escapeHtml(sourceId)}">
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
    source_id: document.getElementById("sid").value,
    kind: document.getElementById("kind").value,
    question: document.getElementById("q").value,
    answer: document.getElementById("a").value,
    retired: document.getElementById("retired").checked,
    clear_flag: true
  };
  const res = await fetch("/api/prompt", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) location.href = "/browse/" + body.source_id;
  else document.getElementById("flash").textContent = (await res.json()).error;
  return false;
}
${p ? `
document.getElementById("delete-prompt").onclick = async () => {
  if (!confirm("Delete this prompt permanently? Its review history will be gone and this cannot be undone.")) return;
  const res = await fetch("/api/prompt/${p.id}/delete", { method: "POST" });
  if (res.ok) location.href = "/browse/${p.source_id}";
  else document.getElementById("flash").textContent = (await res.json()).error ?? "Delete failed";
};` : ""}
</script>`;
  return page(p ? "Edit prompt" : "New prompt", body, { shell });
}

type PromptBody = {
  id?: string; source_id?: string; kind?: "qa" | "cloze"; question?: string;
  answer?: string; retired?: boolean; clear_flag?: boolean;
};

export async function promptApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<PromptBody>().catch(() => null);
  if (!b?.source_id || (b.kind !== "qa" && b.kind !== "cloze") || !b.question?.trim()) {
    return Response.json({ error: "source_id, kind, question required" }, { status: 400 });
  }
  if (b.kind === "cloze" && !/\{\{[\s\S]+?\}\}/.test(b.question))
    return Response.json({ error: "cloze needs at least one {{span}}" }, { status: 400 });
  if (b.kind === "qa" && !b.answer?.trim())
    return Response.json({ error: "answer required for qa" }, { status: 400 });

  const ts = nowIso();
  // Trailing whitespace is stripped at write, matching the tail-trimming the
  // interchange format already does on parse — otherwise a round-tripped export
  // would diff against the DB row and show up as a phantom dry-run edit.
  const question = b.question.replace(/\s+$/, "");
  const answer = b.kind === "cloze" ? "" : (b.answer ?? "").replace(/\s+$/, "");
  if (b.id) {
    const existing = await env.DB.prepare("SELECT id FROM prompts WHERE id = ?").bind(b.id).first();
    if (!existing) return Response.json({ error: "unknown prompt" }, { status: 404 });
    await env.DB.prepare(
      `UPDATE prompts SET kind=?, question=?, answer=?, retired=?, updated_at=?
        ${b.clear_flag ? ", flag_note=NULL" : ""} WHERE id=?`
    ).bind(b.kind, question, answer, b.retired ? 1 : 0, ts, b.id).run();
    return Response.json({ ok: true, id: b.id });
  }
  const id = newId();
  const f = newCardFields(new Date());
  await env.DB.prepare(
    `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
      due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
     VALUES (?, ?, ?, ?, ?,
       (SELECT COALESCE(MAX(position), -1) + 1 FROM prompts WHERE source_id = ?), ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, b.source_id, b.kind, question, answer, b.source_id, ts, ts,
         f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
         f.reps, f.lapses, f.state, f.last_review).run();
  return Response.json({ ok: true, id });
}

export async function deletePrompt(id: string, env: Env): Promise<Response> {
  if (!/^[a-z0-9]{10}$/.test(id)) return new Response("not found", { status: 404 });
  const p = await env.DB.prepare("SELECT id FROM prompts WHERE id = ?").bind(id).first();
  if (!p) return Response.json({ error: "unknown prompt" }, { status: 404 });
  await env.DB.prepare("DELETE FROM events WHERE prompt_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM prompts WHERE id = ?").bind(id).run();
  return Response.json({ ok: true });
}
