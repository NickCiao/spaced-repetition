import { CLOZE_RE } from "./format";

/**
 * Authoring hints: cheap, line-level heuristics over a prompt's raw markdown
 * that flag the ways this renderer (standard markdown, `breaks: false`,
 * `$…$` math, `{{…}}` cloze, assets-only images, http(s)-only links, HTML
 * escaped) is most often misread. They ride along with `/api/preview` so
 * the editor can show them next to the rendered result. Pure; no I/O.
 */
export type Hint = { field: "question" | "answer"; message: string };

export const HINT = {
  bulletGlue: "A line right after a bullet joins that bullet. Add a blank line before it, or start it with `- `.",
  joinedLines: "Single line breaks are joined into one paragraph. Leave a blank line to start a new one.",
  clozeMissing: "Cloze needs at least one {{hidden}} span — select text and use Hide selection.",
  clozeUnbalanced: "Unbalanced {{ }} — a cloze span is not closed.",
  mathUnmatched: "Unmatched `$` — inline math needs a closing `$` on the same line.",
  html: "HTML tags are shown as text, not rendered.",
  image: "Only attached images (`assets/…`) render; other image URLs show as text.",
  link: "Links need a full http(s):// URL; anything else renders as plain text."
} as const;

const BLANK_RE = /^\s*$/;
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;
const LIST_RE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
const BLOCK_RE = /^\s{0,3}(?:#{1,6}\s|>|\|)|^\s{0,3}(?:[-*_])(?:\s*[-*_]){2,}\s*$|^ {4,}\S|^\t/;
const HARD_BREAK_RE = /(?: {2,}|\\)$/;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const DISPLAY_MATH_RE = /\$\$[\s\S]+?\$\$/g;
const TAG_RE = /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/;
const IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
const LINK_RE = /(^|[^!])\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
const ASSET_RE = /^\/?assets\/[0-9a-f]{32}$/;

type LineKind = "blank" | "list" | "para" | "block";

function classify(line: string): LineKind {
  if (BLANK_RE.test(line)) return "blank";
  if (LIST_RE.test(line)) return "list";
  if (BLOCK_RE.test(line)) return "block";
  return "para";
}

/** An indented line after a bullet is a deliberate continuation: keep list context. */
function nextContext(prev: LineKind, kind: LineKind, indented: boolean): LineKind {
  return kind === "para" && indented && prev === "list" ? "list" : kind;
}

function bodyHints(text: string): Set<string> {
  const out = new Set<string>();
  // Display math is pulled out before markdown runs, so its inner lines are
  // never paragraphs; collapse each block to a single opaque token first.
  const lines = text.replace(DISPLAY_MATH_RE, "\u2063M\u2063").split(/\r?\n/);

  let inFence = false;
  let prev: LineKind = "blank";
  let prevHardBreak = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      prev = "block";
      prevHardBreak = false;
      continue;
    }
    if (inFence) continue;

    const kind = classify(line);
    const indented = /^\s/.test(line);
    if (kind === "para") {
      if (prev === "list" && !indented) out.add(HINT.bulletGlue);
      else if (prev === "para" && !prevHardBreak) out.add(HINT.joinedLines);
    }

    if (kind !== "blank") {
      const plain = line.replace(INLINE_CODE_RE, "");
      const dollars = (plain.match(/\$/g) ?? []).length;
      if (dollars % 2 === 1) out.add(HINT.mathUnmatched);
      if (TAG_RE.test(plain)) out.add(HINT.html);
      for (const m of plain.matchAll(IMAGE_RE)) if (!ASSET_RE.test(m[1])) out.add(HINT.image);
      for (const m of plain.matchAll(LINK_RE)) if (!/^https?:\/\//i.test(m[2])) out.add(HINT.link);
    }

    prev = nextContext(prev, kind, indented);
    prevHardBreak = HARD_BREAK_RE.test(line);
  }
  return out;
}

function clozeHints(question: string): Set<string> {
  const out = new Set<string>();
  if (!CLOZE_RE.test(question)) out.add(HINT.clozeMissing);
  const opens = (question.match(/\{\{/g) ?? []).length;
  const closes = (question.match(/\}\}/g) ?? []).length;
  if (opens !== closes) out.add(HINT.clozeUnbalanced);
  return out;
}

export function promptHints(kind: "qa" | "cloze", question: string, answer: string): Hint[] {
  const out: Hint[] = [];
  const push = (field: Hint["field"], messages: Iterable<string>) => {
    for (const message of messages) out.push({ field, message });
  };
  push("question", bodyHints(question));
  if (kind === "cloze") push("question", clozeHints(question));
  else push("answer", bodyHints(answer));
  return out;
}
