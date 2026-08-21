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

  it("rewrites relative asset refs to /assets/<id> (32-hex ids only)", () => {
    const id = "abc123def0abc123def0abc123def012";
    expect(renderMarkdown(`![diagram](assets/${id})`)).toContain(`src="/assets/${id}"`);
  });

  it("hostile hrefs cannot inject markup or scripts", () => {
    const img = renderMarkdown('![x](assets/a"onerror="alert(1))');
    expect(img).not.toContain("<img");
    expect(img).not.toContain('onerror="'); // escaped output contains onerror=&quot; which is inert
    const link = renderMarkdown("[click](javascript:alert(1))");
    expect(link).not.toContain("javascript:");
    expect(link).not.toContain("<a ");
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

  it("literal U+2063 in input cannot corrupt placeholder reinsertion", () => {
    const html = renderPromptQuestion("cloze", "⁣SR0⁣ literal and {{secret}}");
    expect(html).toContain("literal");
    expect(html).not.toContain("secret");
    expect((html.match(/\[…\]/g) ?? []).length).toBe(1);
  });
});
