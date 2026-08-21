import type { Env } from "../env.d";
import { newId, nowIso, type PromptRow, type SourceRow } from "../db";
import { newCardFields } from "../scheduler";
import { escapeHtml, page } from "../html";

const NAV = `<nav><a href="/">Review</a> <a href="/capture">Capture</a> <a href="/inbox">Inbox</a> <a href="/browse">Browse</a> <a href="/settings">Settings</a></nav>`;

export async function browseIndex(env: Env): Promise<Response> {
  const rows = (await env.DB.prepare(`
    SELECT s.id, s.name, COUNT(p.id) AS n
    FROM sources s LEFT JOIN prompts p ON p.source_id = s.id AND p.retired = 0
    GROUP BY s.id ORDER BY s.created_at DESC`).all<{ id: string; name: string; n: number }>()).results;
  const body = `${NAV}<h1>Browse</h1>` + (rows.map(r =>
    `<div class="item"><a href="/browse/${r.id}">${escapeHtml(r.name)}</a> <span class="source">${r.n} prompts</span></div>`
  ).join("") || "<p class='source'>No sources yet.</p>");
  return page("Browse", body);
}

export async function browseSource(sourceId: string, env: Env): Promise<Response> {
  const src = await env.DB.prepare("SELECT * FROM sources WHERE id = ?").bind(sourceId).first<SourceRow>();
  if (!src) return new Response("not found", { status: 404 });
  const prompts = (await env.DB.prepare(
    "SELECT * FROM prompts WHERE source_id = ? ORDER BY position").bind(sourceId).all<PromptRow>()).results;
  const list = prompts.map(p => `
    <div class="item">
      <a href="/prompt/${p.id}">${escapeHtml(p.question.slice(0, 120))}</a>
      ${p.retired ? '<span class="source">retired</span>' : ""}
      ${p.flag_note ? '<span class="source">flagged</span>' : ""}
    </div>`).join("") || "<p class='source'>No prompts.</p>";
  const body = `${NAV}
<h1>${escapeHtml(src.name)}</h1>
${src.url ? `<p class="source"><a href="${escapeHtml(src.url)}">${escapeHtml(src.url)}</a></p>` : ""}
<div class="btnrow">
  <a class="btn" href="/?source=${src.id}">Review this source now</a>
  <a class="btn" href="/?source=${src.id}&ahead=1">Review ahead</a>
  <a class="btn" href="/prompt/new?source=${src.id}">+ prompt</a>
</div>
${list}`;
  return page(src.name, body);
}

export async function promptForm(idOrNew: string, request: Request, env: Env): Promise<Response> {
  let p: PromptRow | null = null;
  let sourceId = new URL(request.url).searchParams.get("source") ?? "";
  if (idOrNew !== "new") {
    p = await env.DB.prepare("SELECT * FROM prompts WHERE id = ?").bind(idOrNew).first<PromptRow>();
    if (!p) return new Response("not found", { status: 404 });
    sourceId = p.source_id;
  }
  const body = `${NAV}
<h1>${p ? "Edit prompt" : "New prompt"}</h1>
${p?.flag_note ? `<p class="source">flag: ${escapeHtml(p.flag_note)}</p>` : ""}
<form method="post" action="/api/prompt" onsubmit="return submitPrompt(event)">
  <input type="hidden" id="pid" value="${p?.id ?? ""}">
  <input type="hidden" id="sid" value="${sourceId}">
  <label>Kind</label>
  <select id="kind"><option value="qa"${p?.kind !== "cloze" ? " selected" : ""}>Q / A</option>
  <option value="cloze"${p?.kind === "cloze" ? " selected" : ""}>Cloze</option></select>
  <label>Question</label><textarea id="q">${escapeHtml(p?.question ?? "")}</textarea>
  <label>Answer</label><textarea id="a">${escapeHtml(p?.answer ?? "")}</textarea>
  <label><input type="checkbox" id="retired"${p?.retired ? " checked" : ""}> retired</label>
  <div class="btnrow"><button class="primary">Save</button></div>
  <p class="flash" id="flash"></p>
</form>
<script>
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
</script>`;
  return page(p ? "Edit prompt" : "New prompt", body);
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
  if (b.id) {
    const existing = await env.DB.prepare("SELECT id FROM prompts WHERE id = ?").bind(b.id).first();
    if (!existing) return Response.json({ error: "unknown prompt" }, { status: 404 });
    await env.DB.prepare(
      `UPDATE prompts SET kind=?, question=?, answer=?, retired=?, updated_at=?
        ${b.clear_flag ? ", flag_note=NULL" : ""} WHERE id=?`
    ).bind(b.kind, b.question, b.answer ?? "", b.retired ? 1 : 0, ts, b.id).run();
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
  ).bind(id, b.source_id, b.kind, b.question, b.answer ?? "", b.source_id, ts, ts,
         f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
         f.reps, f.lapses, f.state, f.last_review).run();
  return Response.json({ ok: true, id });
}
