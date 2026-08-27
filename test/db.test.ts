import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getSetting, getSettings, insertPromptStmt, insertSource, newId, rememberBaseUrl, setSetting } from "../src/db";
import { newCardFields } from "../src/scheduler";

describe("db", () => {
  it("seeds default settings", async () => {
    const s = await getSettings(env.DB);
    expect(s).toEqual({
      session_cap: 20,
      desired_retention: 0.9,
      email_hour: 7,
      timezone: "America/Los_Angeles",
      email_to: "",
      base_url: "",
      resend_key_set: false
    });
  });

  it("rememberBaseUrl records origin once", async () => {
    await setSetting(env.DB, "base_url", "");
    await rememberBaseUrl(env.DB, "https://sr.example/settings");
    expect(await getSetting(env.DB, "base_url")).toBe("https://sr.example");
    await rememberBaseUrl(env.DB, "https://other.example/");
    expect(await getSetting(env.DB, "base_url")).toBe("https://sr.example");
    await setSetting(env.DB, "base_url", "");
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

  it("insert helpers agree with the schema (guards column-list drift)", async () => {
    // insertPromptStmt/insertSource are the only production code that writes these
    // column lists — a schema migration that forgets them must fail here.
    const now = new Date().toISOString();
    const sid = await insertSource(env.DB, { name: "Test Source", url: null, created_at: now });
    await insertPromptStmt(env.DB, {
      id: "pmt0000001", source_id: sid, kind: "qa", question: "Q?", answer: "A.",
      position: 0, created_at: now, updated_at: now
    }, newCardFields(new Date())).run();
    const row = await env.DB.prepare(`SELECT * FROM prompts WHERE id = ?`).bind("pmt0000001").first();
    expect(row?.kind).toBe("qa");
    expect(row?.retired).toBe(0);
    expect(row?.source_id).toBe(sid);
    const src = await env.DB.prepare(`SELECT * FROM sources WHERE id = ?`).bind(sid).first();
    expect(src?.meta).toBe("{}");
  });
});
