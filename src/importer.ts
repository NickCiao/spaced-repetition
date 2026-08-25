import { strFromU8 } from "fflate";
import type { Env } from "./env.d";
import { newId, type PromptRow, type SourceRow } from "./db";
import { FormatError, parseSourceFile, type ParsedFile, type ParsedPrompt } from "./format";
import {
  type ForeignImport, type ForeignPrompt, rewriteMediaRefs
} from "./interop";
import { applyGrade, newCardFields } from "./scheduler";
import { ALLOWED_TYPES } from "./routes/assets";

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

  // Load every prompt, retired included: a retired id showing back up in an upload
  // is an un-retire, not an "unknown id" — only an id matching no row at all is an error.
  const existing = (await env.DB.prepare("SELECT * FROM prompts").all<PromptRow>()).results;
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
      if (cur.retired) {
        diff.edited.push(p.id); // re-appearing in the upload un-retires it, regardless of content match
        continue;
      }
      const curSourceName = sources.find(s => s.id === cur.source_id)?.name;
      if (cur.kind !== p.kind || cur.question !== p.question || cur.answer !== p.answer || curSourceName !== file.name) {
        diff.edited.push(p.id);
      }
    }
  }
  // Only active prompts going missing counts as "would be retired" — a retired prompt
  // that's still absent from the upload simply stays retired, silently, not an event.
  for (const p of existing) if (!p.retired && !seen.has(p.id)) diff.retired.push(p.id);
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
        // retired=0 unconditionally: a prompt present in the upload is active by definition,
        // whether it was already active (no-op) or retired (this is what un-retires it).
        await env.DB.prepare(
          "UPDATE prompts SET source_id=?, kind=?, question=?, answer=?, position=?, retired=0, updated_at=? WHERE id=?"
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
type ArchiveLine = {
  id: string; source_name: string; kind: "qa" | "cloze"; question: string; answer: string; position: number;
};

// Best-effort: a failed restore must not leave a half-populated DB that then blocks a
// retry on the empty-prompts-table gate below. Order matches the FK-ish dependency
// (prompts reference sources); each delete is independent so one failing doesn't stop
// the rest.
// D1 rows only — R2 objects a failed restore already `put` are deliberately left alone:
// they're content-addressed, so a later re-put is just an idempotent overwrite, and with
// no `assets` row pointing at them they're simply unreferenced; the D1 tables are the
// consistency boundary, not the bucket.
async function wipeAll(env: Env): Promise<void> {
  for (const table of ["events", "prompts", "sources", "captures", "assets"]) {
    try { await env.DB.prepare(`DELETE FROM ${table}`).run(); } catch { /* best-effort */ }
  }
}


export type ForeignImportResult = {
  created: number;
  skipped: number;
  sources: { name: string; created: number; skipped: number }[];
  warnings: string[];
};

async function storeAsset(env: Env, bytes: Uint8Array, type: string, ts: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const id = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  const existing = await env.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(id).first();
  if (!existing) {
    await env.BUCKET.put(id, bytes, { httpMetadata: { contentType: type } });
    await env.DB.prepare(
      "INSERT INTO assets (id, content_type, bytes, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING"
    ).bind(id, type, bytes.byteLength, ts).run();
  }
  return id;
}

function promptKey(p: ForeignPrompt): string {
  return `${p.kind}\0${p.question}\0${p.answer}`;
}

export async function applyForeignImport(
  env: Env, data: ForeignImport, now: Date, apply: boolean
): Promise<ForeignImportResult> {
  const ts = now.toISOString();
  const warnings = [...data.warnings];
  const idByFile = new Map<string, string>();

  if (apply) {
    for (const [filename, att] of Object.entries(data.attachments)) {
      if (!ALLOWED_TYPES.has(att.type)) {
        warnings.push(`skipped unsupported attachment "${filename}"`);
        continue;
      }
      try {
        idByFile.set(filename, await storeAsset(env, att.bytes, att.type, ts));
      } catch {
        warnings.push(`failed to store attachment "${filename}"`);
      }
    }
  }

  let created = 0, skipped = 0;
  const sources: ForeignImportResult["sources"] = [];

  for (const deck of data.decks) {
    let deckCreated = 0, deckSkipped = 0;
    let source = await env.DB.prepare("SELECT * FROM sources WHERE name = ?").bind(deck.name).first<SourceRow>();

    const existingKeys = new Set<string>();
    if (source) {
      const rows = (await env.DB.prepare(
        "SELECT kind, question, answer FROM prompts WHERE source_id = ?"
      ).bind(source.id).all<{ kind: string; question: string; answer: string }>()).results;
      for (const r of rows) existingKeys.add(`${r.kind}\0${r.question}\0${r.answer}`);
    }

    let pos = source
      ? (await env.DB.prepare("SELECT MAX(position) AS m FROM prompts WHERE source_id = ?")
        .bind(source.id).first<{ m: number }>())?.m ?? -1
      : -1;

    for (const p of deck.prompts) {
      const question = rewriteMediaRefs(p.question, idByFile);
      const answer = rewriteMediaRefs(p.answer, idByFile);
      const prompt: ForeignPrompt = { kind: p.kind, question, answer };
      const key = promptKey(prompt);

      if (existingKeys.has(key)) {
        skipped++;
        deckSkipped++;
        continue;
      }

      if (!apply) {
        created++;
        deckCreated++;
        continue;
      }

      if (!source) {
        const sid = newId();
        await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(sid, deck.name, null, "{}", ts).run();
        source = { id: sid, name: deck.name, url: null, meta: "{}", created_at: ts };
      }

      const f = newCardFields(now);
      await env.DB.prepare(
        `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
          due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(newId(), source.id, prompt.kind, prompt.question, prompt.answer, ++pos, ts, ts,
        f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
        f.reps, f.lapses, f.state, f.last_review).run();
      existingKeys.add(key);
      created++;
      deckCreated++;
    }

    if (deckCreated || deckSkipped) sources.push({ name: deck.name, created: deckCreated, skipped: deckSkipped });
  }

  return { created, skipped, sources, warnings };
}

export async function restoreFromZip(
  env: Env, files: Record<string, Uint8Array>, now: Date
): Promise<{ sources: number; prompts: number; events: number }> {
  // This check — and only this check — must stay outside the try/wipe below: a 409
  // here means "there's real data already, leave it alone," not "restore failed."
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts").first<{ n: number }>();
  if ((count?.n ?? 0) > 0) throw new RestoreNotEmptyError("database is not empty");

  try {
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

    // FSRS replay is identical for active and archived prompts — only the final
    // `retired` flag differs, and it's now supplied by the caller (zip provenance),
    // never derived from a replayed `retire` event (un-retire writes no event, so
    // "ever had a retire event" is not the same as "is retired now").
    let nPrompts = 0;
    async function insertRestoredPrompt(
      id: string, sourceId: string, kind: "qa" | "cloze", question: string, answer: string,
      position: number, retired: number
    ): Promise<void> {
      const evs = (eventsByPrompt.get(id) ?? []).sort((a, b) => a.ts.localeCompare(b.ts));
      const birth = evs.length ? new Date(evs[0].ts) : now;
      let f = newCardFields(birth);
      for (const e of evs) {
        if (e.action === "remembered" || e.action === "forgot") f = applyGrade(f, e.action, new Date(e.ts), retention);
      }
      await env.DB.prepare(
        `INSERT INTO prompts (id, source_id, kind, question, answer, position, retired, created_at, updated_at,
          due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, sourceId, kind, question, answer, position, retired,
             birth.toISOString(), now.toISOString(),
             f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
             f.reps, f.lapses, f.state, f.last_review).run();
      nPrompts++;
    }

    // Active prompts: one authoring file per source (every source gets a file, even an
    // empty-bodied one, per buildExportZip), so this alone recreates every source row.
    let nSources = 0;
    const sourceIdByName = new Map<string, string>();
    for (const { file } of parsed) {
      const sid = newId();
      await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(sid, file.name, file.url, JSON.stringify(file.meta), now.toISOString()).run();
      sourceIdByName.set(file.name, sid);
      nSources++;
      let pos = 0;
      for (const p of file.prompts as (ParsedPrompt & { id: string })[]) {
        await insertRestoredPrompt(p.id, sid, p.kind, p.question, p.answer, pos++, 0);
      }
    }

    // Archived (retired) prompts: find their source by name (created above in the
    // common case — every source gets a file); create it only if that source turns out
    // to hold nothing but retired prompts and somehow got no file of its own.
    const archive: ArchiveLine[] = files["retired.jsonl"]
      ? strFromU8(files["retired.jsonl"]).trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
      : [];
    for (const a of archive) {
      let sid = sourceIdByName.get(a.source_name);
      if (!sid) {
        sid = newId();
        await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(sid, a.source_name, null, "{}", now.toISOString()).run();
        sourceIdByName.set(a.source_name, sid);
        nSources++;
      }
      await insertRestoredPrompt(a.id, sid, a.kind, a.question, a.answer, a.position, 1);
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
        "INSERT INTO captures (id, created_at, text, url, title, note, image_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(m[1], fields["captured"] ?? now.toISOString(), (fm ? fm[2] : text).trim(),
             fields["url"] ?? null, fields["title"] ?? null, fields["note"] ?? null, fields["image"] ?? null).run();
    }

    const index = files["assets/index.json"]
      ? JSON.parse(strFromU8(files["assets/index.json"])) as Record<string, string> : {};
    for (const [id, contentType] of Object.entries(index)) {
      const bytes = files[`assets/${id}`];
      if (!bytes) continue;
      if (!ALLOWED_TYPES.has(contentType)) throw new Error(`asset ${id}: unsupported content type`);
      await env.BUCKET.put(id, bytes, { httpMetadata: { contentType } });
      await env.DB.prepare(
        "INSERT OR IGNORE INTO assets (id, content_type, bytes, created_at) VALUES (?, ?, ?, ?)"
      ).bind(id, contentType, bytes.byteLength, now.toISOString()).run();
    }

    if (files["settings.json"]) {
      const s = JSON.parse(strFromU8(files["settings.json"])) as Record<string, unknown>;
      for (const k of ["session_cap", "desired_retention", "email_hour", "timezone", "email_to"]) {
        if (s[k] !== undefined) {
          await env.DB.prepare(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
          ).bind(k, String(s[k])).run();
        }
      }
    }
    return { sources: nSources, prompts: nPrompts, events: log.length };
  } catch (e) {
    await wipeAll(env);
    throw e;
  }
}
