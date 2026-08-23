import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newId, nowIso } from "../src/db";

describe("health", () => {
  it("GET /health responds ok without auth", async () => {
    const res = await exports.default.fetch("http://sr/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("auth", () => {
  it("rejects unknown token and missing token", async () => {
    expect((await exports.default.fetch("http://sr/anything")).status).toBe(401);
    expect((await exports.default.fetch("http://sr/anything", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("accepts bearer header (404 for unknown route, not 401)", async () => {
    const res = await exports.default.fetch("http://sr/anything", { headers: { Authorization: "Bearer test-token" } });
    expect(res.status).toBe(404);
  });

  it("?token= sets cookie and redirects to clean URL", async () => {
    const res = await exports.default.fetch("http://sr/somewhere?a=1&token=test-token", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://sr/somewhere?a=1");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("sr=test-token");
    expect(cookie).toContain("HttpOnly");
  });

  it("accepts the cookie", async () => {
    const res = await exports.default.fetch("http://sr/anything", { headers: { Cookie: "sr=test-token" } });
    expect(res.status).toBe(404);
  });

  it("wrong ?token= gets 401 and sets no cookie", async () => {
    const res = await exports.default.fetch("http://sr/somewhere?token=wrong", { redirect: "manual" });
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("public path matching is exact", async () => {
    expect((await exports.default.fetch("http://sr/healthx")).status).toBe(401);      // /health must not prefix-match
    expect((await exports.default.fetch("http://sr/static/nonexistent")).status).not.toBe(401); // /static/* bypasses auth
  });
});

export const AUTH = { headers: { Authorization: "Bearer test-token" } };
const POST = (path: string, body: unknown) =>
  exports.default.fetch(`http://sr${path}`, {
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
    const res = await exports.default.fetch("http://sr/", AUTH);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="session"');
    expect(html).toContain("embedded-question");
    expect(html).toContain(pid);
    expect(html).toContain("class=\"rail\"");
    expect(html).toContain("nocturne-app.css");
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

  it("flag with empty note stores the fallback", async () => {
    const pid = await seedReviewPrompt();
    await POST("/api/grade", { prompt_id: pid, action: "flag", note: "" });
    const row = await env.DB.prepare("SELECT flag_note FROM prompts WHERE id = ?").bind(pid).first();
    expect(row?.flag_note).toBe("flagged");
  });

  it("delete removes the prompt and its events", async () => {
    const deletePid = await seedReviewPrompt("delete-me");
    await POST("/api/grade", { prompt_id: deletePid, action: "remembered" });
    expect((await POST(`/api/prompt/${deletePid}/delete`, {})).status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM prompts WHERE id = ?").bind(deletePid).first()).toBeNull();
    const ev = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE prompt_id = ?").bind(deletePid).first();
    expect(ev?.n).toBe(0);
    expect((await POST("/api/prompt/nope/delete", {})).status).toBe(404);
  });
});

describe("capture", () => {
  it("POST /api/capture stores a pending capture", async () => {
    const res = await POST("/api/capture", { text: "worth remembering", url: "https://ex.com/a", title: "Ex" });
    expect(res.status).toBe(200);
    const { id } = await res.json() as { id: string };
    const row = await env.DB.prepare("SELECT * FROM captures WHERE id = ?").bind(id).first();
    expect(row?.status).toBe("pending");
    expect(row?.title).toBe("Ex");
  });

  it("rejects empty text", async () => {
    expect((await POST("/api/capture", { text: "  " })).status).toBe(400);
  });

  it("lists today's captures", async () => {
    await POST("/api/capture", { text: "today-item" });
    const res = await exports.default.fetch("http://sr/api/captures/today", AUTH);
    const { items } = await res.json() as { items: { text: string }[] };
    expect(items.some(i => i.text === "today-item")).toBe(true);
  });

  it("source autocomplete matches by substring", async () => {
    await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, 'Thinking in Bets', NULL, '{}', ?)")
      .bind(newId(), nowIso()).run();
    const res = await exports.default.fetch("http://sr/api/sources?q=bets", AUTH);
    const { items } = await res.json() as { items: { name: string }[] };
    expect(items.some(i => i.name === "Thinking in Bets")).toBe(true);
  });

  it("serves capture page and sw.js (sw without auth)", async () => {
    expect((await exports.default.fetch("http://sr/capture", AUTH)).status).toBe(200);
    const sw = await exports.default.fetch("http://sr/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("Content-Type") ?? "").toContain("javascript");
  });
});

describe("inbox and refine", () => {
  async function seedCapture(text = "cap-text") {
    const res = await POST("/api/capture", { text, url: "https://src.example/x", title: "Cap Title" });
    return (await res.json() as { id: string }).id;
  }

  it("inbox lists pending captures and flagged prompts", async () => {
    const cid = await seedCapture("inbox-cap");
    const pid = await seedReviewPrompt("flagged-question");
    await POST("/api/grade", { prompt_id: pid, action: "flag", note: "unclear" });
    const html = await (await exports.default.fetch("http://sr/inbox", AUTH)).text();
    expect(html).toContain("inbox-cap");
    expect(html).toContain(`/refine/${cid}`);
    expect(html).toContain("flagged-question");
    expect(html).toContain("unclear");
  });

  it("refine creates prompts as new cards and consumes the capture", async () => {
    const cid = await seedCapture();
    const res = await POST("/api/refine", {
      capture_id: cid,
      source: { name: "Refine Book", url: "https://src.example/x" },
      prompts: [
        { kind: "qa", question: "RQ1?", answer: "RA1" },
        { kind: "cloze", question: "The {{answer}} is here.", answer: "" }
      ]
    });
    expect(res.status).toBe(200);
    const { prompt_ids } = await res.json() as { prompt_ids: string[] };
    expect(prompt_ids.length).toBe(2);
    const p = await env.DB.prepare("SELECT * FROM prompts WHERE id = ?").bind(prompt_ids[0]).first();
    expect(p?.reps).toBe(0);
    expect(p?.state).toBe(0);
    const cap = await env.DB.prepare("SELECT status FROM captures WHERE id = ?").bind(cid).first();
    expect(cap?.status).toBe("consumed");
    const again = await POST("/api/refine", { capture_id: cid, source: { name: "X" }, prompts: [{ kind: "qa", question: "q", answer: "a" }] });
    expect(again.status).toBe(409);
  });

  it("refine validation: no prompts, cloze without spans, qa without answer", async () => {
    const cid = await seedCapture();
    expect((await POST("/api/refine", { capture_id: cid, source: { name: "S" }, prompts: [] })).status).toBe(400);
    expect((await POST("/api/refine", { capture_id: cid, source: { name: "S" }, prompts: [{ kind: "cloze", question: "no spans", answer: "" }] })).status).toBe(400);
    expect((await POST("/api/refine", { capture_id: cid, source: { name: "S" }, prompts: [{ kind: "qa", question: "q?", answer: "" }] })).status).toBe(400);
  });

  it("capture delete removes pending capture", async () => {
    const cid = await seedCapture("to-delete");
    const res = await exports.default.fetch(`http://sr/api/capture/${cid}/delete`, { method: "POST", ...AUTH });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT id FROM captures WHERE id = ?").bind(cid).first();
    expect(row).toBeNull();
  });

  it("preview renders both sides", async () => {
    const res = await POST("/api/preview", { kind: "cloze", question: "Hide {{this}}.", answer: "" });
    const body = await res.json() as { questionHtml: string; answerHtml: string };
    expect(body.questionHtml).toContain("[…]");
    expect(body.answerHtml).toContain("this");
  });

  it("concurrent refines of one capture create prompts exactly once", async () => {
    const cid = await seedCapture("race-me");
    const body = { capture_id: cid, source: { name: "Race Src" }, prompts: [{ kind: "qa", question: "rq?", answer: "ra" }] };
    const [r1, r2] = await Promise.all([POST("/api/refine", body), POST("/api/refine", body)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts WHERE question = 'rq?'").first();
    expect(n?.n).toBe(1);
  });
});

describe("browse, prompt edit, settings", () => {
  it("editing a prompt preserves its schedule", async () => {
    const pid = await seedReviewPrompt("before-edit");
    const before = await env.DB.prepare("SELECT due, source_id FROM prompts WHERE id = ?").bind(pid).first();
    const res = await POST("/api/prompt", {
      id: pid, source_id: before!.source_id, kind: "qa",
      question: "after-edit?", answer: "new answer", clear_flag: true
    });
    expect(res.status).toBe(200);
    const after = await env.DB.prepare("SELECT question, due, flag_note FROM prompts WHERE id = ?").bind(pid).first();
    expect(after?.question).toBe("after-edit?");
    expect(after?.due).toBe(before?.due);
    expect(after?.flag_note).toBeNull();
  });

  it("creates a prompt directly under a source (new card)", async () => {
    const sid = newId();
    await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, 'Direct Src', NULL, '{}', ?)")
      .bind(sid, nowIso()).run();
    const res = await POST("/api/prompt", { source_id: sid, kind: "qa", question: "direct?", answer: "yes" });
    const { id } = await res.json() as { id: string };
    const row = await env.DB.prepare("SELECT reps, state FROM prompts WHERE id = ?").bind(id).first();
    expect(row?.reps).toBe(0);
    const html = await (await exports.default.fetch(`http://sr/browse/${sid}`, AUTH)).text();
    expect(html).toContain("direct?");
    expect(html).toContain(`/?source=${sid}`);
  });

  it("browse index lists sources with counts", async () => {
    const html = await (await exports.default.fetch("http://sr/browse", AUTH)).text();
    expect(html).toContain("Direct Src");
  });

  it("settings round-trip and validation", async () => {
    const ok = await POST("/api/settings", { session_cap: 25, desired_retention: 0.85, email_hour: 8, timezone: "America/New_York" });
    expect(ok.status).toBe(200);
    const html = await (await exports.default.fetch("http://sr/settings", AUTH)).text();
    expect(html).toContain("25");
    expect((await POST("/api/settings", { session_cap: 0, desired_retention: 0.9, email_hour: 7, timezone: "America/New_York" })).status).toBe(400);
    expect((await POST("/api/settings", { session_cap: 20, desired_retention: 0.5, email_hour: 7, timezone: "America/New_York" })).status).toBe(400);
    expect((await POST("/api/settings", { session_cap: 20, desired_retention: 0.9, email_hour: 7, timezone: "Not/AZone" })).status).toBe(400);
    // restore defaults for other tests
    await POST("/api/settings", { session_cap: 20, desired_retention: 0.9, email_hour: 7, timezone: "America/Los_Angeles" });
  });

  it("prompt/new rejects malformed or unknown source ids", async () => {
    const evil = await exports.default.fetch(`http://sr/prompt/new?source=${encodeURIComponent('x"><script>1</script>')}`, AUTH);
    expect(evil.status).toBe(404);
    const unknown = await exports.default.fetch("http://sr/prompt/new?source=zzzzzzzzzz", AUTH);
    expect(unknown.status).toBe(404);
  });

  it("javascript: source urls never render as links", async () => {
    const sid = newId();
    await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, 'Sketchy', 'javascript:alert(1)', '{}', ?)")
      .bind(sid, nowIso()).run();
    const html = await (await exports.default.fetch(`http://sr/browse/${sid}`, AUTH)).text();
    expect(html).not.toContain('href="javascript:');
  });

  it("omitted timezone is a 400, not a crash", async () => {
    const res = await POST("/api/settings", { session_cap: 20, desired_retention: 0.9, email_hour: 7 });
    expect(res.status).toBe(400);
  });

  it("cloze answers are normalized to empty", async () => {
    const sid2 = newId();
    await env.DB.prepare("INSERT INTO sources (id, name, url, meta, created_at) VALUES (?, 'Cz', NULL, '{}', ?)").bind(sid2, nowIso()).run();
    const res = await POST("/api/prompt", { source_id: sid2, kind: "cloze", question: "Hide {{x}}.", answer: "junk" });
    const { id } = await res.json() as { id: string };
    const row = await env.DB.prepare("SELECT answer FROM prompts WHERE id = ?").bind(id).first();
    expect(row?.answer).toBe("");
  });
});
