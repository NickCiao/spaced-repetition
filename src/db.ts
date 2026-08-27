export type SourceRow = {
  id: string; name: string; url: string | null; meta: string; created_at: string;
};
export type PromptRow = {
  id: string; source_id: string; kind: "qa" | "cloze"; question: string; answer: string;
  position: number; retired: number; flag_note: string | null;
  created_at: string; updated_at: string;
  due: string; stability: number; difficulty: number; elapsed_days: number;
  scheduled_days: number; reps: number; lapses: number; state: number; last_review: string | null;
};
export type CaptureRow = {
  id: string; created_at: string; text: string; url: string | null; title: string | null;
  note: string | null; image_id: string | null; status: "pending" | "consumed";
};
export type EventRow = {
  id: number; ts: string; prompt_id: string;
  action: "remembered" | "forgot" | "skip" | "flag" | "retire";
  elapsed_days: number | null; state_after: string | null;
};

import type { SchedFields } from "./scheduler";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 36];
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Insert a source row and return its new id. */
export async function insertSource(
  db: D1Database,
  s: { name: string; url: string | null; created_at: string; meta?: string }
): Promise<string> {
  const id = newId();
  await db.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, s.name, s.url, s.meta ?? "{}", s.created_at).run();
  return id;
}

/**
 * The one place that knows the full prompts column list. Returns a prepared
 * statement (not run) so callers can either `.run()` it or collect several
 * into an atomic `db.batch()`.
 */
export function insertPromptStmt(
  db: D1Database,
  p: {
    id: string; source_id: string; kind: "qa" | "cloze"; question: string; answer: string;
    position: number; retired?: number; created_at: string; updated_at: string;
  },
  f: SchedFields
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO prompts (id, source_id, kind, question, answer, position, retired, created_at, updated_at,
      due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(p.id, p.source_id, p.kind, p.question, p.answer, p.position, p.retired ?? 0,
         p.created_at, p.updated_at,
         f.due, f.stability, f.difficulty, f.elapsed_days, f.scheduled_days,
         f.reps, f.lapses, f.state, f.last_review);
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? row.value : null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

export type AppSettings = {
  session_cap: number;
  desired_retention: number;
  email_hour: number;
  timezone: string;
  email_to: string;
  base_url: string;
  /** True when a Resend API key is stored in D1 (value never returned). */
  resend_key_set: boolean;
};

/** Scheduler / reminder fields safe to put in export.zip (no secrets, no host URL). */
export function exportableSettings(s: AppSettings): Record<string, string | number> {
  const out: Record<string, string | number> = {
    session_cap: s.session_cap,
    desired_retention: s.desired_retention,
    email_hour: s.email_hour,
    timezone: s.timezone
  };
  if (s.email_to) out.email_to = s.email_to;
  return out;
}

export async function getSettings(db: D1Database): Promise<AppSettings> {
  const rows = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const map = new Map(rows.results.map(r => [r.key, r.value]));
  const resend = map.get("resend_api_key") ?? "";
  return {
    session_cap: parseInt(map.get("session_cap") ?? "20", 10),
    desired_retention: parseFloat(map.get("desired_retention") ?? "0.9"),
    email_hour: parseInt(map.get("email_hour") ?? "7", 10),
    timezone: map.get("timezone") ?? "America/Los_Angeles",
    email_to: map.get("email_to") ?? "",
    base_url: map.get("base_url") ?? "",
    resend_key_set: resend.length > 0
  };
}

/** Record the request origin once so reminder emails have a link target without a deploy secret. */
export async function rememberBaseUrl(db: D1Database, requestUrl: string): Promise<void> {
  const existing = await getSetting(db, "base_url");
  if (existing) return;
  try {
    const origin = new URL(requestUrl).origin;
    if (origin.startsWith("http://") || origin.startsWith("https://")) {
      await setSetting(db, "base_url", origin);
    }
  } catch { /* ignore bad URLs */ }
}
