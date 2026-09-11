import { describe, expect, it } from "vitest";
import { HINT, promptHints } from "../src/hints";

const msgs = (kind: "qa" | "cloze", q: string, a = "") => promptHints(kind, q, a).map(h => h.message);

describe("promptHints — line breaks", () => {
  it("flags a plain line glued to the bullet above (the screenshot case)", () => {
    const answer = "- `GetItem` — exact lookup\n- `Query` — partition key\nGSI / LSI — secondary indexes";
    const hints = promptHints("qa", "q?", answer);
    expect(hints).toContainEqual({ field: "answer", message: HINT.bulletGlue });
    expect(hints.map(h => h.message)).not.toContain(HINT.joinedLines);
  });

  it("does not flag a list separated from following text by a blank line", () => {
    expect(msgs("qa", "q?", "- a\n- b\n\nGSI / LSI")).toEqual([]);
  });

  it("treats an indented line after a bullet as a deliberate continuation", () => {
    expect(msgs("qa", "q?", "- a\n  continues here\n- b")).toEqual([]);
  });

  it("flags consecutive paragraph lines that will be joined", () => {
    expect(msgs("qa", "q?", "Line one\nLine two")).toEqual([HINT.joinedLines]);
  });

  it("accepts blank-line paragraphs and hard breaks", () => {
    expect(msgs("qa", "q?", "Line one\n\nLine two")).toEqual([]);
    expect(msgs("qa", "q?", "Line one  \nLine two")).toEqual([]);
    expect(msgs("qa", "q?", "Line one\\\nLine two")).toEqual([]);
  });

  it("ignores fenced code, headings, quotes, tables and display math", () => {
    expect(msgs("qa", "q?", "```\nfoo\nbar\n```")).toEqual([]);
    expect(msgs("qa", "q?", "# Title\nBody")).toEqual([]);
    expect(msgs("qa", "q?", "> quoted\n> more")).toEqual([]);
    expect(msgs("qa", "q?", "| a | b |\n|---|---|\n| 1 | 2 |")).toEqual([]);
    expect(msgs("qa", "q?", "$$\nx = 1\n$$")).toEqual([]);
  });

  it("reports the field each hint belongs to", () => {
    const hints = promptHints("qa", "Q one\nQ two", "- a\nb");
    expect(hints).toContainEqual({ field: "question", message: HINT.joinedLines });
    expect(hints).toContainEqual({ field: "answer", message: HINT.bulletGlue });
  });
});

describe("promptHints — cloze", () => {
  it("wants at least one span and balanced braces", () => {
    expect(msgs("cloze", "no spans here")).toContain(HINT.clozeMissing);
    expect(msgs("cloze", "A {{quorum}} is {{unclosed")).toContain(HINT.clozeUnbalanced);
    expect(msgs("cloze", "A {{quorum}} is a majority.")).toEqual([]);
  });

  it("does not lint the answer of a cloze prompt", () => {
    expect(promptHints("cloze", "A {{x}}.", "junk\nlines").every(h => h.field === "question")).toBe(true);
  });
});

describe("promptHints — inline syntax", () => {
  it("flags an unmatched inline $ but not balanced math or code", () => {
    expect(msgs("qa", "q?", "costs $5")).toEqual([HINT.mathUnmatched]);
    expect(msgs("qa", "q?", "$x^2$ and `$` in code")).toEqual([]);
    expect(msgs("qa", "q?", "$$\\int$$")).toEqual([]);
  });

  it("flags raw HTML, non-asset images and non-http links", () => {
    expect(msgs("qa", "q?", "a <b>bold</b> tag")).toEqual([HINT.html]);
    expect(msgs("qa", "q?", "![](https://ex.com/pic.png)")).toEqual([HINT.image]);
    expect(msgs("qa", "q?", `![](assets/${"a".repeat(32)})`)).toEqual([]);
    expect(msgs("qa", "q?", "[doc](docs/readme.md)")).toEqual([HINT.link]);
    expect(msgs("qa", "q?", "[doc](https://ex.com)")).toEqual([]);
  });

  it("leaves code spans and fenced blocks alone", () => {
    expect(msgs("qa", "q?", "`<div>` is a tag")).toEqual([]);
    expect(msgs("qa", "q?", "```html\n<div>$</div>\n```")).toEqual([]);
  });

  it("dedupes a repeated hint within a field", () => {
    expect(msgs("qa", "q?", "<b>x</b>\n\n<i>y</i>")).toEqual([HINT.html]);
  });
});
