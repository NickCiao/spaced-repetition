import type { Env } from "../env.d";
import { newId, nowIso, type CaptureRow, type PromptRow, type SourceRow } from "../db";
import { newCardFields } from "../scheduler";
import { renderPromptAnswer, renderPromptQuestion } from "../markdown";
import { escapeHtml, page } from "../html";

export async function inboxPage(env: Env): Promise<Response> {
  const caps = (await env.DB.prepare(
    "SELECT * FROM captures WHERE status = 'pending' ORDER BY created_at DESC"
  ).all<CaptureRow>()).results;
  const flagged = (await env.DB.prepare(
    "SELECT * FROM prompts WHERE flag_note IS NOT NULL AND retired = 0 ORDER BY updated_at DESC"
  ).all<PromptRow>()).results;

  const capHtml = caps.map(c => `
    <div class="item">
      <div>${escapeHtml(c.text)}</div>
      ${c.image_id && /^[0-9a-f]{32}$/.test(c.image_id) ? `<img src="/assets/${c.image_id}" style="max-height:120px">` : ""}
      <div class="source">${escapeHtml(c.title ?? c.url ?? "")} · ${c.created_at.slice(0, 10)}</div>
      <div class="overflow"><a href="/refine/${c.id}">Refine</a>
      <a onclick="fetch('/api/capture/${c.id}/delete',{method:'POST'}).then(()=>location.reload())">Delete</a></div>
    </div>`).join("") || "<p class='source'>No captures waiting.</p>";

  const flagHtml = flagged.map(p => `
    <div class="item">
      <div>${escapeHtml(p.question)}</div>
      <div class="source">flag: ${escapeHtml(p.flag_note ?? "")}</div>
      <div class="overflow"><a href="/prompt/${p.id}">Edit</a></div>
    </div>`).join("") || "<p class='source'>No flagged prompts.</p>";

  const body = `
<nav><a href="/">Review</a> <a href="/capture">Capture</a> <a href="/inbox">Inbox</a> <a href="/browse">Browse</a> <a href="/settings">Settings</a></nav>
<h1>Inbox</h1>
<h2>Captures</h2>${capHtml}
<h2>Flagged prompts</h2>${flagHtml}`;
  return page("Inbox", body);
}

export async function refinePage(captureId: string, env: Env): Promise<Response> {
  const cap = await env.DB.prepare("SELECT * FROM captures WHERE id = ? AND status = 'pending'")
    .bind(captureId).first<CaptureRow>();
  if (!cap) return new Response("not found", { status: 404 });
  const sourceGuess = cap.title ?? "";
  const body = `
<nav><a href="/">Review</a> <a href="/capture">Capture</a> <a href="/inbox">Inbox</a> <a href="/browse">Browse</a> <a href="/settings">Settings</a></nav>
<h1>Refine</h1>
<div class="card"><div>${escapeHtml(cap.text)}</div>
${cap.image_id && /^[0-9a-f]{32}$/.test(cap.image_id) ? `<img src="/assets/${cap.image_id}">` : ""}
<div class="source">${escapeHtml(cap.title ?? "")} ${cap.url && /^https?:\/\//i.test(cap.url) ? `· <a href="${escapeHtml(cap.url)}">${escapeHtml(cap.url)}</a>` : ""}</div></div>
<div id="refine"
  data-capture="${cap.id}"
  data-source-name="${escapeHtml(sourceGuess)}"
  data-source-url="${escapeHtml(cap.url ?? "")}"></div>`;
  return page("Refine", body, { script: "/static/refine.js" });
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
      ).bind(id, sourceId, p.kind, p.question, p.answer ?? "", pos++, ts, ts,
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
