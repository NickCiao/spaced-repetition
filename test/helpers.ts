import { env } from "cloudflare:workers";

/** Bare auth header map — spread into fetch headers alongside Content-Type etc. */
export const AUTH_HEADERS = { Authorization: "Bearer test-token" };

/** Ready-made fetch init for plain GETs: `exports.default.fetch(url, AUTH)`. */
export const AUTH = { headers: AUTH_HEADERS };

/**
 * Delete all user data (settings persist). Storage is isolated per test file,
 * so this only clears the calling file's own state. Order matters: events and
 * prompts reference other rows.
 */
export async function wipeData(): Promise<void> {
  for (const table of ["events", "prompts", "topics", "captures", "login_tokens"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}
