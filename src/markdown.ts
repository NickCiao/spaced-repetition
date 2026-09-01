import { Marked } from "marked";
import katex from "katex";
import { escapeHtml } from "./html";

const preclean = (text: string) => text.replace(/⁣/g, "");

// Placeholder protocol: math and cloze fragments are pulled out before the
// markdown pass (so marked can't mangle them) and re-inserted afterwards.
const SLOT = (i: number) => `\u2063SR${i}\u2063`; // invisible separator, survives marked untouched

function makeMarked(): Marked {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      html(token: { text: string }) { return escapeHtml(token.text); },
      image(token: { href: string; text: string }) {
        const href = token.href.startsWith("assets/") ? `/${token.href}` : token.href;
        // Strict id charset — anything else renders as escaped literal text.
        // Interpolating an unvalidated href into src= is an attribute-injection XSS.
        if (!/^\/assets\/[0-9a-f]{32}$/.test(href)) return escapeHtml(`![${token.text}](${token.href})`);
        return `<img src="${href}" alt="${escapeHtml(token.text)}" loading="lazy">`;
      },
      link(token: { href: string; text: string }) {
        // http(s) only — javascript: etc. render as escaped plain text.
        if (!/^https?:\/\//i.test(token.href)) return escapeHtml(token.text);
        return `<a href="${escapeHtml(token.href)}" rel="noopener">${escapeHtml(token.text)}</a>`;
      }
    }
  });
  return marked;
}

function renderWithSlots(text: string, slots: string[]): string {
  let html = makeMarked().parse(text) as string;
  slots.forEach((frag, i) => { html = html.split(SLOT(i)).join(frag); });
  return html;
}

function extractMath(text: string, slots: string[]): string {
  return text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => {
      slots.push(katex.renderToString(tex, { displayMode: true, throwOnError: false }));
      return SLOT(slots.length - 1);
    })
    .replace(/\$([^$\n]+?)\$/g, (_, tex: string) => {
      slots.push(katex.renderToString(tex, { displayMode: false, throwOnError: false }));
      return SLOT(slots.length - 1);
    });
}

export function renderMarkdown(text: string): string {
  text = preclean(text);
  const slots: string[] = [];
  return renderWithSlots(extractMath(text, slots), slots);
}

/**
 * Inline-only markdown (links, emphasis, code, math) for a prompt's one-line
 * source attribution — no <p> wrapper, so it can sit inside "from …".
 */
export function renderSourceLine(source: string): string {
  const slots: string[] = [];
  let html = makeMarked().parseInline(extractMath(preclean(source), slots)) as string;
  slots.forEach((frag, i) => { html = html.split(SLOT(i)).join(frag); });
  return html;
}

function renderCloze(text: string, mode: "mask" | "reveal"): string {
  text = preclean(text);
  const slots: string[] = [];
  const substituted = text.replace(/\{\{([\s\S]+?)\}\}/g, (_, inner: string) => {
    slots.push(
      mode === "mask"
        ? `<span class="cloze">[…]</span>`
        : `<span class="cloze-revealed">${escapeHtml(inner)}</span>`
    );
    return SLOT(slots.length - 1);
  });
  return renderWithSlots(extractMath(substituted, slots), slots);
}

export function renderPromptQuestion(kind: "qa" | "cloze", question: string): string {
  return kind === "cloze" ? renderCloze(question, "mask") : renderMarkdown(question);
}

export function renderPromptAnswer(kind: "qa" | "cloze", question: string, answer: string): string {
  return kind === "cloze" ? renderCloze(question, "reveal") : renderMarkdown(answer);
}
