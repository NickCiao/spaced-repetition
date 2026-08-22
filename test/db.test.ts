import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getSetting, getSettings, newId, setSetting } from "../src/db";

describe("db", () => {
  it("seeds default settings", async () => {
    const s = await getSettings(env.DB);
    expect(s).toEqual({
      session_cap: 20,
      desired_retention: 0.9,
      email_hour: 7,
      timezone: "America/Los_Angeles"
    });
  });

  it("set/get setting round-trips", async () => {
    await setSetting(env.DB, "session_cap", "30");
    expect(await getSetting(env.DB, "session_cap")).toBe("30");
    await setSetting(env.DB, "session_cap", "20"); // restore for other tests
  });

  it("newId is 10 chars, url-safe, unique-ish", () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[a-z0-9]{10}$/);
    expect(a).not.toBe(b);
  });

  it("schema accepts a full prompt row", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, ?, ?, '{}', ?)`
    ).bind("src0000001", "Test Source", null, now).run();
    await env.DB.prepare(
      `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
        due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
       VALUES (?, ?, 'qa', 'Q?', 'A.', 0, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, NULL)`
    ).bind("pmt0000001", "src0000001", now, now, now).run();
    const row = await env.DB.prepare(`SELECT * FROM prompts WHERE id = ?`).bind("pmt0000001").first();
    expect(row?.kind).toBe("qa");
    expect(row?.retired).toBe(0);
  });
});
