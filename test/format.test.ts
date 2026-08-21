import { describe, expect, it } from "vitest";
import { FormatError, parseSourceFile, renderSourceFile, sourceFileName } from "../src/format";

const src = { name: "Why We Think", url: "https://ex.com/think", meta: '{"x-author":"Weng"}' };
const prompts = [
  { id: "aaaaaaaaaa", kind: "qa" as const, question: "Multi\nline Q?", answer: "Para one.\n\nPara two." },
  { id: "bbbbbbbbbb", kind: "cloze" as const, question: "Hide {{this}} and {{that}}.", answer: "" }
];

describe("interchange format", () => {
  it("renders the documented shape", () => {
    const text = renderSourceFile(src, prompts);
    expect(text).toContain("---\nsource: Why We Think\nurl: https://ex.com/think\nx-author: Weng\n---");
    expect(text).toContain("Q: Multi\nline Q?");
    expect(text).toContain("A: Para one.\n\nPara two."); // blank lines inside a block are content
    expect(text).toContain("<!-- id: aaaaaaaaaa -->");
    expect(text).toContain("C: Hide {{this}} and {{that}}.");
  });

  it("round-trips: parse(render(x)) == x", () => {
    const parsed = parseSourceFile(renderSourceFile(src, prompts), "prompts/why.md");
    expect(parsed.name).toBe(src.name);
    expect(parsed.url).toBe(src.url);
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
          answer: cloze ? "" : `${word()} $x_${f}$\n${word()}`
        };
      });
      const s = { name: `Src ${word()}`, url: rnd() < 0.5 ? `https://e.com/${word()}` : null, meta: "{}" };
      const parsed = parseSourceFile(renderSourceFile(s, ps), "prompts/r.md");
      expect(parsed.prompts).toEqual(ps);
      expect(parsed.name).toBe(s.name);
    }
  });

  it("parses prompts without ids as id: null", () => {
    const text = `---\nsource: S\n---\n\nQ: q?\nA: a.\n`;
    const parsed = parseSourceFile(text, "prompts/s.md");
    expect(parsed.prompts).toEqual([{ id: null, kind: "qa", question: "q?", answer: "a." }]);
  });

  it("errors carry path and line", () => {
    const bad = `---\nsource: S\n---\n\nA: answer with no question\n`;
    try {
      parseSourceFile(bad, "prompts/bad.md");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FormatError);
      expect((e as FormatError).path).toBe("prompts/bad.md");
      expect((e as FormatError).line).toBe(5);
    }
    expect(() => parseSourceFile("no frontmatter", "p.md")).toThrow(FormatError);
    expect(() => parseSourceFile(`---\nsource: S\n---\n\nC: no spans here\n`, "p.md")).toThrow(FormatError);
    expect(() => parseSourceFile(`---\nsource: S\n---\n\nQ: q?\nA: a.\n<!-- id: aa -->\n\nQ: q2?\nA: a2.\n<!-- id: aa -->\n`, "p.md"))
      .toThrow(/duplicate id/i);
  });

  it("render refuses unrepresentable text", () => {
    expect(() => renderSourceFile(src, [{ id: "cccccccccc", kind: "qa", question: "ok?", answer: "A: looks like a marker" }]))
      .toThrow(FormatError);
  });

  it("sourceFileName slugs safely", () => {
    expect(sourceFileName("Why We Think — Lilian Weng!", "abc123def0"))
      .toBe("prompts/why-we-think-lilian-weng-abc123def0.md");
  });
});
