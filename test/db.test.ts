import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getSetting, getSettings, insertPromptStmt, insertTopic, newId, rememberBaseUrl, setSetting } from "../src/db";
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
    // insertPromptStmt/insertTopic are the only production code that writes these
    // column lists — a schema migration that forgets them must fail here.
    const now = new Date().toISOString();
    const tid = await insertTopic(env.DB, { name: "Test Topic", url: null, created_at: now });
    await insertPromptStmt(env.DB, {
      id: "pmt0000001", topic_id: tid, kind: "qa", question: "Q?", answer: "A.",
      source: "[Doc](https://ex.com/d)", position: 0, created_at: now, updated_at: now
    }, newCardFields(new Date())).run();
    const row = await env.DB.prepare(`SELECT * FROM prompts WHERE id = ?`).bind("pmt0000001").first();
    expect(row?.kind).toBe("qa");
    expect(row?.retired).toBe(0);
    expect(row?.topic_id).toBe(tid);
    expect(row?.source).toBe("[Doc](https://ex.com/d)");
    const topic = await env.DB.prepare(`SELECT * FROM topics WHERE id = ?`).bind(tid).first();
    expect(topic?.meta).toBe("{}");

    await insertPromptStmt(env.DB, {
      id: "pmt0000002", topic_id: tid, kind: "qa", question: "Q2?", answer: "A2.",
      position: 1, created_at: now, updated_at: now
    }, newCardFields(new Date())).run();
    const bare = await env.DB.prepare(`SELECT source FROM prompts WHERE id = ?`).bind("pmt0000002").first();
    expect(bare?.source).toBeNull(); // source is optional and defaults to null
  });
});
