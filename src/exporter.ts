import { zipSync, strToU8 } from "fflate";
import type { Env } from "./env.d";
import type { CaptureRow, EventRow, PromptRow, TopicRow } from "./db";
import { renderTopicFile, topicFileName } from "./format";
import { exportableSettings, getSettings } from "./db";

export async function buildExportZip(env: Env): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};

  const topics = (await env.DB.prepare("SELECT * FROM topics ORDER BY created_at").all<TopicRow>()).results;
  for (const t of topics) {
    const prompts = (await env.DB.prepare(
      "SELECT * FROM prompts WHERE topic_id = ? AND retired = 0 ORDER BY position"
    ).bind(t.id).all<PromptRow>()).results;
    files[topicFileName(t.name, t.id)] = strToU8(renderTopicFile(t, prompts));
  }

  // Retired prompts stay out of the authoring files (those must reflect the active,
  // editable set) but must not be lost from the export — archive them separately so
  // restore can rebuild the complete system state, not just what's currently active.
  const retired = (await env.DB.prepare(
    `SELECT p.id, p.kind, p.question, p.answer, p.source, p.position, t.name AS topic_name
     FROM prompts p JOIN topics t ON t.id = p.topic_id
     WHERE p.retired = 1 ORDER BY p.topic_id, p.position`
  ).all<{ id: string; kind: "qa" | "cloze"; question: string; answer: string; source: string | null; position: number; topic_name: string }>()).results;
  files["retired.jsonl"] = strToU8(retired.map(p => JSON.stringify({
    id: p.id, topic_name: p.topic_name, kind: p.kind, question: p.question, answer: p.answer,
    ...(p.source ? { source: p.source } : {}), position: p.position
  })).join("\n") + (retired.length ? "\n" : ""));

  const events = (await env.DB.prepare("SELECT * FROM events ORDER BY id").all<EventRow>()).results;
  files["log/reviews.jsonl"] = strToU8(events.map(e => JSON.stringify({
    ts: e.ts, prompt_id: e.prompt_id, action: e.action,
    elapsed_days: e.elapsed_days, state_after: e.state_after ? JSON.parse(e.state_after) : null
  })).join("\n") + (events.length ? "\n" : ""));

  const caps = (await env.DB.prepare("SELECT * FROM captures WHERE status = 'pending'").all<CaptureRow>()).results;
  for (const c of caps) {
    let front = `---\ncaptured: ${c.created_at}\n`;
    if (c.url) front += `url: ${c.url}\n`;
    if (c.title) front += `title: ${c.title}\n`;
    if (c.topic) front += `topic: ${c.topic}\n`;
    // Frontmatter is one value per line; a multi-line note is flattened to a single
    // line here (annotation, bounded loss — the note is a hint, not authored content).
    if (c.note) front += `note: ${c.note.replace(/\s*[\r\n]+\s*/g, " ")}\n`;
    if (c.image_id) front += `image: ${c.image_id}\n`;
    files[`inbox/${c.id}.md`] = strToU8(front + "---\n\n" + c.text + "\n");
  }

  const assets = (await env.DB.prepare("SELECT * FROM assets").all<{ id: string; content_type: string }>()).results;
  const index: Record<string, string> = {};
  for (const a of assets) {
    const obj = await env.BUCKET.get(a.id);
    if (obj) {
      files[`assets/${a.id}`] = new Uint8Array(await obj.arrayBuffer());
      index[a.id] = a.content_type;
    }
  }
  files["assets/index.json"] = strToU8(JSON.stringify(index, null, 2));

  files["settings.json"] = strToU8(JSON.stringify(exportableSettings(await getSettings(env.DB)), null, 2));
  return zipSync(files);
}
