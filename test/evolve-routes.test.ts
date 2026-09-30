import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { insertPromptStmt, insertTopic, newId, nowIso, setSetting } from "../src/db";
import { newCardFields } from "../src/scheduler";
import { __setModelOverride } from "../src/tutor/provider";
import { sessionStore } from "../src/tutor/session";
import { lineage } from "../src/tutor/lineage";
import type { EditProposal, NewPromptProposal, SessionLog, TurnEvent } from "../src/tutor/types";
import { AUTH, AUTH_HEADERS, wipeData } from "./helpers";

// A model that answers with a short text and no tool calls; enough to drive the
// route layer (session creation, SSE framing, persistence) without any network.
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 }
};
const mockModel = new MockLanguageModelV4({
  doStream: async () => ({
    stream: convertArrayToReadableStream([
      { type: "stream-start" as const, warnings: [] },
      { type: "text-start" as const, id: "t1" },
      { type: "text-delta" as const, id: "t1", delta: "Hello " },
      { type: "text-delta" as const, id: "t1", delta: "from the tutor." },
      { type: "text-end" as const, id: "t1" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage }
    ])
  })
});

const POST = (path: string, body?: unknown) =>
  exports.default.fetch(`http://sr${path}`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

const parseSse = (text: string): TurnEvent[] =>
  text.split("\n\n").filter(c => c.trim()).map(c => JSON.parse(c.replace(/^data: /, "")) as TurnEvent);

async function startSession(pid: string) {
  const res = await POST(`/api/evolve/${pid}/start`);
  expect(res.status).toBe(200);
  const events = parseSse(await res.text());
  const session = events.find(e => e.type === "session") as { type: "session"; id: string } | undefined;
  expect(session).toBeDefined();
  return { sessionId: session!.id, events, res };
}

async function withProposal(pid: string, sessionId: string, proposal: NewPromptProposal | EditProposal) {
  const log = (await sessionStore.load(env, pid, sessionId)) as SessionLog;
  log.proposals.push(proposal);
  await sessionStore.save(env, log);
  return proposal.id;
}

const loadLog = (pid: string, sid: string) => sessionStore.load(env, pid, sid) as Promise<SessionLog>;

let tid: string;
let pid: string;
const SOURCE = "[Raft paper](https://ex.com/raft)";

beforeAll(async () => {
  await wipeData();
  __setModelOverride(() => mockModel);
  const ts = nowIso();
  tid = await insertTopic(env.DB, { name: "Evolve Topic", url: null, created_at: ts });
  pid = newId();
  await insertPromptStmt(env.DB, {
    id: pid, topic_id: tid, kind: "qa",
    question: "What does Raft use to detect a stale leader?", answer: "Heartbeat timeouts",
    source: SOURCE, position: 0, created_at: ts, updated_at: ts
  }, newCardFields(new Date())).run();
  await setSetting(env.DB, "tutor_provider", "anthropic");
  await setSetting(env.DB, "anthropic_api_key", "");
});

describe("evolve: entry and page", () => {
  it("prompt editor links to /evolve/:id", async () => {
    const html = await (await exports.default.fetch(`http://sr/prompt/${pid}`, AUTH)).text();
    expect(html).toContain(`href="/evolve/${pid}"`);
    expect(html).toContain('id="evolve-prompt"');
    expect(html).toContain("Evolve");
  });

  it("page without a provider key shows the not-configured notice and no session script", async () => {
    const res = await exports.default.fetch(`http://sr/evolve/${pid}`, AUTH);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("The tutor isn't configured");
    expect(html).toContain('href="/settings"');
    expect(html).not.toContain("/static/evolve.js");
    expect(html).not.toContain('id="evolve"');
  });

  it("start without a provider key is 503", async () => {
    const res = await POST(`/api/evolve/${pid}/start`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });

  it("page with a key renders the prompt and mounts the session", async () => {
    await setSetting(env.DB, "anthropic_api_key", "k");
    const res = await exports.default.fetch(`http://sr/evolve/${pid}`, AUTH);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Evolve");
    expect(html).toContain("What does Raft use to detect a stale leader?");
    expect(html).toContain("Heartbeat timeouts");
    expect(html).toContain("Raft paper");
    expect(html).toContain(`href="/prompt/${pid}"`);
    expect(html).toContain(`id="evolve" data-prompt-id="${pid}" data-topic-id="${tid}"`);
    expect(html).toContain("/static/evolve.js");
    expect(html).toContain("/static/session-card.js");
  });

  it("review's return address survives editor → Evolve → editor; hostile values are dropped", async () => {
    const ret = `/?ahead=1&topic=${tid}`;
    const enc = encodeURIComponent(ret);
    const escaped = ret.replace("&", "&amp;");

    // Editor opened from review forwards the address on its Evolve link.
    const editor = await (await exports.default.fetch(`http://sr/prompt/${pid}?return=${enc}`, AUTH)).text();
    expect(editor).toContain(`id="evolve-prompt" href="/evolve/${pid}?return=${enc}"`);

    // Evolve page keeps it on the breadcrumb and hands it to the client, nav stays on Review.
    const html = await (await exports.default.fetch(`http://sr/evolve/${pid}?return=${enc}`, AUTH)).text();
    expect(html).toContain(`class="crumb" href="/prompt/${pid}?return=${enc}"`);
    expect(html).toContain(`data-return="${escaped}"`);
    expect(html).toContain('<a class="rail-item" href="/" aria-current="page" data-nav="review"');
    expect(html).not.toContain('aria-current="page" data-nav="browse"');

    // Without one, nothing is added.
    const plain = await (await exports.default.fetch(`http://sr/evolve/${pid}`, AUTH)).text();
    expect(plain).toContain(`class="crumb" href="/prompt/${pid}"`);
    expect(plain).not.toContain("data-return=");
    expect(plain).not.toContain("?return=");

    // Only review urls are honoured; the raw value is never echoed.
    for (const evil of ["https://evil.example/", "//evil.example/", "/browse", "javascript:alert(1)", `/prompt/${pid}`]) {
      const h = await (await exports.default.fetch(`http://sr/evolve/${pid}?return=${encodeURIComponent(evil)}`, AUTH)).text();
      expect(h).not.toContain("data-return=");
      expect(h).not.toContain("?return=");
      expect(h).not.toContain("evil.example");
    }
    const junk = await (await exports.default.fetch(
      `http://sr/evolve/${pid}?return=${encodeURIComponent("/?topic=x%22%3E%3Cscript%3E&junk=1")}`, AUTH)).text();
    expect(junk).toContain('data-return="/"');
    expect(junk).not.toContain("<script>");
  });

  it("unknown prompt is 404 for the page and every endpoint", async () => {
    const nope = "zzzzzzzzzz";
    expect((await exports.default.fetch(`http://sr/evolve/${nope}`, AUTH)).status).toBe(404);
    expect((await POST(`/api/evolve/${nope}/start`)).status).toBe(404);
    expect((await POST(`/api/evolve/${nope}/turn`, { session: nope, message: "hi" })).status).toBe(404);
    expect((await POST(`/api/evolve/${nope}/accept`, { session: nope, proposal_id: "x" })).status).toBe(404);
    expect((await POST(`/api/evolve/${nope}/fate`, { session: nope, fate: "keep" })).status).toBe(404);
    expect((await exports.default.fetch("http://sr/evolve/not-an-id", AUTH)).status).toBe(404);
  });
});

describe("evolve: start and turn stream", () => {
  it("start streams a session event, the model text, and done; the log lands in R2", async () => {
    const { sessionId, events, res } = await startSession(pid);
    expect(res.headers.get("Content-Type") ?? "").toMatch(/^text\/event-stream/);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(events[0]).toEqual({ type: "session", id: sessionId });
    const text = events.filter(e => e.type === "text-delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("Hello from the tutor.");
    const done = events.find(e => e.type === "done") as { type: "done"; log: { id: string } } | undefined;
    expect(done?.log.id).toBe(sessionId);
    expect(events.some(e => e.type === "error")).toBe(false);

    const listed = await env.BUCKET.list({ prefix: `evolve/${pid}/` });
    expect(listed.objects.map(o => o.key)).toContain(`evolve/${pid}/${sessionId}.json`);
    const log = await loadLog(pid, sessionId);
    expect(log.promptId).toBe(pid);
    expect(log.topicId).toBe(tid);
    expect(log.turns.length).toBe(1);
    expect(log.messages.length).toBeGreaterThanOrEqual(2); // [session start] + assistant reply
  });

  it("turn with a message appends to the same session; skip marks it", async () => {
    const { sessionId } = await startSession(pid);
    const before = (await loadLog(pid, sessionId)).messages.length;
    const res = await POST(`/api/evolve/${pid}/turn`, { session: sessionId, message: "I think it's a timeout." });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toMatch(/^text\/event-stream/);
    const events = parseSse(await res.text());
    expect(events.some(e => e.type === "session")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
    let log = await loadLog(pid, sessionId);
    expect(log.messages.length).toBeGreaterThan(before);
    expect(log.turns.length).toBe(2);
    expect(log.turns[1].userMessage).toBe("I think it's a timeout.");

    const skip = await POST(`/api/evolve/${pid}/turn`, { session: sessionId, action: "skip" });
    expect(skip.status).toBe(200);
    expect(parseSse(await skip.text()).at(-1)?.type).toBe("done");
    log = await loadLog(pid, sessionId);
    expect(log.skipped).toBe(true);
  });

  it("turn validates its body and its session", async () => {
    const { sessionId } = await startSession(pid);
    expect((await POST(`/api/evolve/${pid}/turn`, { session: sessionId })).status).toBe(400);
    expect((await POST(`/api/evolve/${pid}/turn`, { session: sessionId, message: "  " })).status).toBe(400);
    expect((await POST(`/api/evolve/${pid}/turn`, { session: sessionId, action: "dance" })).status).toBe(400);
    expect((await POST(`/api/evolve/${pid}/turn`, { session: sessionId, message: "a", action: "skip" })).status).toBe(400);
    expect((await POST(`/api/evolve/${pid}/turn`, { message: "hi" })).status).toBe(400);
    expect((await POST(`/api/evolve/${pid}/turn`, { session: "zzzzzzzzzz", message: "hi" })).status).toBe(404);
    expect((await POST(`/api/evolve/${pid}/turn`, { session: "../../etc", message: "hi" })).status).toBe(404);
  });

  it("a session belongs to one prompt", async () => {
    const other = newId();
    const ts = nowIso();
    await insertPromptStmt(env.DB, {
      id: other, topic_id: tid, kind: "qa", question: "other?", answer: "a",
      position: 5, created_at: ts, updated_at: ts
    }, newCardFields(new Date())).run();
    const { sessionId } = await startSession(pid);
    expect((await POST(`/api/evolve/${other}/turn`, { session: sessionId, message: "hi" })).status).toBe(404);
    expect((await POST(`/api/evolve/${other}/worth`, { session: sessionId, worth_it: true })).status).toBe(404);
  });
});

describe("evolve: accept / discard", () => {
  it("accepting a new proposal writes a fresh card in the parent's topic with its source, and a lineage edge", async () => {
    const { sessionId } = await startSession(pid);
    const proposalId = await withProposal(pid, sessionId, {
      id: newId(), kind: "new", promptKind: "qa",
      question: "Why does Raft randomise election timeouts?", answer: "To avoid split votes",
      move: "deepen", rationale: "You reached for it and nothing tests it.", status: "open"
    });
    const posBefore = await env.DB.prepare("SELECT MAX(position) AS p FROM prompts WHERE topic_id = ?")
      .bind(tid).first<{ p: number }>();

    const res = await POST(`/api/evolve/${pid}/accept`, {
      session: sessionId, proposal_id: proposalId,
      question: "Why does Raft randomise election timeouts?  ", // user-edited, trailing space trimmed
      answer: "So candidates rarely split the vote"
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; prompt_id: string };
    expect(body.ok).toBe(true);
    expect(body.prompt_id).toMatch(/^[a-z0-9]{10}$/);
    expect(body.prompt_id).not.toBe(pid);

    const row = await env.DB.prepare("SELECT * FROM prompts WHERE id = ?").bind(body.prompt_id).first<Record<string, unknown>>();
    expect(row?.topic_id).toBe(tid);
    expect(row?.source).toBe(SOURCE);
    expect(row?.kind).toBe("qa");
    expect(row?.question).toBe("Why does Raft randomise election timeouts?");
    expect(row?.answer).toBe("So candidates rarely split the vote");
    expect(row?.position).toBe((posBefore?.p ?? 0) + 1);
    expect(row?.reps).toBe(0);
    expect(row?.state).toBe(0);

    const edges = await lineage.forPrompt(env.DB, pid);
    expect(edges).toContainEqual(expect.objectContaining({
      child: body.prompt_id, parent: pid, move: "deepen", session: `evolve/${pid}/${sessionId}.json`
    }));
    expect(await lineage.forPrompt(env.DB, body.prompt_id)).toHaveLength(1);

    const log = await loadLog(pid, sessionId);
    const p = log.proposals.find(x => x.id === proposalId) as NewPromptProposal;
    expect(p.status).toBe("accepted");
    expect(p.acceptedPromptId).toBe(body.prompt_id);
    expect(p.finalQuestion).toBe("Why does Raft randomise election timeouts?");
    expect(p.finalAnswer).toBe("So candidates rarely split the vote");

    // Accept is one-shot.
    const again = await POST(`/api/evolve/${pid}/accept`, { session: sessionId, proposal_id: proposalId });
    expect(again.status).toBe(409);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts WHERE question = ?")
      .bind("Why does Raft randomise election timeouts?").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("accept validates the edited card against the proposal's kind", async () => {
    const { sessionId } = await startSession(pid);
    const qa = await withProposal(pid, sessionId, {
      id: newId(), kind: "new", promptKind: "qa", question: "q?", answer: "a",
      move: "other", rationale: "r", status: "open"
    });
    const noAnswer = await POST(`/api/evolve/${pid}/accept`, { session: sessionId, proposal_id: qa, question: "q?", answer: " " });
    expect(noAnswer.status).toBe(400);
    expect(((await loadLog(pid, sessionId)).proposals.find(x => x.id === qa))?.status).toBe("open");

    const cloze = await withProposal(pid, sessionId, {
      id: newId(), kind: "new", promptKind: "cloze", question: "Leaders send {{heartbeats}}.", answer: "",
      move: "reframe", rationale: "r", status: "open"
    });
    const noSpan = await POST(`/api/evolve/${pid}/accept`, { session: sessionId, proposal_id: cloze, question: "no span", answer: "" });
    expect(noSpan.status).toBe(400);
    const ok = await POST(`/api/evolve/${pid}/accept`, {
      session: sessionId, proposal_id: cloze, question: "Leaders send {{heartbeats}} to followers.", answer: "junk"
    });
    expect(ok.status).toBe(200);
    const { prompt_id } = await ok.json() as { prompt_id: string };
    const row = await env.DB.prepare("SELECT kind, answer FROM prompts WHERE id = ?").bind(prompt_id).first();
    expect(row?.kind).toBe("cloze");
    expect(row?.answer).toBe(""); // cloze answers normalised to empty

    expect((await POST(`/api/evolve/${pid}/accept`, { session: sessionId, proposal_id: "nope" })).status).toBe(404);
    expect((await POST(`/api/evolve/${pid}/accept`, { proposal_id: qa })).status).toBe(400);
  });

  it("accepting an edit is rejected when the original changed since it was drafted", async () => {
    const { sessionId } = await startSession(pid);
    const stale = await withProposal(pid, sessionId, {
      id: newId(), kind: "edit", question: "Stale rewording?", answer: "x",
      rationale: "r", basedOnUpdatedAt: "2000-01-01T00:00:00.000Z", status: "open"
    });
    const res = await POST(`/api/evolve/${pid}/accept`, { session: sessionId, proposal_id: stale, question: "Stale rewording?", answer: "x" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "prompt changed, re-open" });
    const row = await env.DB.prepare("SELECT question FROM prompts WHERE id = ?").bind(pid).first();
    expect(row?.question).toBe("What does Raft use to detect a stale leader?");
    expect(((await loadLog(pid, sessionId)).proposals.find(x => x.id === stale))?.status).toBe("open");
  });

  it("accepting a current edit updates the original in place and keeps its schedule", async () => {
    const { sessionId } = await startSession(pid);
    const before = await env.DB.prepare("SELECT updated_at, due, stability, reps FROM prompts WHERE id = ?")
      .bind(pid).first<{ updated_at: string; due: string; stability: number; reps: number }>();
    const edit = await withProposal(pid, sessionId, {
      id: newId(), kind: "edit",
      question: "How does a Raft follower notice its leader is gone?", answer: "No heartbeat within the election timeout",
      rationale: "The cue named the mechanism instead of the situation.",
      basedOnUpdatedAt: before!.updated_at, status: "open"
    });
    const res = await POST(`/api/evolve/${pid}/accept`, {
      session: sessionId, proposal_id: edit,
      question: "How does a Raft follower notice its leader is gone?", answer: "No heartbeat within the election timeout"
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; prompt_id: string; updated_at: string };
    expect(body.prompt_id).toBe(pid);
    const after = await env.DB.prepare("SELECT question, answer, updated_at, due, stability, reps FROM prompts WHERE id = ?")
      .bind(pid).first<{ question: string; answer: string; updated_at: string; due: string; stability: number; reps: number }>();
    expect(after?.question).toBe("How does a Raft follower notice its leader is gone?");
    expect(after?.answer).toBe("No heartbeat within the election timeout");
    expect(after?.updated_at).toBe(body.updated_at);
    expect(after?.updated_at).not.toBe(before?.updated_at);
    expect(after?.due).toBe(before?.due);
    expect(after?.stability).toBe(before?.stability);
    expect(after?.reps).toBe(before?.reps);
    const p = (await loadLog(pid, sessionId)).proposals.find(x => x.id === edit) as EditProposal;
    expect(p.status).toBe("accepted");
    expect(p.finalQuestion).toBe("How does a Raft follower notice its leader is gone?");

    // Second accept of the same edit: already accepted → 409 (and the row's updated_at moved on anyway).
    expect((await POST(`/api/evolve/${pid}/accept`, { session: sessionId, proposal_id: edit })).status).toBe(409);
  });

  it("discard marks the proposal and is one-shot", async () => {
    const { sessionId } = await startSession(pid);
    const proposalId = await withProposal(pid, sessionId, {
      id: newId(), kind: "new", promptKind: "qa", question: "meh?", answer: "meh",
      move: "compress", rationale: "r", status: "open"
    });
    const res = await POST(`/api/evolve/${pid}/discard`, { session: sessionId, proposal_id: proposalId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(((await loadLog(pid, sessionId)).proposals.find(x => x.id === proposalId))?.status).toBe("discarded");
    expect((await POST(`/api/evolve/${pid}/discard`, { session: sessionId, proposal_id: proposalId })).status).toBe(409);
    expect((await POST(`/api/evolve/${pid}/accept`, { session: sessionId, proposal_id: proposalId })).status).toBe(409);
    expect((await POST(`/api/evolve/${pid}/discard`, { session: sessionId, proposal_id: "nope" })).status).toBe(404);
    expect((await POST(`/api/evolve/${pid}/discard`, { session: sessionId })).status).toBe(400);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompts WHERE question = 'meh?'").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("evolve: fate and worth", () => {
  it("worth records the private answer", async () => {
    const { sessionId } = await startSession(pid);
    expect((await POST(`/api/evolve/${pid}/worth`, { session: sessionId, worth_it: "yes" })).status).toBe(400);
    const res = await POST(`/api/evolve/${pid}/worth`, { session: sessionId, worth_it: true });
    expect(res.status).toBe(200);
    expect((await loadLog(pid, sessionId)).worthIt).toBe(true);
    await POST(`/api/evolve/${pid}/worth`, { session: sessionId, worth_it: false });
    expect((await loadLog(pid, sessionId)).worthIt).toBe(false);
    expect((await POST(`/api/evolve/${pid}/worth`, { session: "zzzzzzzzzz", worth_it: true })).status).toBe(404);
  });

  it("fate keep leaves the prompt alone and records the choice", async () => {
    const { sessionId } = await startSession(pid);
    expect((await POST(`/api/evolve/${pid}/fate`, { session: sessionId, fate: "burn" })).status).toBe(400);
    const res = await POST(`/api/evolve/${pid}/fate`, { session: sessionId, fate: "keep" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, retired: false });
    const row = await env.DB.prepare("SELECT retired FROM prompts WHERE id = ?").bind(pid).first();
    expect(row?.retired).toBe(0);
    const ev = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE prompt_id = ?").bind(pid).first<{ n: number }>();
    expect(ev?.n).toBe(0);
    const log = await loadLog(pid, sessionId);
    expect(log.fate.chosen).toBe("keep");
    expect(log.fate.chosenAt).toBeTruthy();
  });

  it("fate retire hides the prompt and logs a retire event like review does", async () => {
    // Give it a last_review so elapsed_days is computed, as in gradeApi.
    const past = new Date(Date.now() - 2 * 86400_000).toISOString();
    await env.DB.prepare("UPDATE prompts SET last_review = ? WHERE id = ?").bind(past, pid).run();
    const { sessionId } = await startSession(pid);
    const res = await POST(`/api/evolve/${pid}/fate`, { session: sessionId, fate: "retire" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, retired: true });
    const row = await env.DB.prepare("SELECT retired, updated_at FROM prompts WHERE id = ?").bind(pid).first<{ retired: number; updated_at: string }>();
    expect(row?.retired).toBe(1);
    const ev = (await env.DB.prepare("SELECT * FROM events WHERE prompt_id = ? ORDER BY id").bind(pid).all<{
      action: string; ts: string; elapsed_days: number | null; state_after: string | null;
    }>()).results;
    expect(ev).toHaveLength(1);
    expect(ev[0].action).toBe("retire");
    expect(ev[0].ts).toBe(row?.updated_at);
    expect(ev[0].state_after).toBeNull();
    expect(ev[0].elapsed_days).toBeGreaterThan(1.9);
    expect(ev[0].elapsed_days).toBeLessThan(2.1);
    const log = await loadLog(pid, sessionId);
    expect(log.fate.chosen).toBe("retire");
    expect(log.fate.chosenAt).toBe(row?.updated_at);
  });
});
