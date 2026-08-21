import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newId, nowIso } from "../src/db";

describe("health", () => {
  it("GET /health responds ok without auth", async () => {
    const res = await SELF.fetch("http://sr/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("auth", () => {
  it("rejects unknown token and missing token", async () => {
    expect((await SELF.fetch("http://sr/anything")).status).toBe(401);
    expect((await SELF.fetch("http://sr/anything", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("accepts bearer header (404 for unknown route, not 401)", async () => {
    const res = await SELF.fetch("http://sr/anything", { headers: { Authorization: "Bearer test-token" } });
    expect(res.status).toBe(404);
  });

  it("?token= sets cookie and redirects to clean URL", async () => {
    const res = await SELF.fetch("http://sr/somewhere?a=1&token=test-token", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://sr/somewhere?a=1");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("sr=test-token");
    expect(cookie).toContain("HttpOnly");
  });

  it("accepts the cookie", async () => {
    const res = await SELF.fetch("http://sr/anything", { headers: { Cookie: "sr=test-token" } });
    expect(res.status).toBe(404);
  });

  it("wrong ?token= gets 401 and sets no cookie", async () => {
    const res = await SELF.fetch("http://sr/somewhere?token=wrong", { redirect: "manual" });
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("public path matching is exact", async () => {
    expect((await SELF.fetch("http://sr/healthx")).status).toBe(401);      // /health must not prefix-match
    expect((await SELF.fetch("http://sr/static/nonexistent")).status).not.toBe(401); // /static/* bypasses auth
  });
});

export const AUTH = { headers: { Authorization: "Bearer test-token" } };
const POST = (path: string, body: unknown) =>
  SELF.fetch(`http://sr${path}`, {
    method: "POST",
    headers: { ...AUTH.headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

async function seedReviewPrompt(question = "rev-q") {
  const sid = newId(), pid = newId();
  const past = new Date(Date.now() - 86400_000).toISOString();
  await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, 'Rev Src', NULL, '{}', ?)")
    .bind(sid, nowIso()).run();
  await env.DB.prepare(
    `INSERT INTO prompts (id, source_id, kind, question, answer, position, created_at, updated_at,
      due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
     VALUES (?, ?, 'qa', ?, 'rev-a', 0, ?, ?, ?, 3, 5, 0, 3, 1, 0, 2, ?)`
  ).bind(pid, sid, question, nowIso(), nowIso(), past, past).run();
  return pid;
}

describe("review", () => {
  it("GET / embeds a session containing a due card", async () => {
    const pid = await seedReviewPrompt("embedded-question");
    const res = await SELF.fetch("http://sr/", AUTH);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="session"');
    expect(html).toContain("embedded-question");
    expect(html).toContain(pid);
  });

  it("grading remembered pushes due forward and logs an event", async () => {
    const pid = await seedReviewPrompt();
    const res = await POST("/api/grade", { prompt_id: pid, action: "remembered" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; due: string };
    expect(new Date(body.due).getTime()).toBeGreaterThan(Date.now());
    const ev = await env.DB.prepare("SELECT * FROM events WHERE prompt_id = ?").bind(pid).all();
    expect(ev.results.length).toBe(1);
    expect(ev.results[0].action).toBe("remembered");
    expect(ev.results[0].state_after).toBeTruthy();
  });

  it("flag stores the note; retire excludes from sessions; skip logs only", async () => {
    const pid = await seedReviewPrompt();
    await POST("/api/grade", { prompt_id: pid, action: "flag", note: "ambiguous" });
    let row = await env.DB.prepare("SELECT flag_note, retired, due FROM prompts WHERE id = ?").bind(pid).first();
    expect(row?.flag_note).toBe("ambiguous");

    const dueBefore = row?.due;
    await POST("/api/grade", { prompt_id: pid, action: "skip" });
    row = await env.DB.prepare("SELECT due FROM prompts WHERE id = ?").bind(pid).first();
    expect(row?.due).toBe(dueBefore); // skip never reschedules

    await POST("/api/grade", { prompt_id: pid, action: "retire" });
    row = await env.DB.prepare("SELECT retired FROM prompts WHERE id = ?").bind(pid).first();
    expect(row?.retired).toBe(1);
  });

  it("rejects unknown prompt and bad action", async () => {
    expect((await POST("/api/grade", { prompt_id: "nope", action: "remembered" })).status).toBe(404);
    const pid = await seedReviewPrompt();
    expect((await POST("/api/grade", { prompt_id: pid, action: "sideways" })).status).toBe(400);
  });
});
