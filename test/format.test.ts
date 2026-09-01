import { describe, expect, it } from "vitest";
import { FormatError, parseTopicFile, renderTopicFile, topicFileName } from "../src/format";

const topic = { name: "Why We Think", url: "https://ex.com/think", meta: '{"x-author":"Weng"}' };
const prompts = [
  {
    id: "aaaaaaaaaa", kind: "qa" as const, question: "Multi\nline Q?", answer: "Para one.\n\nPara two.",
    source: "[Why We Think](https://ex.com/think)"
  },
  { id: "bbbbbbbbbb", kind: "cloze" as const, question: "Hide {{this}} and {{that}}.", answer: "", source: null }
];

describe("interchange format", () => {
  it("renders the documented shape", () => {
    const text = renderTopicFile(topic, prompts);
    expect(text).toContain("---\ntopic: Why We Think\nurl: https://ex.com/think\nx-author: Weng\n---");
    expect(text).toContain("Q: Multi\nline Q?");
    expect(text).toContain("A: Para one.\n\nPara two."); // blank lines inside a block are content
    expect(text).toContain("S: [Why We Think](https://ex.com/think)\n<!-- id: aaaaaaaaaa -->");
    expect(text).toContain("C: Hide {{this}} and {{that}}.\n<!-- id: bbbbbbbbbb -->"); // no S: when null
  });

  it("round-trips: parse(render(x)) == x", () => {
    const parsed = parseTopicFile(renderTopicFile(topic, prompts), "prompts/why.md");
    expect(parsed.name).toBe(topic.name);
    expect(parsed.url).toBe(topic.url);
    expect(parsed.meta).toEqual({ "x-author": "Weng" });
    expect(parsed.prompts).toEqual(prompts.map(p => ({ ...p })));
  });

  it("round-trips 50 random files", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const word = () => "w" + Math.floor(rnd() * 1e6).toString(36);
    for (let f = 0; f < 50; f++) {
      const ps = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => {
        const cloze = rnd() < 0.4;
        return {
          id: (i + 10).toString(36).repeat(5).slice(0, 10),
          kind: (cloze ? "cloze" : "qa") as "qa" | "cloze",
          question: cloze ? `${word()} {{${word()}}} ${word()}\n${word()}` : `${word()}\n${word()} ?`,
          answer: cloze ? "" : `${word()} $x_${f}$\n${word()}`,
          source: rnd() < 0.5 ? `[${word()}](https://e.com/${word()})` : null
        };
      });
      const t = { name: `Topic ${word()}`, url: rnd() < 0.5 ? `https://e.com/${word()}` : null, meta: "{}" };
      const parsed = parseTopicFile(renderTopicFile(t, ps), "prompts/r.md");
      expect(parsed.prompts).toEqual(ps);
      expect(parsed.name).toBe(t.name);
    }
  });

  it("parses prompts without ids as id: null", () => {
    const text = `---\ntopic: T\n---\n\nQ: q?\nA: a.\n`;
    const parsed = parseTopicFile(text, "prompts/t.md");
    expect(parsed.prompts).toEqual([{ id: null, kind: "qa", question: "q?", answer: "a.", source: null }]);
  });

  it("parses the legacy 'source:' frontmatter key as the topic name", () => {
    const parsed = parseTopicFile(`---\nsource: Old Export\n---\n\nQ: q?\nA: a.\n`, "prompts/old.md");
    expect(parsed.name).toBe("Old Export");
    expect(parsed.meta).toEqual({}); // legacy key is the name, not passthrough meta
    expect(() => parseTopicFile(`---\ntopic: A\nsource: B\n---\n`, "p.md"))
      .toThrow(/both 'topic' and legacy 'source'/);
  });

  it("parses S: attribution lines", () => {
    const text = `---\ntopic: T\n---\n\nQ: q?\nA: a.\nS: [paper](https://ex.com/p)\n\nC: hide {{x}}\nS: a chat\n`;
    const parsed = parseTopicFile(text, "prompts/t.md");
    expect(parsed.prompts.map(p => p.source)).toEqual(["[paper](https://ex.com/p)", "a chat"]);
  });

  it("rejects malformed S: lines", () => {
    expect(() => parseTopicFile(`---\ntopic: T\n---\n\nS: orphan\n`, "p.md")).toThrow(/S: without a prompt block/);
    expect(() => parseTopicFile(`---\ntopic: T\n---\n\nQ: q?\nS: early\nA: a.\n`, "p.md")).toThrow(/S: before A:/);
    expect(() => parseTopicFile(`---\ntopic: T\n---\n\nQ: q?\nA: a.\nS: one\nS: two\n`, "p.md")).toThrow(/duplicate S:/);
    expect(() => parseTopicFile(`---\ntopic: T\n---\n\nQ: q?\nA: a.\nS:\n`, "p.md")).toThrow(/empty S:/);
    expect(() => parseTopicFile(`---\ntopic: T\n---\n\nQ: q?\nA: a.\nS: src\ntrailing content\n`, "p.md"))
      .toThrow(/content after S:/);
  });

  it("errors carry path and line", () => {
    const bad = `---\ntopic: T\n---\n\nA: answer with no question\n`;
    try {
      parseTopicFile(bad, "prompts/bad.md");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FormatError);
      expect((e as FormatError).path).toBe("prompts/bad.md");
      expect((e as FormatError).line).toBe(5);
    }
    expect(() => parseTopicFile("no frontmatter", "p.md")).toThrow(FormatError);
    expect(() => parseTopicFile(`---\ntopic: T\n---\n\nC: no spans here\n`, "p.md")).toThrow(FormatError);
    expect(() => parseTopicFile(`---\ntopic: T\n---\n\nQ: q?\nA: a.\n<!-- id: aa -->\n\nQ: q2?\nA: a2.\n<!-- id: aa -->\n`, "p.md"))
      .toThrow(/duplicate id/i);
  });

  it("render refuses unrepresentable text", () => {
    expect(() => renderTopicFile(topic, [{ id: "cccccccccc", kind: "qa", question: "ok?", answer: "A: looks like a marker", source: null }]))
      .toThrow(FormatError);
    // Bare markers (marker + end-of-line, no trailing space) used to slip past the guard.
    expect(() => renderTopicFile(topic, [{ id: "cccccccccc", kind: "qa", question: "ok?", answer: "line one\nC:\nline three", source: null }]))
      .toThrow(FormatError);
    expect(() => renderTopicFile(topic, [{ id: "cccccccccc", kind: "qa", question: "ok?", answer: "A:", source: null }]))
      .toThrow(FormatError);
    // S: is a marker now too — content containing it cannot round-trip.
    expect(() => renderTopicFile(topic, [{ id: "cccccccccc", kind: "qa", question: "ok?", answer: "S: sneaky", source: null }]))
      .toThrow(FormatError);
  });

  it("render refuses ids, meta, cloze answers, sources, and names that cannot round-trip", () => {
    expect(() => renderTopicFile(topic, [{ id: "abc-123-def", kind: "qa", question: "q?", answer: "a.", source: null }])).toThrow(FormatError);
    expect(() => renderTopicFile({ name: "T", url: null, meta: '{"x:evil":"v"}' }, [])).toThrow(FormatError);
    expect(() => renderTopicFile({ name: "T", url: null, meta: '{"note":"line1\nline2"}' }, [])).toThrow(FormatError);
    expect(() => renderTopicFile({ name: "T", url: null, meta: "{not json" }, [])).toThrow(FormatError);
    expect(() => renderTopicFile({ name: "", url: null, meta: "{}" }, [])).toThrow(FormatError);
    expect(() => renderTopicFile(topic, [{ id: "cccccccccc", kind: "cloze", question: "Hide {{x}}.", answer: "stray", source: null }])).toThrow(FormatError);
    expect(() => renderTopicFile({ name: "a\nb", url: null, meta: "{}" }, [])).toThrow(FormatError);
    expect(() => renderTopicFile({ name: "T", url: "https://x\nevil: y", meta: "{}" }, [])).toThrow(FormatError);
    // "topic" and legacy "source" are both reserved meta keys.
    expect(() => renderTopicFile({ name: "T", url: null, meta: '{"topic":"v"}' }, [])).toThrow(FormatError);
    expect(() => renderTopicFile({ name: "T", url: null, meta: '{"source":"v"}' }, [])).toThrow(FormatError);
    // Sources must be trimmed single lines (normalized at input).
    expect(() => renderTopicFile(topic, [{ id: "cccccccccc", kind: "qa", question: "q?", answer: "a.", source: "two\nlines" }])).toThrow(FormatError);
    expect(() => renderTopicFile(topic, [{ id: "cccccccccc", kind: "qa", question: "q?", answer: "a.", source: " padded " }])).toThrow(FormatError);
    expect(() => renderTopicFile(topic, [{ id: "cccccccccc", kind: "qa", question: "q?", answer: "a.", source: "" }])).toThrow(FormatError);
  });

  it("parses CRLF input identically to LF", () => {
    const text = renderTopicFile(topic, prompts);
    expect(parseTopicFile(text.replace(/\n/g, "\r\n"), "p.md")).toEqual(parseTopicFile(text, "p.md"));
  });

  it("topicFileName slugs safely", () => {
    expect(topicFileName("Why We Think — Lilian Weng!", "abc123def0"))
      .toBe("prompts/why-we-think-lilian-weng-abc123def0.md");
  });
});
