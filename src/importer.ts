import { strFromU8, unzipSync } from "fflate";
import type { Env } from "./env.d";
import { newId, type CaptureRow, type PromptRow, type SourceRow } from "./db";
import { FormatError, parseSourceFile, type ParsedFile, type ParsedPrompt } from "./format";
import { applyGrade, newCardFields } from "./scheduler";

export class RestoreNotEmptyError extends Error {}

export type Diff = {
  newPrompts: { file: string; question: string }[];
  edited: string[];
  retired: string[];
  newSources: string[];
  errors: string[];
};

type Parsed = { path: string; file: ParsedFile }[];

function parseAll(files: Record<string, Uint8Array>): { parsed: Parsed; errors: string[] } {
  const parsed: Parsed = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith("prompts/") || !path.endsWith(".md")) continue;
    try {
      const file = parseSourceFile(strFromU8(bytes), path);
      for (const p of file.prompts) {
        if (p.id) {
          if (seenIds.has(p.id)) errors.push(`${path}: duplicate id ${p.id} across files`);
          else seenIds.add(p.id);
        }
      }
      parsed.push({ path, file });
    } catch (e) {
      errors.push(e instanceof FormatError ? e.message : `${path}: ${String(e)}`);
    }
  }
  return { parsed, errors };
}

export async function computeImportDiff(env: Env, files: Record<string, Uint8Array>): Promise<Diff> {
  const { parsed, errors } = parseAll(files);
  const diff: Diff = { newPrompts: [], edited: [], retired: [], newSources: [], errors };

  const existing = (await env.DB.prepare("SELECT * FROM prompts WHERE retired = 0").all<PromptRow>()).results;
  const byId = new Map(existing.map(p => [p.id, p]));
  const sources = (await env.DB.prepare("SELECT * FROM sources").all<SourceRow>()).results;
  const sourceByName = new Map(sources.map(s => [s.name, s]));
  const seen = new Set<string>();

  for (const { path, file } of parsed) {
    if (!sourceByName.has(file.name)) diff.newSources.push(file.name);
    for (const p of file.prompts) {
      if (!p.id) { diff.newPrompts.push({ file: path, question: p.question.slice(0, 60) }); continue; }
      const cur = byId.get(p.id);
      if (!cur) { diff.errors.push(`${path}: unknown id ${p.id} (not in this database)`); continue; }
      seen.add(p.id);
      const curSourceName = sources.find(s => s.id === cur.source_id)?.name;
      if (cur.kind !== p.kind || cur.question !== p.question || cur.answer !== p.answer || curSourceName !== file.name) {
        diff.edited.push(p.id);
      }
    }
  }
  for (const p of existing) if (!seen.has(p.id)) diff.retired.push(p.id);
  return diff;
}

export async function applyImport(
  env: Env, files: Record<string, Uint8Array>, now: Date
): Promise<{ new: number; edited: number; retired: number }> {
  const diff = await computeImportDiff(env, files);
  if (diff.errors.length) throw new Error(diff.errors.join("; "));
  const { parsed } = parseAll(files);
  const ts = now.toISOString();
  let created = 0, edited = 0;

  for (const { file } of parsed) {
    let source = await env.DB.prepare("SELECT * FROM sources WHERE name = ?").bind(file.name).first<SourceRow>();
    if (!source) {
      const sid = newId();
      await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(sid, file.name, file.url, JSON.stringify(file.meta), ts).run();
      source = { id: sid, name: file.name, url: file.url, meta: JSON.stringify(file.meta), created_at: ts };
    } else {
      await env.DB.prepare("UPDATE sources SET url = ?, meta = ? WHERE id = ?")
        .bind(file.url, JSON.stringify(file.meta), source.id).run();
    }
    let pos = 0;
    for (const p of file.prompts) {
      if (p.id) {
        await env.DB.prepare(
          "UPDATE prompts SET source_id=?, kind=?, question=?, answer=?, position=?, updated_at=? WHERE id=?"
        ).bind(source.id, p.kind, p.question, p.answer, pos++, ts, p.id).run();
        if (diff.edited.includes(p.id)) edited++;
      } else {
        const f = newCardFields(now);
        await env.DB.prepare(
          `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
            due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(newId(), source.id, p.kind, p.question, p.answer, pos++, ts, ts,
               f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
               f.reps, f.lapses, f.state, f.last_review).run();
        created++;
      }
    }
  }
  for (const id of diff.retired) {
    await env.DB.prepare("UPDATE prompts SET retired = 1, updated_at = ? WHERE id = ?").bind(ts, id).run();
  }
  return { new: created, edited, retired: diff.retired.length };
}

type LogLine = { ts: string; prompt_id: string; action: string; elapsed_days: number | null; state_after: unknown };

export async function restoreFromZip(
  env: Env, files: Record<string, Uint8Array>, now: Date
): Promise<{ sources: number; prompts: number; events: number }> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts").first<{ n: number }>();
  if ((count?.n ?? 0) > 0) throw new RestoreNotEmptyError("database is not empty");

  const { parsed, errors } = parseAll(files);
  for (const { path, file } of parsed) {
    for (const p of file.prompts) if (!p.id) errors.push(`${path}: restore requires every prompt to carry an id`);
  }
  if (errors.length) throw new Error(errors.join("; "));

  const settings = files["settings.json"]
    ? JSON.parse(strFromU8(files["settings.json"])) as { desired_retention?: number } : {};
  const retention = settings.desired_retention ?? 0.9;

  const log: LogLine[] = files["log/reviews.jsonl"]
    ? strFromU8(files["log/reviews.jsonl"]).trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
    : [];
  const eventsByPrompt = new Map<string, LogLine[]>();
  for (const e of log) {
    if (!eventsByPrompt.has(e.prompt_id)) eventsByPrompt.set(e.prompt_id, []);
    eventsByPrompt.get(e.prompt_id)!.push(e);
  }

  let nSources = 0, nPrompts = 0;
  for (const { file } of parsed) {
    const sid = newId();
    await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(sid, file.name, file.url, JSON.stringify(file.meta), now.toISOString()).run();
    nSources++;
    let pos = 0;
    for (const p of file.prompts as (ParsedPrompt & { id: string })[]) {
      const evs = (eventsByPrompt.get(p.id) ?? []).sort((a, b) => a.ts.localeCompare(b.ts));
      const birth = evs.length ? new Date(evs[0].ts) : now;
      let f = newCardFields(birth);
      let retired = 0;
      for (const e of evs) {
        if (e.action === "remembered" || e.action === "forgot") f = applyGrade(f, e.action, new Date(e.ts), retention);
        if (e.action === "retire") retired = 1;
      }
      await env.DB.prepare(
        `INSERT INTO prompts (id, source_id, kind, question, answer, position, retired, created_at, updated_at,
          due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(p.id, sid, p.kind, p.question, p.answer, pos++, retired,
             birth.toISOString(), now.toISOString(),
             f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
             f.reps, f.lapses, f.state, f.last_review).run();
      nPrompts++;
    }
  }

  for (const e of log) {
    await env.DB.prepare(
      "INSERT INTO events (ts, prompt_id, action, elapsed_days, state_after) VALUES (?, ?, ?, ?, ?)"
    ).bind(e.ts, e.prompt_id, e.action, e.elapsed_days,
           e.state_after ? JSON.stringify(e.state_after) : null).run();
  }

  for (const [path, bytes] of Object.entries(files)) {
    const m = path.match(/^inbox\/([a-z0-9]{10})\.md$/);
    if (!m) continue;
    const text = strFromU8(bytes);
    const fm = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
    const fields: Record<string, string> = {};
    if (fm) for (const line of fm[1].split("\n")) {
      const kv = line.match(/^([a-z]+): (.*)$/);
      if (kv) fields[kv[1]] = kv[2];
    }
    await env.DB.prepare(
      "INSERT INTO captures (id, created_at, text, url, title, note, image_id) VALUES (?, ?, ?, ?, ?, NULL, ?)"
    ).bind(m[1], fields["captured"] ?? now.toISOString(), (fm ? fm[2] : text).trim(),
           fields["url"] ?? null, fields["title"] ?? null, fields["image"] ?? null).run();
  }

  const index = files["assets/index.json"]
    ? JSON.parse(strFromU8(files["assets/index.json"])) as Record<string, string> : {};
  for (const [id, contentType] of Object.entries(index)) {
    const bytes = files[`assets/${id}`];
    if (!bytes) continue;
    await env.BUCKET.put(id, bytes, { httpMetadata: { contentType } });
    await env.DB.prepare(
      "INSERT OR IGNORE INTO assets (id, content_type, bytes, created_at) VALUES (?, ?, ?, ?)"
    ).bind(id, contentType, bytes.byteLength, now.toISOString()).run();
  }

  if (files["settings.json"]) {
    const s = JSON.parse(strFromU8(files["settings.json"])) as Record<string, unknown>;
    for (const k of ["session_cap", "desired_retention", "email_hour", "timezone"]) {
      if (s[k] !== undefined) {
        await env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).bind(k, String(s[k])).run();
      }
    }
  }
  return { sources: nSources, prompts: nPrompts, events: log.length };
}
