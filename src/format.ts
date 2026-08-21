export type ParsedPrompt = { id: string | null; kind: "qa" | "cloze"; question: string; answer: string };
export type ParsedFile = { name: string; url: string | null; meta: Record<string, string>; prompts: ParsedPrompt[] };

export class FormatError extends Error {
  constructor(public path: string, public line: number, message: string) {
    super(`${path}:${line}: ${message}`);
  }
}

const MARKER = /^(Q: |A: |C: |<!-- id:)|^---$/;

function checkRepresentable(path: string, text: string, kind: string): void {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // The first line of a block legitimately starts with its own marker prefix
    // only in rendered output (we add the prefix); the raw text must not contain marker lines.
    if (MARKER.test(lines[i])) throw new FormatError(path, i + 1, `${kind} contains a line that collides with the file format ("${lines[i].slice(0, 20)}…")`);
  }
}

export function renderSourceFile(
  source: { name: string; url: string | null; meta: string },
  prompts: { id: string; kind: "qa" | "cloze"; question: string; answer: string }[]
): string {
  // Render refuses anything that cannot round-trip exactly — silent drift on
  // re-import would be data corruption (import treats files as desired state).
  if (!source.name?.trim()) throw new FormatError("(render)", 1, "source name required");
  let meta: Record<string, unknown>;
  try { meta = JSON.parse(source.meta || "{}") as Record<string, unknown>; }
  catch { throw new FormatError("(render)", 1, "source meta is not valid JSON"); }
  for (const [k, v] of Object.entries(meta)) {
    if (!/^[A-Za-z0-9_-]+$/.test(k) || k === "source" || k === "url")
      throw new FormatError("(render)", 1, `meta key "${k}" cannot round-trip`);
    if (typeof v !== "string" || /[\r\n]/.test(v))
      throw new FormatError("(render)", 1, `meta value for "${k}" must be a single-line string`);
  }
  let out = `---\nsource: ${source.name}\n`;
  if (source.url) out += `url: ${source.url}\n`;
  for (const k of Object.keys(meta).sort()) out += `${k}: ${meta[k]}\n`;
  out += "---\n";
  for (const p of prompts) {
    if (!/^[A-Za-z0-9]+$/.test(p.id))
      throw new FormatError("(render)", 1, `prompt id "${p.id}" cannot round-trip`);
    if (p.kind === "cloze" && p.answer.trim() !== "")
      throw new FormatError("(render)", 1, "cloze prompts must have an empty answer");
    checkRepresentable("(render)", p.question, "question");
    checkRepresentable("(render)", p.answer, "answer");
    out += "\n";
    if (p.kind === "qa") out += `Q: ${p.question}\nA: ${p.answer}\n`;
    else out += `C: ${p.question}\n`;
    out += `<!-- id: ${p.id} -->\n`;
  }
  return out;
}

export function parseSourceFile(text: string, path: string): ParsedFile {
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
  const name = front["source"];
  if (!name) fail(1, "frontmatter missing 'source'");
  const url = front["url"] ?? null;
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(front)) if (k !== "source" && k !== "url") meta[k] = v;

  const prompts: ParsedPrompt[] = [];
  let cur: { kind: "qa" | "cloze"; q: string[]; a: string[]; mode: "q" | "a"; line: number } | null = null;

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
    if (cur.kind === "cloze" && !/\{\{[\s\S]+?\}\}/.test(question))
      fail(cur.line, "cloze block has no {{span}}");
    if (cur.kind === "qa" && cur.mode === "q") fail(cur.line, "Q block without A:");
    if (id && prompts.some(p => p.id === id)) fail(atLine, `duplicate id ${id}`);
    prompts.push({ id, kind: cur.kind, question, answer });
    cur = null;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const idMatch = line.match(/^<!-- id: ([A-Za-z0-9]+) -->$/);
    if (idMatch) { if (!cur) fail(i + 1, "id comment without a prompt block"); finish(idMatch[1], i + 1); continue; }
    if (line.startsWith("Q: ") || line === "Q:") {
      finish(null, i + 1);
      cur = { kind: "qa", q: [line.slice(3)], a: [], mode: "q", line: i + 1 };
    } else if (line.startsWith("C: ") || line === "C:") {
      finish(null, i + 1);
      cur = { kind: "cloze", q: [line.slice(3)], a: [], mode: "q", line: i + 1 };
    } else if (line.startsWith("A: ") || line === "A:") {
      if (!cur || cur.kind !== "qa" || cur.mode === "a") fail(i + 1, "A: without a Q block");
      cur!.mode = "a";
      cur!.a.push(line.slice(3));
    } else if (line.trim() === "") {
      if (cur) (cur.mode === "q" ? cur.q : cur.a).push(line); // content; trimmed at finish if trailing
    } else {
      if (!cur) fail(i + 1, `unexpected content outside a prompt block: "${line.slice(0, 30)}"`);
      (cur!.mode === "q" ? cur!.q : cur!.a).push(line);
    }
  }
  finish(null, lines.length);
  return { name: name!, url, meta, prompts };
}

export function sourceFileName(name: string, id: string): string {
  const slug = name.toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `prompts/${slug || "source"}-${id}.md`;
}
