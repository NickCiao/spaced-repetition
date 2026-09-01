export type ParsedPrompt = {
  id: string | null; kind: "qa" | "cloze"; question: string; answer: string; source: string | null;
};
export type ParsedFile = { name: string; url: string | null; meta: Record<string, string>; prompts: ParsedPrompt[] };

export class FormatError extends Error {
  constructor(public path: string, public line: number, message: string) {
    super(`${path}:${line}: ${message}`);
  }
}

/** Lines that collide with the interchange file format (shared with interop's sanitizer). */
export const MARKER = /^(?:(?:Q:|A:|C:|S:)(?: |$)|<!-- id:|---$)/;

/** A cloze prompt must contain at least one {{span}}. */
export const CLOZE_RE = /\{\{[\s\S]+?\}\}/;

/**
 * Shared request validation for prompt create/edit (browse form and refine).
 * Returns an error message, or null if the input is acceptable.
 */
export function validatePromptInput(p: { kind?: string; question?: string; answer?: string }): string | null {
  if (p.kind !== "qa" && p.kind !== "cloze") return "bad kind";
  if (!p.question?.trim()) return "question required";
  if (p.kind === "cloze" && !CLOZE_RE.test(p.question)) return "cloze needs at least one {{span}}";
  if (p.kind === "qa" && !p.answer?.trim()) return "answer required for qa";
  return null;
}

/**
 * A prompt's source is one line of markdown (e.g. "[title](url)" or plain
 * text) — it must stay single-line to round-trip as an `S:` line in the
 * interchange format. Returns an error message, or null if acceptable.
 */
export function validateSourceInput(source: unknown): string | null {
  if (source == null) return null;
  if (typeof source !== "string") return "source must be a string";
  if (/[\r\n]/.test(source)) return "source must be a single line";
  return null;
}

/** Trim a source string; empty becomes null (no attribution). */
export function normalizeSourceInput(source: string | null | undefined): string | null {
  const s = (source ?? "").trim();
  return s || null;
}

/**
 * Trailing whitespace is stripped at write, matching the tail-trimming the
 * interchange format does on parse — otherwise a round-tripped export would
 * diff against the DB row and show up as a phantom dry-run edit. Cloze
 * answers are normalized to empty. Call after validatePromptInput.
 */
export function normalizePromptInput(
  p: { kind?: string; question?: string; answer?: string }
): { question: string; answer: string } {
  return {
    question: (p.question ?? "").replace(/\s+$/, ""),
    answer: p.kind === "cloze" ? "" : (p.answer ?? "").replace(/\s+$/, "")
  };
}

function checkRepresentable(path: string, text: string, kind: string): void {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // The first line of a block legitimately starts with its own marker prefix
    // only in rendered output (we add the prefix); the raw text must not contain marker lines.
    if (MARKER.test(lines[i])) throw new FormatError(path, i + 1, `${kind} contains a line that collides with the file format ("${lines[i].slice(0, 20)}…")`);
  }
}

export function renderTopicFile(
  topic: { name: string; url: string | null; meta: string },
  prompts: { id: string; kind: "qa" | "cloze"; question: string; answer: string; source: string | null }[]
): string {
  // Render refuses anything that cannot round-trip exactly — silent drift on
  // re-import would be data corruption (import treats files as desired state).
  if (!topic.name?.trim()) throw new FormatError("(render)", 1, "topic name required");
  if (/[\r\n]/.test(topic.name)) throw new FormatError("(render)", 1, "topic name must be single-line");
  if (topic.url != null && /[\r\n]/.test(topic.url)) throw new FormatError("(render)", 1, "topic url must be single-line");
  let meta: Record<string, unknown>;
  try { meta = JSON.parse(topic.meta || "{}") as Record<string, unknown>; }
  catch { throw new FormatError("(render)", 1, "topic meta is not valid JSON"); }
  for (const [k, v] of Object.entries(meta)) {
    // "source" stays reserved: legacy files use it as the topic-name key.
    if (!/^[A-Za-z0-9_-]+$/.test(k) || k === "topic" || k === "source" || k === "url")
      throw new FormatError("(render)", 1, `meta key "${k}" cannot round-trip`);
    if (typeof v !== "string" || /[\r\n]/.test(v))
      throw new FormatError("(render)", 1, `meta value for "${k}" must be a single-line string`);
  }
  let out = `---\ntopic: ${topic.name}\n`;
  if (topic.url) out += `url: ${topic.url}\n`;
  for (const k of Object.keys(meta).sort()) out += `${k}: ${meta[k]}\n`;
  out += "---\n";
  for (const p of prompts) {
    if (!/^[A-Za-z0-9]+$/.test(p.id))
      throw new FormatError("(render)", 1, `prompt id "${p.id}" cannot round-trip`);
    if (p.kind === "cloze" && p.answer.trim() !== "")
      throw new FormatError("(render)", 1, "cloze prompts must have an empty answer");
    if (p.source != null && (/[\r\n]/.test(p.source) || p.source.trim() !== p.source || !p.source))
      throw new FormatError("(render)", 1, "prompt source must be a trimmed single-line string");
    checkRepresentable("(render)", p.question, "question");
    checkRepresentable("(render)", p.answer, "answer");
    out += "\n";
    if (p.kind === "qa") out += `Q: ${p.question}\nA: ${p.answer}\n`;
    else out += `C: ${p.question}\n`;
    if (p.source) out += `S: ${p.source}\n`;
    out += `<!-- id: ${p.id} -->\n`;
  }
  return out;
}

export function parseTopicFile(text: string, path: string): ParsedFile {
  const lines = text.replace(/\r\n?/g, "\n").split("\n"); // CRLF/CR input parses identically to LF
  let i = 0;
  const fail = (line: number, msg: string): never => { throw new FormatError(path, line, msg); };

  if (lines[i] !== "---") fail(1, "missing frontmatter");
  i++;
  const front: Record<string, string> = {};
  while (i < lines.length && lines[i] !== "---") {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (!m) fail(i + 1, "bad frontmatter line");
    front[m![1]] = m![2];
    i++;
  }
  if (i >= lines.length) fail(i, "unterminated frontmatter");
  i++;
  // "source" is the legacy key for the same field — zips exported before the
  // topic rename must keep restoring byte-identically.
  if (front["topic"] != null && front["source"] != null)
    fail(1, "frontmatter has both 'topic' and legacy 'source'");
  const name = front["topic"] ?? front["source"];
  if (!name) fail(1, "frontmatter missing 'topic'");
  const url = front["url"] ?? null;
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(front)) if (k !== "topic" && k !== "source" && k !== "url") meta[k] = v;

  const prompts: ParsedPrompt[] = [];
  let cur: {
    kind: "qa" | "cloze"; q: string[]; a: string[]; source: string | null; mode: "q" | "a"; line: number;
  } | null = null;

  // Blank lines INSIDE a block are content (multi-paragraph markdown answers);
  // a block ends only at an id comment, the next Q:/C:/A: marker, or EOF.
  // Trailing blank lines are trimmed at finish so render ∘ parse stays exact.
  const trimTail = (arr: string[]) => {
    while (arr.length && arr[arr.length - 1].trim() === "") arr.pop();
    return arr;
  };

  const finish = (id: string | null, atLine: number) => {
    if (!cur) return;
    const question = trimTail(cur.q).join("\n");
    const answer = trimTail(cur.a).join("\n");
    if (cur.kind === "cloze" && !CLOZE_RE.test(question))
      fail(cur.line, "cloze block has no {{span}}");
    if (cur.kind === "qa" && cur.mode === "q") fail(cur.line, "Q block without A:");
    if (id && prompts.some(p => p.id === id)) fail(atLine, `duplicate id ${id}`);
    prompts.push({ id, kind: cur.kind, question, answer, source: cur.source });
    cur = null;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const idMatch = line.match(/^<!-- id: ([A-Za-z0-9]+) -->$/);
    if (idMatch) { if (!cur) fail(i + 1, "id comment without a prompt block"); finish(idMatch[1], i + 1); continue; }
    if (line.startsWith("Q: ") || line === "Q:") {
      finish(null, i + 1);
      cur = { kind: "qa", q: [line.slice(3)], a: [], source: null, mode: "q", line: i + 1 };
    } else if (line.startsWith("C: ") || line === "C:") {
      finish(null, i + 1);
      cur = { kind: "cloze", q: [line.slice(3)], a: [], source: null, mode: "q", line: i + 1 };
    } else if (line.startsWith("A: ") || line === "A:") {
      if (!cur || cur.kind !== "qa" || cur.mode === "a") fail(i + 1, "A: without a Q block");
      cur!.mode = "a";
      cur!.a.push(line.slice(3));
    } else if (line.startsWith("S: ") || line === "S:") {
      // Optional attribution: one S: line, only after a completed block body.
      if (!cur) fail(i + 1, "S: without a prompt block");
      if (cur!.kind === "qa" && cur!.mode === "q") fail(i + 1, "S: before A:");
      if (cur!.source != null) fail(i + 1, "duplicate S: line");
      const src = line.slice(3).replace(/\s+$/, "");
      if (!src) fail(i + 1, "empty S: line");
      cur!.source = src;
    } else if (line.trim() === "") {
      // Content, trimmed at finish if trailing; after S: nothing but blanks may follow.
      if (cur && cur.source == null) (cur.mode === "q" ? cur.q : cur.a).push(line);
    } else {
      if (!cur) fail(i + 1, `unexpected content outside a prompt block: "${line.slice(0, 30)}"`);
      if (cur!.source != null) fail(i + 1, "content after S: line");
      (cur!.mode === "q" ? cur!.q : cur!.a).push(line);
    }
  }
  finish(null, lines.length);
  return { name: name!, url, meta, prompts };
}

export function topicFileName(name: string, id: string): string {
  const slug = name.toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `prompts/${slug || "topic"}-${id}.md`;
}
