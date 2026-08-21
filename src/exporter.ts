import { zipSync, strToU8 } from "fflate";
import type { Env } from "./env.d";
import type { CaptureRow, EventRow, PromptRow, SourceRow } from "./db";
import { renderSourceFile, sourceFileName } from "./format";
import { getSettings } from "./db";

export async function buildExportZip(env: Env): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};

  const sources = (await env.DB.prepare("SELECT * FROM sources ORDER BY created_at").all<SourceRow>()).results;
  for (const s of sources) {
    const prompts = (await env.DB.prepare(
      "SELECT * FROM prompts WHERE source_id = ? AND retired = 0 ORDER BY position"
    ).bind(s.id).all<PromptRow>()).results;
    files[sourceFileName(s.name, s.id)] = strToU8(renderSourceFile(s, prompts));
  }

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

  files["settings.json"] = strToU8(JSON.stringify(await getSettings(env.DB), null, 2));
  return zipSync(files);
}
