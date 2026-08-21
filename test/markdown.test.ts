import { describe, expect, it } from "vitest";
import { renderMarkdown, renderPromptAnswer, renderPromptQuestion } from "../src/markdown";

describe("renderMarkdown", () => {
  it("renders code blocks and inline code", () => {
    const html = renderMarkdown("Use `foo()`\n\n```\nbar()\n```");
    expect(html).toContain("<code>foo()</code>");
    expect(html).toContain("<pre>");
  });

  it("escapes raw HTML instead of rendering it", () => {
    const html = renderMarkdown('hello <script>alert(1)</script> <b>bold?</b>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders inline and display math via KaTeX", () => {
    const html = renderMarkdown("Euler: $e^{i\\pi}+1=0$ and $$\\frac{a}{b}$$");
    expect(html).toContain("katex");
    expect(html).not.toContain("$e^");
  });

  it("keeps math out of markdown's reach", () => {
    const html = renderMarkdown("$a_i + a_j$"); // underscores must not become <em>
    expect(html).not.toContain("<em>");
  });

  it("rewrites relative asset refs to /assets/<id>", () => {
    const html = renderMarkdown("![diagram](assets/abc123def0)");
    expect(html).toContain('src="/assets/abc123def0"');
  });
});

describe("cloze", () => {
  const text = "FSRS models memory with {{stability}} and {{difficulty}}.";
  it("question masks every span", () => {
    const q = renderPromptQuestion("cloze", text);
    expect(q).toContain('<span class="cloze">[…]</span>');
    expect(q).not.toContain("stability");
    expect(q).not.toContain("{{");
  });
  it("answer reveals spans with highlight", () => {
    const a = renderPromptAnswer("cloze", text, "");
    expect(a).toContain('<span class="cloze-revealed">stability</span>');
    expect(a).not.toContain("{{");
  });
  it("qa passthrough", () => {
    expect(renderPromptQuestion("qa", "What?")).toContain("What?");
    expect(renderPromptAnswer("qa", "What?", "This.")).toContain("This.");
  });
});
