import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newId, nowIso } from "../src/db";
import { AUTH, wipeData } from "./helpers";

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

const POST = (path: string, body: unknown) =>
  exports.default.fetch(`http://sr${path}`, {
    method: "POST",
    headers: { ...AUTH.headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

async function seedReviewPrompt(question = "rev-q", source: string | null = null) {
  const tid = newId(), pid = newId();
  const past = new Date(Date.now() - 86400_000).toISOString();
  await env.DB.prepare("INSERT INTO topics (id, name, url, meta, created_at) VALUES (?, 'Rev Topic', NULL, '{}', ?)")
    .bind(tid, nowIso()).run();
  await env.DB.prepare(
    `INSERT INTO prompts (id, topic_id, kind, question, answer, source, position, created_at, updated_at,
      due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)
     VALUES (?, ?, 'qa', ?, 'rev-a', ?, 0, ?, ?, ?, 3, 5, 0, 3, 1, 0, 2, ?)`
  ).bind(pid, tid, question, source, nowIso(), nowIso(), past, past).run();
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

  it("session cards carry the topic name and rendered source attribution", async () => {
    await wipeData();
    await seedReviewPrompt("attributed-q", "[Paper](https://ex.com/p)");
    const html = await (await exports.default.fetch("http://sr/", AUTH)).text();
    expect(html).toContain('"topicName":"Rev Topic"');
    expect(html).toContain('rel=\\"noopener\\"'); // sourceHtml is server-rendered markdown
    expect(html).toContain("Paper");

    await wipeData();
    await seedReviewPrompt("bare-q");
    const bare = await (await exports.default.fetch("http://sr/", AUTH)).text();
    expect(bare).toContain('"sourceHtml":null');
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
  it("POST /api/capture stores a pending capture with its topic hint", async () => {
    const res = await POST("/api/capture", { text: "worth remembering", url: "https://ex.com/a", title: "Ex", topic: "Decision Making" });
    expect(res.status).toBe(200);
    const { id } = await res.json() as { id: string };
    const row = await env.DB.prepare("SELECT * FROM captures WHERE id = ?").bind(id).first();
    expect(row?.status).toBe("pending");
    expect(row?.title).toBe("Ex");
    expect(row?.topic).toBe("Decision Making");
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

  it("GET /api/topics lists every topic, most recently used first", async () => {
    await wipeData();
    const old = newId(), fresh = newId();
    await env.DB.prepare("INSERT INTO topics (id, name, url, meta, created_at) VALUES (?, 'Old Topic', NULL, '{}', '2020-01-01T00:00:00Z')")
      .bind(old).run();
    await env.DB.prepare("INSERT INTO topics (id, name, url, meta, created_at) VALUES (?, 'Fresh Topic', NULL, '{}', '2021-01-01T00:00:00Z')")
      .bind(fresh).run();
    // A prompt touched now bumps the old topic above the newer-but-idle one.
    await POST("/api/prompt", { topic_id: old, kind: "qa", question: "bump?", answer: "yes" });
    const res = await exports.default.fetch("http://sr/api/topics", AUTH);
    const { items } = await res.json() as { items: { id: string; name: string; count: number }[] };
    expect(items.map(i => i.name)).toEqual(["Old Topic", "Fresh Topic"]);
    expect(items[0].count).toBe(1);
    expect(items[1].count).toBe(0);
  });

  it("serves capture page and sw.js (sw without auth)", async () => {
    const cap = await exports.default.fetch("http://sr/capture", AUTH);
    expect(cap.status).toBe(200);
    expect(await cap.text()).toContain("topic-picker.js");
    const sw = await exports.default.fetch("http://sr/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("Content-Type") ?? "").toContain("javascript");
  });
});

describe("inbox and refine", () => {
  async function seedCapture(text = "cap-text", extra: Record<string, unknown> = {}) {
    const res = await POST("/api/capture", { text, url: "https://src.example/x", title: "Cap Title", ...extra });
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

  it("refine page pre-fills the topic and a markdown-link source guess", async () => {
    const cid = await seedCapture("prefill-cap", { topic: "My Topic" });
    const html = await (await exports.default.fetch(`http://sr/refine/${cid}`, AUTH)).text();
    expect(html).toContain('data-topic-name="My Topic"');
    expect(html).toContain('data-source="[Cap Title](https://src.example/x)"');
  });

  it("legacy captures fall back to title as the topic guess", async () => {
    const cid = await seedCapture("legacy-cap"); // title, no topic — like pre-rename rows
    const html = await (await exports.default.fetch(`http://sr/refine/${cid}`, AUTH)).text();
    expect(html).toContain('data-topic-name="Cap Title"');
  });

  it("refine creates prompts as new cards, stamps the source, and consumes the capture", async () => {
    const cid = await seedCapture();
    const res = await POST("/api/refine", {
      capture_id: cid,
      topic: { name: "Refine Topic" },
      source: "[Cap Title](https://src.example/x)",
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
    expect(p?.source).toBe("[Cap Title](https://src.example/x)");
    const p2 = await env.DB.prepare("SELECT source FROM prompts WHERE id = ?").bind(prompt_ids[1]).first();
    expect(p2?.source).toBe("[Cap Title](https://src.example/x)"); // one capture, one provenance
    const cap = await env.DB.prepare("SELECT status FROM captures WHERE id = ?").bind(cid).first();
    expect(cap?.status).toBe("consumed");
    const again = await POST("/api/refine", { capture_id: cid, topic: { name: "X" }, prompts: [{ kind: "qa", question: "q", answer: "a" }] });
    expect(again.status).toBe(409);
  });

  it("refine accepts a topic id directly and rejects unknown ids", async () => {
    const { id: tid } = await (await POST("/api/topic", { name: "By Id" })).json() as { id: string };
    const cid = await seedCapture("by-id-cap");
    const res = await POST("/api/refine", {
      capture_id: cid, topic: { id: tid }, prompts: [{ kind: "qa", question: "iq?", answer: "ia" }]
    });
    expect(res.status).toBe(200);
    const { prompt_ids } = await res.json() as { prompt_ids: string[] };
    const p = await env.DB.prepare("SELECT topic_id, source FROM prompts WHERE id = ?").bind(prompt_ids[0]).first();
    expect(p?.topic_id).toBe(tid);
    expect(p?.source).toBeNull(); // omitted source stays null

    const cid2 = await seedCapture("bad-id-cap");
    const bad = await POST("/api/refine", {
      capture_id: cid2, topic: { id: "zzzzzzzzzz" }, prompts: [{ kind: "qa", question: "q?", answer: "a" }]
    });
    expect(bad.status).toBe(404);
    const still = await env.DB.prepare("SELECT status FROM captures WHERE id = ?").bind(cid2).first();
    expect(still?.status).toBe("pending"); // rejected before the capture was consumed
  });

  it("refine validation: no prompts, cloze without spans, qa without answer, multi-line source", async () => {
    const cid = await seedCapture();
    expect((await POST("/api/refine", { capture_id: cid, topic: { name: "T" }, prompts: [] })).status).toBe(400);
    expect((await POST("/api/refine", { capture_id: cid, topic: { name: "T" }, prompts: [{ kind: "cloze", question: "no spans", answer: "" }] })).status).toBe(400);
    expect((await POST("/api/refine", { capture_id: cid, topic: { name: "T" }, prompts: [{ kind: "qa", question: "q?", answer: "" }] })).status).toBe(400);
    expect((await POST("/api/refine", {
      capture_id: cid, topic: { name: "T" }, source: "two\nlines",
      prompts: [{ kind: "qa", question: "q?", answer: "a" }]
    })).status).toBe(400);
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

  it("refine dedupes topic names case-insensitively, like /api/topic", async () => {
    const { id: tid } = await (await POST("/api/topic", { name: "Case Topic" })).json() as { id: string };
    const cid = await seedCapture("case-cap");
    const res = await POST("/api/refine", {
      capture_id: cid,
      topic: { name: "case topic" },
      prompts: [{ kind: "qa", question: "cq?", answer: "ca" }]
    });
    expect(res.status).toBe(200);
    const { prompt_ids } = await res.json() as { prompt_ids: string[] };
    const p = await env.DB.prepare("SELECT topic_id FROM prompts WHERE id = ?").bind(prompt_ids[0]).first();
    expect(p?.topic_id).toBe(tid);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM topics WHERE name = ? COLLATE NOCASE")
      .bind("Case Topic").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("concurrent refines of one capture create prompts exactly once", async () => {
    const cid = await seedCapture("race-me");
    const body = { capture_id: cid, topic: { name: "Race Topic" }, prompts: [{ kind: "qa", question: "rq?", answer: "ra" }] };
    const [r1, r2] = await Promise.all([POST("/api/refine", body), POST("/api/refine", body)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts WHERE question = 'rq?'").first();
    expect(n?.n).toBe(1);
  });
});

describe("browse, prompt edit, settings", () => {
  it("editing a prompt preserves its schedule", async () => {
    const pid = await seedReviewPrompt("before-edit");
    const before = await env.DB.prepare("SELECT due, topic_id FROM prompts WHERE id = ?").bind(pid).first();
    const res = await POST("/api/prompt", {
      id: pid, topic_id: before!.topic_id, kind: "qa",
      question: "after-edit?", answer: "new answer", clear_flag: true
    });
    expect(res.status).toBe(200);
    const after = await env.DB.prepare("SELECT question, due, flag_note FROM prompts WHERE id = ?").bind(pid).first();
    expect(after?.question).toBe("after-edit?");
    expect(after?.due).toBe(before?.due);
    expect(after?.flag_note).toBeNull();
  });

  it("editing a prompt sets and clears its source", async () => {
    const pid = await seedReviewPrompt("source-edit");
    const before = await env.DB.prepare("SELECT topic_id FROM prompts WHERE id = ?").bind(pid).first();
    await POST("/api/prompt", {
      id: pid, topic_id: before!.topic_id, kind: "qa",
      question: "q?", answer: "a", source: "  [Doc](https://ex.com/d)  "
    });
    let row = await env.DB.prepare("SELECT source FROM prompts WHERE id = ?").bind(pid).first();
    expect(row?.source).toBe("[Doc](https://ex.com/d)"); // trimmed
    await POST("/api/prompt", {
      id: pid, topic_id: before!.topic_id, kind: "qa", question: "q?", answer: "a", source: "  "
    });
    row = await env.DB.prepare("SELECT source FROM prompts WHERE id = ?").bind(pid).first();
    expect(row?.source).toBeNull(); // blank clears
    const bad = await POST("/api/prompt", {
      id: pid, topic_id: before!.topic_id, kind: "qa", question: "q?", answer: "a", source: "a\nb"
    });
    expect(bad.status).toBe(400);
  });

  it("creates a prompt directly under a topic (new card)", async () => {
    const tid = newId();
    await env.DB.prepare("INSERT INTO topics (id, name, url, meta, created_at) VALUES (?, 'Direct Topic', NULL, '{}', ?)")
      .bind(tid, nowIso()).run();
    const res = await POST("/api/prompt", { topic_id: tid, kind: "qa", question: "direct?", answer: "yes" });
    const { id } = await res.json() as { id: string };
    const row = await env.DB.prepare("SELECT reps, state FROM prompts WHERE id = ?").bind(id).first();
    expect(row?.reps).toBe(0);
    const html = await (await exports.default.fetch(`http://sr/browse/${tid}`, AUTH)).text();
    expect(html).toContain("direct?");
    expect(html).toContain(`/?topic=${tid}`);
  });

  it("browse index lists topics with counts", async () => {
    const html = await (await exports.default.fetch("http://sr/browse", AUTH)).text();
    expect(html).toContain("Direct Topic");
  });

  it("POST /api/topic creates a topic usable by browse and prompt/new", async () => {
    const res = await POST("/api/topic", { name: "Manual Topic", url: "https://manual.example/x" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; id: string; existed: boolean };
    expect(body.existed).toBe(false);
    const row = await env.DB.prepare("SELECT name, url FROM topics WHERE id = ?").bind(body.id).first();
    expect(row?.name).toBe("Manual Topic");
    expect(row?.url).toBe("https://manual.example/x");
    const browse = await (await exports.default.fetch("http://sr/browse", AUTH)).text();
    expect(browse).toContain("Manual Topic");
    const form = await exports.default.fetch(`http://sr/prompt/new?topic=${body.id}`, AUTH);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain("Manual Topic");
  });

  it("POST /api/topic rejects a missing or whitespace name", async () => {
    expect((await POST("/api/topic", {})).status).toBe(400);
    const ws = await POST("/api/topic", { name: "   " });
    expect(ws.status).toBe(400);
    expect((await ws.json() as { error: string }).error).toBe("topic name required");
  });

  it("POST /api/topic dedupes by name case-insensitively", async () => {
    const first = await (await POST("/api/topic", { name: "Dedupe Topic" })).json() as { id: string };
    const again = await (await POST("/api/topic", { name: "dedupe topic" })).json() as { id: string; existed: boolean };
    expect(again.existed).toBe(true);
    expect(again.id).toBe(first.id);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM topics WHERE name = ? COLLATE NOCASE")
      .bind("Dedupe Topic").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("browse index inlines topic names script-safely", async () => {
    await POST("/api/topic", { name: "</script><script>alert(1)</script>" });
    const html = await (await exports.default.fetch("http://sr/browse", AUTH)).text();
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>\\u003cscript>alert(1)");
  });

  it("empty topic page shows the + Prompt call to action", async () => {
    const { id } = await (await POST("/api/topic", { name: "Empty Topic" })).json() as { id: string };
    const html = await (await exports.default.fetch(`http://sr/browse/${id}`, AUTH)).text();
    expect(html).toContain(`/prompt/new?topic=${id}`);
    expect(html).toContain("No prompts yet");
  });

  it("settings round-trip and validation", async () => {
    const ok = await POST("/api/settings", {
      session_cap: 25, desired_retention: 0.85, email_hour: 8, timezone: "America/New_York",
      email_to: "me@example.com", base_url: "https://sr.example"
    });
    expect(ok.status).toBe(200);
    const html = await (await exports.default.fetch("http://sr/settings", AUTH)).text();
    expect(html).toContain("25");
    expect(html).toContain("me@example.com");
    expect(html).toContain("https://sr.example");
    expect((await POST("/api/settings", { session_cap: 0, desired_retention: 0.9, email_hour: 7, timezone: "America/New_York" })).status).toBe(400);
    expect((await POST("/api/settings", { session_cap: 20, desired_retention: 0.5, email_hour: 7, timezone: "America/New_York" })).status).toBe(400);
    expect((await POST("/api/settings", { session_cap: 20, desired_retention: 0.9, email_hour: 7, timezone: "Not/AZone" })).status).toBe(400);
    expect((await POST("/api/settings", {
      session_cap: 20, desired_retention: 0.9, email_hour: 7, timezone: "America/Los_Angeles",
      email_to: "not-an-email"
    })).status).toBe(400);
    // restore defaults for other tests
    await POST("/api/settings", {
      session_cap: 20, desired_retention: 0.9, email_hour: 7, timezone: "America/Los_Angeles",
      email_to: "", base_url: ""
    });
  });

  it("resend api key set/clear without echoing the secret", async () => {
    const set = await POST("/api/settings", {
      session_cap: 20, desired_retention: 0.9, email_hour: 7, timezone: "America/Los_Angeles",
      resend_api_key: "re_test_secret"
    });
    expect(set.status).toBe(200);
    const html = await (await exports.default.fetch("http://sr/settings", AUTH)).text();
    expect(html).not.toContain("re_test_secret");
    expect(html).toContain("Key is set");
    const key = await env.DB.prepare("SELECT value FROM settings WHERE key = 'resend_api_key'").first<{ value: string }>();
    expect(key?.value).toBe("re_test_secret");
    await POST("/api/settings", {
      session_cap: 20, desired_retention: 0.9, email_hour: 7, timezone: "America/Los_Angeles",
      clear_resend_api_key: true
    });
    const cleared = await env.DB.prepare("SELECT value FROM settings WHERE key = 'resend_api_key'").first<{ value: string }>();
    expect(cleared?.value).toBe("");
  });

  it("prompt/new rejects malformed or unknown topic ids", async () => {
    const evil = await exports.default.fetch(`http://sr/prompt/new?topic=${encodeURIComponent('x"><script>1</script>')}`, AUTH);
    expect(evil.status).toBe(404);
    const unknown = await exports.default.fetch("http://sr/prompt/new?topic=zzzzzzzzzz", AUTH);
    expect(unknown.status).toBe(404);
  });

  it("javascript: topic urls never render as links", async () => {
    const tid = newId();
    await env.DB.prepare("INSERT INTO topics (id, name, url, meta, created_at) VALUES (?, 'Sketchy', 'javascript:alert(1)', '{}', ?)")
      .bind(tid, nowIso()).run();
    const html = await (await exports.default.fetch(`http://sr/browse/${tid}`, AUTH)).text();
    expect(html).not.toContain('href="javascript:');
  });

  it("omitted timezone is a 400, not a crash", async () => {
    const res = await POST("/api/settings", { session_cap: 20, desired_retention: 0.9, email_hour: 7 });
    expect(res.status).toBe(400);
  });

  it("cloze answers are normalized to empty", async () => {
    const tid2 = newId();
    await env.DB.prepare("INSERT INTO topics (id, name, url, meta, created_at) VALUES (?, 'Cz', NULL, '{}', ?)").bind(tid2, nowIso()).run();
    const res = await POST("/api/prompt", { topic_id: tid2, kind: "cloze", question: "Hide {{x}}.", answer: "junk" });
    const { id } = await res.json() as { id: string };
    const row = await env.DB.prepare("SELECT answer FROM prompts WHERE id = ?").bind(id).first();
    expect(row?.answer).toBe("");
  });
});

describe("nav badges", () => {
  it("omits badges when nothing is due and the inbox is empty", async () => {
    await wipeData();
    const html = await (await exports.default.fetch("http://sr/", AUTH)).text();
    expect(html).toContain('data-nav="review"');
    expect(html).toContain('data-nav="inbox"');
    expect(html).not.toContain('class="rail-due"');
    expect(html).not.toContain('class="tab-due"');
  });

  it("review badge is due count; inbox badge is pending captures plus flagged prompts", async () => {
    await wipeData();
    await seedReviewPrompt("due-one");
    await seedReviewPrompt("due-two");
    const dueHtml = await (await exports.default.fetch("http://sr/", AUTH)).text();
    expect(dueHtml).toMatch(/data-nav="review"[^>]*>[\s\S]*?class="rail-due">2</);
    expect(dueHtml).toMatch(/data-nav="review"[^>]*>[\s\S]*?class="tab-due">2</);
    expect(dueHtml).not.toMatch(/data-nav="inbox"[^>]*>[\s\S]*?class="rail-due">/);

    await POST("/api/capture", { text: "inbox-item" });
    const pid = await seedReviewPrompt("to-flag");
    const flagged = await POST("/api/grade", { prompt_id: pid, action: "flag", note: "x" });
    const counts = await flagged.json() as { dueCount: number; inboxCount: number };
    expect(counts.dueCount).toBe(3); // flag does not leave the due queue
    expect(counts.inboxCount).toBe(2); // 1 capture + 1 flag

    const html = await (await exports.default.fetch("http://sr/", AUTH)).text();
    expect(html).toMatch(/data-nav="review"[^>]*>[\s\S]*?class="rail-due">3</);
    expect(html).toMatch(/data-nav="inbox"[^>]*>[\s\S]*?class="rail-due">2</);
  });

  it("grading remembered returns a dueCount that dropped the card", async () => {
    await wipeData();
    const pid = await seedReviewPrompt();
    const body = await (await POST("/api/grade", { prompt_id: pid, action: "remembered" }))
      .json() as { dueCount: number; inboxCount: number };
    expect(body.dueCount).toBe(0);
    expect(body.inboxCount).toBe(0);
  });
});
