import type { Env } from "../env.d";
import { getSettings, newId, nowIso, type CaptureRow, type PromptRow, type SourceRow } from "../db";
import { newCardFields } from "../scheduler";
import { renderPromptAnswer, renderPromptQuestion } from "../markdown";
import { captureCardMeta, captureRowMeta, escapeHtml, page, shellFor } from "../html";

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
  const sourceGuess = cap.title ?? "";
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
  data-source-name="${escapeHtml(sourceGuess)}"
  data-source-url="${escapeHtml(cap.url ?? "")}"></div>`;
  return page("Refine", body, { script: "/static/refine.js", shell });
}

type RefineBody = {
  capture_id?: string;
  source?: { id?: string; name?: string; url?: string };
  prompts?: { kind: "qa" | "cloze"; question: string; answer: string }[];
};

export async function refineApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<RefineBody>().catch(() => null);
  if (!b?.capture_id || !b.source || !b.prompts?.length) {
    return Response.json({ error: "capture_id, source, prompts required" }, { status: 400 });
  }
  for (const p of b.prompts) {
    if (p.kind !== "qa" && p.kind !== "cloze") return Response.json({ error: "bad kind" }, { status: 400 });
    if (!p.question?.trim()) return Response.json({ error: "question required" }, { status: 400 });
    if (p.kind === "cloze" && !/\{\{[\s\S]+?\}\}/.test(p.question))
      return Response.json({ error: "cloze needs at least one {{span}}" }, { status: 400 });
    if (p.kind === "qa" && !p.answer?.trim())
      return Response.json({ error: "answer required for qa" }, { status: 400 });
  }
  if (!b.source.id && !b.source.name?.trim()) {
    return Response.json({ error: "source name required" }, { status: 400 });
  }
  const cap = await env.DB.prepare("SELECT * FROM captures WHERE id = ?").bind(b.capture_id).first<CaptureRow>();
  if (!cap) return Response.json({ error: "unknown capture" }, { status: 404 });

  // Atomic claim: exactly one concurrent refine can consume a capture.
  const claim = await env.DB.prepare(
    "UPDATE captures SET status = 'consumed' WHERE id = ? AND status = 'pending'"
  ).bind(cap.id).run();
  if (!claim.meta.changes) return Response.json({ error: "already consumed" }, { status: 409 });

  try {
    const ts = nowIso();
    let sourceId = b.source.id ?? null;
    if (!sourceId) {
      const existing = await env.DB.prepare("SELECT id FROM sources WHERE name = ?")
        .bind(b.source.name!.trim()).first<SourceRow>();
      if (existing) sourceId = existing.id;
      else {
        sourceId = newId();
        await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, ?, ?, '{}', ?)")
          .bind(sourceId, b.source.name!.trim(), b.source.url || null, ts).run();
      }
    }

    const posRow = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM prompts WHERE source_id = ?")
      .bind(sourceId).first<{ p: number }>();
    let pos = (posRow?.p ?? -1) + 1;

    const ids: string[] = [];
    const stmts = b.prompts.map((p) => {
      const id = newId();
      ids.push(id);
      const f = newCardFields(new Date());
      return env.DB.prepare(
        `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
          due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, sourceId, p.kind, p.question.replace(/\s+$/, ""),
             p.kind === "cloze" ? "" : (p.answer ?? "").replace(/\s+$/, ""), pos++, ts, ts,
             f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
             f.reps, f.lapses, f.state, f.last_review);
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

export async function previewApi(request: Request, env: Env): Promise<Response> {
  const b = await request.json<{ kind: "qa" | "cloze"; question: string; answer: string }>().catch(() => null);
  if (!b) return Response.json({ error: "bad body" }, { status: 400 });
  return Response.json({
    questionHtml: renderPromptQuestion(b.kind, b.question ?? ""),
    answerHtml: renderPromptAnswer(b.kind, b.question ?? "", b.answer ?? "")
  });
}
