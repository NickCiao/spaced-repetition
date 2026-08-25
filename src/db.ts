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
