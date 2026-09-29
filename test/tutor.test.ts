import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart, LanguageModelV4StreamResult } from "@ai-sdk/provider";
import { insertPromptStmt, insertTopic, newId, nowIso, setSetting } from "../src/db";
import { newCardFields } from "../src/scheduler";
import {
  LINEAGE_KEY, MAX_PROPOSALS, TUTOR_DEFAULT_MODEL,
  __setModelOverride, createModel, getTutorConfig, lineage, makeTools, runTurn, sessionStore,
  type NewPromptProposal, type Proposal, type SessionLog, type ToolContext, type TurnEvent, type TutorConfig
} from "../src/tutor";
import { wipeData } from "./helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const CONFIG: TutorConfig = { provider: "anthropic", model: "mock-model", apiKey: "k" };
let topicId: string;
let promptId: string;      // the prompt under evolution
let siblingId: string;     // active sibling
let retiredId: string;     // retired sibling (must be excluded)

async function seed(): Promise<void> {
  await wipeData();
  const ts = nowIso();
  topicId = await insertTopic(env.DB, { name: "Raft", url: null, created_at: ts });
  promptId = newId(); siblingId = newId(); retiredId = newId();
  const fresh = newCardFields(new Date("2025-03-01T00:00:00Z"));
  await env.DB.batch([
    insertPromptStmt(env.DB, {
      id: promptId, topic_id: topicId, kind: "qa",
      question: "What does Raft use to detect a stale leader?", answer: "Term numbers on every RPC.",
      source: "[Raft paper](https://example.com/raft.pdf)", position: 0, created_at: ts, updated_at: ts
    }, { ...fresh, due: "2026-02-10T00:00:00.000Z", stability: 152.4, scheduled_days: 120, reps: 14, lapses: 1, state: 2, last_review: "2025-10-13T00:00:00.000Z" }),
    insertPromptStmt(env.DB, {
      id: siblingId, topic_id: topicId, kind: "cloze",
      question: "A Raft leader sends {{heartbeats}} to keep followers from starting elections.", answer: "",
      position: 1, created_at: ts, updated_at: ts
    }, fresh),
    insertPromptStmt(env.DB, {
      id: retiredId, topic_id: topicId, kind: "qa",
      question: "retired-q", answer: "retired-a", position: 2, retired: 1, created_at: ts, updated_at: ts
    }, fresh)
  ]);
  const events: [string, string, number | null][] = [
    ["2025-03-02T10:00:00.000Z", "remembered", null],
    ["2025-03-05T10:00:00.000Z", "remembered", 3],
    ["2025-11-04T10:00:00.000Z", "forgot", 120.2],
    ["2025-11-06T10:00:00.000Z", "remembered", 2]
  ];
  for (const [ts, action, elapsed] of events) {
    await env.DB.prepare("INSERT INTO events (ts, prompt_id, action, elapsed_days, state_after) VALUES (?, ?, ?, ?, NULL)")
      .bind(ts, promptId, action, elapsed).run();
  }
}

async function countRows(table: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return r?.n ?? 0;
}

async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

function streamOf(parts: LanguageModelV4StreamPart[]): LanguageModelV4StreamResult {
  return {
    stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: newId(), modelId: "mock-model", timestamp: new Date(0) },
      ...parts
    ])
  };
}

const toolCallStep = (toolName: string, input: unknown): LanguageModelV4StreamResult => streamOf([
  { type: "tool-call", toolCallId: newId(), toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }
]);

const textStep = (...chunks: string[]): LanguageModelV4StreamResult => streamOf([
  { type: "text-start", id: "t1" },
  ...chunks.map(delta => ({ type: "text-delta" as const, id: "t1", delta })),
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }
]);

function toolCtx(log: SessionLog, emitted: TurnEvent[] = []): ToolContext & { emitted: TurnEvent[] } {
  return {
    env, promptId: log.promptId, log, proposalsThisTurn: [], emit: e => emitted.push(e), now: new Date(), emitted
  };
}
const execOpts = { toolCallId: "call", messages: [] } as never;

beforeAll(seed);
afterEach(() => __setModelOverride(null));

// ---------------------------------------------------------------------------
// (1) config
// ---------------------------------------------------------------------------
describe("getTutorConfig", () => {
  const clear = () => env.DB.prepare(
    "DELETE FROM settings WHERE key IN ('tutor_provider','tutor_model','anthropic_api_key','openai_api_key')"
  ).run();

  it("is null when the active provider has no key", async () => {
    await clear();
    expect(await getTutorConfig(env.DB)).toBeNull();
    await setSetting(env.DB, "openai_api_key", "sk-o");     // key for the other provider does not count
    expect(await getTutorConfig(env.DB)).toBeNull();
    await clear();
  });

  it("resolves defaults with a key, honors explicit provider/model", async () => {
    await clear();
    await setSetting(env.DB, "anthropic_api_key", " sk-a ");
    expect(await getTutorConfig(env.DB)).toEqual({
      provider: "anthropic", model: TUTOR_DEFAULT_MODEL.anthropic, apiKey: "sk-a"
    });

    await setSetting(env.DB, "tutor_provider", "openai");
    expect(await getTutorConfig(env.DB)).toBeNull();          // switched provider, no openai key
    await setSetting(env.DB, "openai_api_key", "sk-o");
    await setSetting(env.DB, "tutor_model", "  gpt-custom ");
    expect(await getTutorConfig(env.DB)).toEqual({ provider: "openai", model: "gpt-custom", apiKey: "sk-o" });

    await setSetting(env.DB, "tutor_provider", "bogus");      // invalid → anthropic
    await setSetting(env.DB, "tutor_model", "");
    expect(await getTutorConfig(env.DB)).toEqual({
      provider: "anthropic", model: TUTOR_DEFAULT_MODEL.anthropic, apiKey: "sk-a"
    });
    await clear();
  });
});

// ---------------------------------------------------------------------------
// (2) lineage
// ---------------------------------------------------------------------------
describe("lineage", () => {
  it("append / forPrompt round-trip, filters by child or parent, atomic double-append", async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(LINEAGE_KEY).run();
    expect(await lineage.forPrompt(env.DB, promptId)).toEqual([]);

    const a = { child: "c000000001", parent: promptId, move: "deepen" as const, ts: nowIso(), session: "s000000001" };
    const b = { child: promptId, parent: "p000000002", move: "apply" as const, ts: nowIso(), session: "s000000002" };
    const c = { child: "c000000003", parent: "p000000004", move: "other" as const, ts: nowIso(), session: "s000000003" };
    await Promise.all([lineage.append(env.DB, a), lineage.append(env.DB, b)]);   // concurrent first-use appends
    await lineage.append(env.DB, c);

    const all = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(LINEAGE_KEY)
      .first<{ value: string }>())!.value);
    expect(all).toHaveLength(3);                                                 // nothing lost to a race

    const mine = await lineage.forPrompt(env.DB, promptId);
    expect(mine).toHaveLength(2);
    expect(mine.map(e => e.session).sort()).toEqual(["s000000001", "s000000002"]);
    expect(await lineage.forPrompt(env.DB, "c000000003")).toEqual([c]);
  });

  it("fails loudly on a corrupt ledger", async () => {
    await setSetting(env.DB, LINEAGE_KEY, "{not json");
    await expect(lineage.forPrompt(env.DB, promptId)).rejects.toThrow(/lineage ledger/);
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(LINEAGE_KEY).run();
  });
});

// ---------------------------------------------------------------------------
// (3) session store
// ---------------------------------------------------------------------------
describe("sessionStore", () => {
  it("create / save / load round-trip in R2; load is null for unknown or malformed ids", async () => {
    const log = await sessionStore.create(env, { promptId, topicId, config: CONFIG });
    expect(log.id).toMatch(/^[a-z0-9]{10}$/);
    expect(log).toMatchObject({
      promptId, topicId, provider: "anthropic", model: "mock-model",
      messages: [], proposals: [], fate: { recommended: null, chosen: null, chosenAt: null },
      worthIt: null, skipped: false, turns: []
    });
    expect(await env.BUCKET.head(`evolve/${promptId}/${log.id}.json`)).not.toBeNull();

    log.messages.push({ role: "user", content: "[session start]" });
    log.worthIt = true;
    const before = log.updatedAt;
    await new Promise(r => setTimeout(r, 2));
    await sessionStore.save(env, log);
    expect(log.updatedAt >= before).toBe(true);

    const loaded = await sessionStore.load(env, promptId, log.id);
    expect(loaded).toEqual(log);
    expect(await sessionStore.load(env, promptId, "zzzzzzzzzz")).toBeNull();
    expect(await sessionStore.load(env, promptId, "../etc")).toBeNull();
    await env.BUCKET.delete(`evolve/${promptId}/${log.id}.json`);
  });
});

// ---------------------------------------------------------------------------
// (4) read tools
// ---------------------------------------------------------------------------
describe("read tools", () => {
  it("read_review_history summarises seeded events and returns them oldest first", async () => {
    const log = await sessionStore.create(env, { promptId, topicId, config: CONFIG });
    const ctx = toolCtx(log);
    const out = await makeTools(ctx).read_review_history.execute!({}, execOpts) as {
      summary: string; events: { ts: string; action: string; elapsed_days: number | null }[];
    };
    expect(out.summary).toBe("4 reviews since 2025-03-02, 1 lapse (2025-11-04), stability 152d, interval 120d, next due 2026-02-10");
    expect(out.events.map(e => e.action)).toEqual(["remembered", "remembered", "forgot", "remembered"]);
    expect(out.events[2].elapsed_days).toBe(120.2);
    expect(ctx.emitted[0]).toEqual({ type: "status", text: "reading review history…" });
    await env.BUCKET.delete(`evolve/${promptId}/${log.id}.json`);
  });

  it("read_topic_siblings excludes self and retired; read_prompt counts prior sessions", async () => {
    const older = await sessionStore.create(env, { promptId, topicId, config: CONFIG });
    const log = await sessionStore.create(env, { promptId, topicId, config: CONFIG });
    const tools = makeTools(toolCtx(log));

    const sibs = await tools.read_topic_siblings.execute!({}, execOpts) as { id: string }[];
    expect(sibs.map(s => s.id)).toEqual([siblingId]);

    const p = await tools.read_prompt.execute!({}, execOpts) as {
      id: string; topic: { name: string }; retired: boolean; lineage: unknown[]; priorSessionCount: number;
    };
    expect(p.id).toBe(promptId);
    expect(p.topic.name).toBe("Raft");
    expect(p.retired).toBe(false);
    expect(p.lineage).toEqual([]);
    expect(p.priorSessionCount).toBe(1);          // `older` counts, the running session does not

    await env.BUCKET.delete(`evolve/${promptId}/${older.id}.json`);
    await env.BUCKET.delete(`evolve/${promptId}/${log.id}.json`);
  });

  it("fetch_source strips HTML, refuses non-text, never throws, and skips prompts without a URL", async () => {
    const log = await sessionStore.create(env, { promptId, topicId, config: CONFIG });
    const withFetch = (impl: typeof fetch) => makeTools({ ...toolCtx(log), fetchImpl: impl });
    type Out = { url: string | null; text: string | null; reason?: string; truncated?: boolean };

    const html = await withFetch(async () => new Response(
      "<html><head><title>Raft</title><style>p{}</style><script>x()</script></head><body><h1>In &amp; out</h1><p>Leaders   send heartbeats.</p><!-- c --></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } }
    )).fetch_source.execute!({}, execOpts) as Out;
    expect(html.url).toBe("https://example.com/raft.pdf");
    expect(html.text).toBe("Raft\nIn & out\nLeaders send heartbeats.");
    expect(html.truncated).toBe(false);

    const pdf = await withFetch(async () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }))
      .fetch_source.execute!({}, execOpts) as Out;
    expect(pdf).toEqual({ url: "https://example.com/raft.pdf", text: null, reason: "unsupported content-type: application/pdf" });

    const down = await withFetch(async () => { throw new TypeError("connect failed"); }).fetch_source.execute!({}, execOpts) as Out;
    expect(down.text).toBeNull();
    expect(down.reason).toBe("fetch failed: connect failed");

    const http = await withFetch(async () => new Response("nope", { status: 503 })).fetch_source.execute!({}, execOpts) as Out;
    expect(http.reason).toBe("fetch failed: HTTP 503");

    const bare = { ...log, promptId: siblingId };  // sibling has no source line
    const none = await makeTools(toolCtx(bare)).fetch_source.execute!({}, execOpts) as Out;
    expect(none).toEqual({ url: null, text: null, reason: "source has no http(s) URL" });
    await env.BUCKET.delete(`evolve/${promptId}/${log.id}.json`);
  });
});

// ---------------------------------------------------------------------------
// (5) + (8) a full mocked turn
// ---------------------------------------------------------------------------
describe("runTurn", () => {
  it("streams proposal → text → done; done resolves with proposals, messages and a turn; writes nothing", async () => {
    const promptsBefore = await countRows("prompts");
    const eventsBefore = await countRows("events");

    const mock = new MockLanguageModelV4({
      doStream: [
        toolCallStep("propose_prompt", {
          promptKind: "qa", question: "A follower gets an AppendEntries with a lower term than its own. What does it do?",
          answer: "Rejects it and replies with its current term so the sender steps down.",
          move: "apply", rationale: "You described terms as labels; the card never asks what a node does with a stale one."
        }),
        textStep("Here is ", "one proposal.")
      ]
    });
    __setModelOverride(() => mock);
    const model = createModel(CONFIG);
    expect(model).toBe(mock);

    const log = await sessionStore.create(env, { promptId, topicId, config: CONFIG });
    const { events, done } = runTurn({ env, model, log, input: { start: true }, now: new Date() });
    const seen = await collect(events);
    const final = await done;

    const types = seen.map(e => e.type);
    expect(types[0]).toBe("proposal");
    expect(types.filter(t => t === "text-delta")).toHaveLength(2);
    expect(types.indexOf("proposal")).toBeLessThan(types.indexOf("text-delta"));
    expect(types[types.length - 1]).toBe("done");
    expect(seen.map(e => e.type === "text-delta" ? e.text : "").join("")).toBe("Here is one proposal.");
    const doneEv = seen[seen.length - 1] as Extract<TurnEvent, { type: "done" }>;
    expect(doneEv.log).toEqual({ id: log.id, skipped: false, proposalCount: 1 });

    expect(final).toBe(log);
    expect(final.proposals).toHaveLength(1);
    const p = final.proposals[0] as NewPromptProposal;
    expect(p).toMatchObject({ kind: "new", promptKind: "qa", move: "apply", status: "open" });
    expect((seen[0] as Extract<TurnEvent, { type: "proposal" }>).proposal).toEqual(p);

    expect(final.turns).toHaveLength(1);
    expect(final.turns[0]).toMatchObject({ userMessage: null, steps: 2, tools: ["propose_prompt"] });
    expect(final.turns[0].error).toBeUndefined();

    // transcript: user marker, assistant tool call, tool result, assistant text
    expect(final.messages[0]).toEqual({ role: "user", content: "[session start]" });
    expect(final.messages.map(m => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    // the model saw the brief as instructions
    const call = mock.doStreamCalls[0];
    expect(JSON.stringify(call.prompt[0])).toContain("mental model");
    expect(JSON.stringify(call.prompt[0])).toContain("Proposals used so far: 0 of 5");

    // NEVER-WRITES invariant
    expect(await countRows("prompts")).toBe(promptsBefore);
    expect(await countRows("events")).toBe(eventsBefore);
    await env.BUCKET.delete(`evolve/${promptId}/${log.id}.json`);
  });

  it("skip marks the log, feeds the marker; a stream error still resolves done with turns[].error", async () => {
    const mock = new MockLanguageModelV4({
      doStream: async () => { throw new Error("provider exploded"); }
    });
    const log = await sessionStore.create(env, { promptId, topicId, config: CONFIG });
    const { events, done } = runTurn({ env, model: mock, log, input: { action: "skip" }, now: new Date() });
    const seen = await collect(events);
    const final = await done;
    expect(final.skipped).toBe(true);
    expect(final.messages[0]).toEqual({ role: "user", content: "[skip to proposals]" });
    expect(seen[seen.length - 1]).toEqual({ type: "error", message: "provider exploded" });
    expect(final.turns).toHaveLength(1);
    expect(final.turns[0].error).toBe("provider exploded");
    expect(final.turns[0].userMessage).toBe("[skip to proposals]");
    await env.BUCKET.delete(`evolve/${promptId}/${log.id}.json`);
  });

  it("recommend_fate sets log.fate.recommended and emits a fate event", async () => {
    const mock = new MockLanguageModelV4({
      doStream: [
        toolCallStep("recommend_fate", { fate: "retire", reasoning: "Stable for a year; the neighbours cover it." }),
        textStep("Retire it.")
      ]
    });
    const log = await sessionStore.create(env, { promptId, topicId, config: CONFIG });
    const { events, done } = runTurn({ env, model: mock, log, input: { message: "I think so" }, now: new Date() });
    const seen = await collect(events);
    const final = await done;
    expect(seen[0]).toEqual({ type: "fate", recommendation: { fate: "retire", reasoning: "Stable for a year; the neighbours cover it." } });
    expect(final.fate.recommended?.fate).toBe("retire");
    expect(final.turns[0].userMessage).toBe("I think so");
    await env.BUCKET.delete(`evolve/${promptId}/${log.id}.json`);
  });
});

// ---------------------------------------------------------------------------
// (6) + (7) proposal tools directly
// ---------------------------------------------------------------------------
describe("propose_* tools", () => {
  const valid = {
    promptKind: "qa" as const, question: "q?", answer: "a", move: "deepen" as const, rationale: "r"
  };

  it("enforces the proposal cap across log.proposals and this turn", async () => {
    const log = await sessionStore.create(env, { promptId, topicId, config: CONFIG });
    const open = (i: number): Proposal => ({
      id: `p00000000${i}`, kind: "new", promptKind: "qa", question: `q${i}`, answer: "a", move: "other", rationale: "r", status: "open"
    });
    log.proposals = Array.from({ length: MAX_PROPOSALS }, (_, i) => open(i));
    const ctx = toolCtx(log);
    const tools = makeTools(ctx);
    expect(await tools.propose_prompt.execute!(valid, execOpts)).toEqual({ ok: false, error: "proposal cap reached" });
    expect(await tools.propose_edit.execute!({ question: "q", answer: "a", rationale: "r" }, execOpts))
      .toEqual({ ok: false, error: "proposal cap reached" });
    expect(ctx.emitted).toEqual([]);

    // discarded ones free a slot; the slot is then consumed by this turn
    log.proposals[0].status = "discarded";
    const ok = await tools.propose_prompt.execute!(valid, execOpts) as { ok: boolean; id: string };
    expect(ok.ok).toBe(true);
    expect(ctx.proposalsThisTurn).toHaveLength(1);
    expect(await tools.propose_prompt.execute!(valid, execOpts)).toEqual({ ok: false, error: "proposal cap reached" });
    await env.BUCKET.delete(`evolve/${promptId}/${log.id}.json`);
  });

  it("rejects invalid input without emitting; propose_edit validates against the original's kind", async () => {
    const log = await sessionStore.create(env, { promptId, topicId, config: CONFIG });
    const ctx = toolCtx(log);
    const tools = makeTools(ctx);

    expect(await tools.propose_prompt.execute!({ ...valid, question: "   " }, execOpts)).toEqual({ ok: false, error: "question required" });
    expect(await tools.propose_prompt.execute!({ ...valid, promptKind: "cloze", question: "no span", answer: "" }, execOpts))
      .toEqual({ ok: false, error: "cloze needs at least one {{span}}" });
    expect(await tools.propose_prompt.execute!({ ...valid, answer: "" }, execOpts)).toEqual({ ok: false, error: "answer required for qa" });
    // original is qa → an edit with an empty answer is invalid
    expect(await tools.propose_edit.execute!({ question: "better cue?", answer: "", rationale: "r" }, execOpts))
      .toEqual({ ok: false, error: "answer required for qa" });
    expect(ctx.emitted).toEqual([]);
    expect(ctx.proposalsThisTurn).toEqual([]);

    const row = await env.DB.prepare("SELECT updated_at FROM prompts WHERE id = ?").bind(promptId).first<{ updated_at: string }>();
    const ok = await tools.propose_edit.execute!({ question: "better cue?", answer: "better answer  ", rationale: "r" }, execOpts) as { ok: true; id: string };
    expect(ok.ok).toBe(true);
    expect(ctx.proposalsThisTurn[0]).toMatchObject({
      kind: "edit", id: ok.id, question: "better cue?", answer: "better answer", basedOnUpdatedAt: row!.updated_at, status: "open"
    });
    expect(ctx.emitted).toEqual([{ type: "proposal", proposal: ctx.proposalsThisTurn[0] }]);
    await env.BUCKET.delete(`evolve/${promptId}/${log.id}.json`);
  });
});
