import type { Env } from "../env.d";
import { getSettings, insertPromptStmt, insertTopic, newId, nowIso, type CaptureRow, type PromptRow, type TopicRow } from "../db";
import { normalizePromptInput, normalizeSourceInput, validatePromptInput, validateSourceInput } from "../format";
import { newCardFields } from "../scheduler";
import { renderPromptAnswer, renderPromptQuestion } from "../markdown";
import { captureCardMeta, captureRowMeta, escapeHtml, hostOnly, page, shellFor } from "../html";

export async function inboxPage(env: Env): Promise<Response> {
  const settings = await getSettings(env.DB);
  const shell = await shellFor(env.DB, "inbox");
  const caps = (await env.DB.prepare(
    "SELECT * FROM captures WHERE status = 'pending' ORDER BY created_at DESC"
  ).all<CaptureRow>()).results;
  const flagged = (await env.DB.prepare(
    "SELECT * FROM prompts WHERE flag_note IS NOT NULL AND retired = 0 ORDER BY updated_at DESC"
  ).all<PromptRow>()).results;

  const capHtml = caps.map(c => `
    <div class="row">
      <div class="row-main">
        <div class="row-text">${escapeHtml(c.text)}</div>
        ${c.note ? `<div class="row-meta"><span>note: ${escapeHtml(c.note)}</span></div>` : ""}
        ${captureRowMeta(c, settings.timezone)}
        ${c.image_id && /^[0-9a-f]{32}$/.test(c.image_id) ? `<img src="/assets/${c.image_id}" style="max-height:120px">` : ""}
      </div>
      <div class="row-side"><a class="act" href="/refine/${c.id}">Refine</a>
      <a onclick="fetch('/api/capture/${c.id}/delete',{method:'POST'}).then(()=>location.reload())">Delete</a></div>
    </div>`).join("") || "<p class='empty'>No captures waiting.</p>";

  const flagHtml = flagged.map(p => `
    <div class="row">
      <div class="row-main">
        <div class="row-text">${escapeHtml(p.question)}</div>
        <div class="row-meta"><span><i class="ph ph-flag"></i> ${escapeHtml(p.flag_note ?? "")}</span></div>
      </div>
      <div class="row-side"><a class="act" href="/prompt/${p.id}">Edit</a></div>
    </div>`).join("") || "<p class='empty'>No flagged prompts.</p>";

  const body = `
<h1 class="page-title">Inbox</h1>
<h6 class="kicker">Captures <span class="count">${caps.length}</span></h6>
<div class="rows">${capHtml}</div>
<h6 class="kicker">Flagged prompts <span class="count">${flagged.length}</span></h6>
<div class="rows">${flagHtml}</div>`;
  return page("Inbox", body, { shell });
}

export async function refinePage(captureId: string, env: Env): Promise<Response> {
  const settings = await getSettings(env.DB);
  const shell = await shellFor(env.DB, "inbox");
  const cap = await env.DB.prepare("SELECT * FROM captures WHERE id = ? AND status = 'pending'")
    .bind(captureId).first<CaptureRow>();
  if (!cap) return new Response("not found", { status: 404 });
  // Pre-rename captures stored the typed grouping text in `title` — treat it as
  // the topic guess when no explicit topic was captured.
  const topicGuess = cap.topic ?? cap.title ?? "";
  const sourceGuess = cap.url && /^https?:\/\//i.test(cap.url)
    ? `[${cap.title || hostOnly(cap.url)}](${cap.url})`
    : "";
  const metaParts = captureCardMeta(cap, settings.timezone);

  const body = `
<a class="crumb" href="/inbox"><i class="ph ph-arrow-left"></i> Inbox</a>
<h1 class="page-title">Refine</h1>
<div class="card elev-sm context-card">
  <span class="card-kicker">Capture</span>
  <p class="context-text">${escapeHtml(cap.text)}</p>
  ${metaParts}
  ${cap.image_id && /^[0-9a-f]{32}$/.test(cap.image_id) ? `<img src="/assets/${cap.image_id}">` : ""}
</div>
<div id="refine"
  data-capture="${cap.id}"
  data-topic-name="${escapeHtml(topicGuess)}"
  data-source="${escapeHtml(sourceGuess)}"></div>`;
  return page("Refine", body, { script: ["/static/topic-picker.js", "/static/refine.js"], shell });
}

type RefineBody = {
  capture_id?: string;
  topic?: { id?: string; name?: string };
  source?: string;
  prompts?: { kind: "qa" | "cloze"; question: string; answer: string }[];
};

export async function refineApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<RefineBody>().catch(() => null);
  if (!b?.capture_id || !b.topic || !b.prompts?.length) {
    return Response.json({ error: "capture_id, topic, prompts required" }, { status: 400 });
  }
  for (const p of b.prompts) {
    const invalid = validatePromptInput(p);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });
  }
  if (!b.topic.id && !b.topic.name?.trim()) {
    return Response.json({ error: "topic name required" }, { status: 400 });
  }
  const badSource = validateSourceInput(b.source);
  if (badSource) return Response.json({ error: badSource }, { status: 400 });
  const source = normalizeSourceInput(b.source);
  const cap = await env.DB.prepare("SELECT * FROM captures WHERE id = ?").bind(b.capture_id).first<CaptureRow>();
  if (!cap) return Response.json({ error: "unknown capture" }, { status: 404 });
  if (b.topic.id) {
    const t = await env.DB.prepare("SELECT id FROM topics WHERE id = ?").bind(b.topic.id).first<TopicRow>();
    if (!t) return Response.json({ error: "unknown topic" }, { status: 404 });
  }

  // Atomic claim: exactly one concurrent refine can consume a capture.
  const claim = await env.DB.prepare(
    "UPDATE captures SET status = 'consumed' WHERE id = ? AND status = 'pending'"
  ).bind(cap.id).run();
  if (!claim.meta.changes) return Response.json({ error: "already consumed" }, { status: 409 });

  try {
    const ts = nowIso();
    let topicId = b.topic.id ?? null;
    if (!topicId) {
      // Case-insensitive dedupe, matching /api/topic: refining into "gwern"
      // must reuse "Gwern" rather than create a near-duplicate.
      const existing = await env.DB.prepare("SELECT id FROM topics WHERE name = ? COLLATE NOCASE")
        .bind(b.topic.name!.trim()).first<TopicRow>();
      topicId = existing
        ? existing.id
        : await insertTopic(env.DB, { name: b.topic.name!.trim(), url: null, created_at: ts });
    }

    const posRow = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM prompts WHERE topic_id = ?")
      .bind(topicId).first<{ p: number }>();
    let pos = (posRow?.p ?? -1) + 1;

    const ids: string[] = [];
    const stmts = b.prompts.map((p) => {
      const id = newId();
      ids.push(id);
      const { question, answer } = normalizePromptInput(p);
      return insertPromptStmt(env.DB, {
        id, topic_id: topicId!, kind: p.kind, question, answer,
        source, // one capture, one provenance — shared by every prompt written from it
        position: pos++, created_at: ts, updated_at: ts
      }, newCardFields(new Date()));
    });
    await env.DB.batch(stmts); // all-or-nothing
    return Response.json({ ok: true, prompt_ids: ids });
  } catch {
    // Give the capture back so nothing is stranded half-consumed.
    await env.DB.prepare("UPDATE captures SET status = 'pending' WHERE id = ?").bind(cap.id).run();
    return Response.json({ error: "refine failed" }, { status: 500 });
  }
}

export async function deleteCapture(id: string, env: Env): Promise<Response> {
  await env.DB.prepare("DELETE FROM captures WHERE id = ? AND status = 'pending'").bind(id).run();
  return Response.json({ ok: true });
}

export async function previewApi(request: Request): Promise<Response> {
  const b = await request.json<{ kind: "qa" | "cloze"; question: string; answer: string }>().catch(() => null);
  if (!b) return Response.json({ error: "bad body" }, { status: 400 });
  return Response.json({
    questionHtml: renderPromptQuestion(b.kind, b.question ?? ""),
    answerHtml: renderPromptAnswer(b.kind, b.question ?? "", b.answer ?? "")
  });
}
