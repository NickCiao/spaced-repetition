import { strFromU8 } from "fflate";
import { CLOZE_RE, MARKER } from "./format";

export type ForeignPrompt = { kind: "qa" | "cloze"; question: string; answer: string };
export type ForeignDeck = { name: string; prompts: ForeignPrompt[] };
export type ForeignAttachment = { bytes: Uint8Array; type: string };
export type ForeignImport = { decks: ForeignDeck[]; attachments: Record<string, ForeignAttachment>; warnings: string[] };

export class InteropError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function sanitizeRepresentable(text: string): string {
  return text.split("\n").map(line => MARKER.test(line) ? ` ${line}` : line).join("\n");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function htmlToMarkdown(html: string): string {
  let s = decodeHtmlEntities(html);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>\s*<p[^>]*>/gi, "\n\n");
  s = s.replace(/<\/div>\s*<div[^>]*>/gi, "\n\n");
  s = s.replace(/<p[^>]*>/gi, "");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<div[^>]*>/gi, "");
  s = s.replace(/<\/div>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "- ");
  s = s.replace(/<\/li>/gi, "\n");
  s = s.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, "*$2*");
  s = s.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function ankiClozeToOurs(text: string): string {
  return text.replace(/\{\{c\d+::([^}:]+)(?:::([^}]*))?\}\}/gi, (_, txt) => `{{${txt}}}`);
}

function parseAnkiRecords(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\"") {
      i++;
      while (i < text.length) {
        if (text[i] === "\"") {
          if (text[i + 1] === "\"") { field += "\""; i += 2; }
          else { i++; break; }
        } else { field += text[i]; i++; }
      }
      continue;
    }
    if (text.startsWith(sep, i)) {
      row.push(field);
      field = "";
      i += sep.length;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.some(f => f.length > 0) || row.length > 1) rows.push(row);
      row = [];
      i++;
      continue;
    }
    if (ch === "\r") { i++; continue; }
    field += ch;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some(f => f.length > 0) || row.length > 1) rows.push(row);
  }
  return rows;
}

type AnkiHeader = {
  separator: string;
  html: boolean;
  columns: Record<string, number>;
};

function parseAnkiHeader(lines: string[]): { header: AnkiHeader; dataStart: number } {
  const header: AnkiHeader = { separator: "\t", html: false, columns: {} };
  let dataStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#")) {
      dataStart = i;
      break;
    }
    dataStart = i + 1;
    const m = line.match(/^#([^:]+):(.+)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key === "separator") header.separator = val === "tab" ? "\t" : val;
    else if (key === "html") header.html = val === "true";
    else if (key.endsWith(" column")) {
      const colName = key.replace(/ column$/, "");
      header.columns[colName] = parseInt(val, 10);
    }
  }
  return { header, dataStart };
}

function fieldAt(row: string[], col: number): string {
  return row[col - 1] ?? "";
}

function normalizeField(text: string, html: boolean): string {
  const t = html ? htmlToMarkdown(text) : text;
  return sanitizeRepresentable(t.trim());
}

function promptsFromAnkiRow(
  notetype: string, fields: string[], html: boolean, warnings: string[]
): ForeignPrompt[] {
  const norm = fields.map(f => normalizeField(f, html));
  const front = norm[0] ?? "";
  const back = norm[1] ?? "";
  const extra = norm.slice(2).filter(Boolean).join("\n\n");

  if (!front && !back) return [];

  if (notetype === "Basic") {
    if (!front) return [];
    return [{ kind: "qa", question: front, answer: back }];
  }
  if (notetype === "Basic (and reversed card)") {
    if (!front || !back) return [];
    return [
      { kind: "qa", question: front, answer: back },
      { kind: "qa", question: back, answer: front }
    ];
  }
  if (notetype.startsWith("Cloze")) {
    let question = ankiClozeToOurs(front);
    if (extra) question = question ? `${question}\n\n${extra}` : extra;
    if (!CLOZE_RE.test(question)) {
      warnings.push(`cloze notetype row has no {{span}}: "${front.slice(0, 40)}"`);
      return [];
    }
    return [{ kind: "cloze", question, answer: "" }];
  }
  if (notetype) warnings.push(`unknown notetype "${notetype}" — using first two fields as Q/A`);
  if (!front) return [];
  return [{ kind: "qa", question: front, answer: back }];
}

export function parseAnkiTsv(text: string, fallbackDeckName: string): ForeignImport {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const { header, dataStart } = parseAnkiHeader(lines);
  const body = lines.slice(dataStart).join("\n");
  const rows = parseAnkiRecords(body, header.separator);
  const warnings: string[] = [];
  const deckMap = new Map<string, ForeignPrompt[]>();
  const isHeadered = "notetype" in header.columns || "deck" in header.columns;

  const add = (deckName: string, prompts: ForeignPrompt[]) => {
    if (!prompts.length) return;
    const list = deckMap.get(deckName) ?? [];
    list.push(...prompts);
    deckMap.set(deckName, list);
  };

  if (isHeadered) {
    const deckCol = header.columns["deck"] ?? 3;
    const typeCol = header.columns["notetype"] ?? 2;
    const metaCols = new Set(Object.values(header.columns));

    for (const row of rows) {
      const deck = fieldAt(row, deckCol).trim() || fallbackDeckName;
      const notetype = fieldAt(row, typeCol).trim();
      const fields = row.filter((_, i) => !metaCols.has(i + 1));
      add(deck, promptsFromAnkiRow(notetype, fields, header.html, warnings));
    }
  } else {
    for (const row of rows) {
      if (row.length < 2) {
        if (row.some(c => c.trim())) warnings.push(`skipped row with ${row.length} field(s)`);
        continue;
      }
      const q = normalizeField(row[0], header.html);
      const a = normalizeField(row[1], header.html);
      if (!q && !a) continue;
      add(fallbackDeckName, [{ kind: "qa", question: q, answer: a }]);
    }
  }

  const decks = [...deckMap.entries()].map(([name, prompts]) => ({ name, prompts }));
  if (!decks.length) throw new InteropError("no cards found in Anki export");
  return { decks, attachments: {}, warnings };
}

function unwrapTransit(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "string") return val.startsWith("~:") ? val.slice(2) : val;
  if (Array.isArray(val)) {
    if (val.length === 2 && val[0] === "~#list") return (val[1] as unknown[]).map(unwrapTransit);
    if (val.length === 2 && val[0] === "~#set") return (val[1] as unknown[]).map(unwrapTransit);
    if (val.length === 2 && val[0] === "~#dt") return val[1];
    return val.map(unwrapTransit);
  }
  if (typeof val !== "object") return val;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    const key = k.startsWith("~:") ? k.slice(2) : k.startsWith("~#") ? k.slice(2) : k;
    out[key] = unwrapTransit(v);
  }
  return out;
}

type MochiField = { id: string; name?: string; value?: string };
type MochiTemplate = { id: string; content: string; fields: Record<string, MochiField> };

function splitMochiContent(content: string): { question: string; answer: string } {
  const lines = content.split("\n");
  const sep = lines.findIndex(l => l.trim() === "---");
  if (sep >= 0) {
    return {
      question: lines.slice(0, sep).join("\n").trim(),
      answer: lines.slice(sep + 1).join("\n").trim()
    };
  }
  return { question: content.trim(), answer: "" };
}

function resolveMochiTemplate(template: MochiTemplate, cardFields: Record<string, MochiField>): string {
  let out = template.content;
  for (const tf of Object.values(template.fields)) {
    const name = tf.name ?? tf.id;
    const cv = cardFields[tf.id]?.value ?? "";
    out = out.split(`<<${name}>>`).join(cv);
  }
  return out;
}

function mochiCardToPrompts(
  card: Record<string, unknown>,
  templates: Map<string, MochiTemplate>,
  warnings: string[]
): ForeignPrompt[] {
  if (card["trashed?"]) {
    warnings.push(`skipped trashed card "${String(card["name"] ?? card["id"] ?? "")}"`);
    return [];
  }

  let raw = String(card["content"] ?? "").trim();
  if (!raw && card["template-id"]) {
    const tmpl = templates.get(String(card["template-id"]));
    const fields = card["fields"] as Record<string, MochiField> | undefined;
    if (!tmpl || !fields) {
      warnings.push(`skipped card missing template or fields: "${String(card["name"] ?? "")}"`);
      return [];
    }
    raw = resolveMochiTemplate(tmpl, fields).trim();
  }

  if (!raw) {
    warnings.push(`skipped empty card "${String(card["name"] ?? card["id"] ?? "")}"`);
    return [];
  }

  const { question: qRaw, answer: aRaw } = splitMochiContent(raw);
  const question = sanitizeRepresentable(qRaw);
  const answer = sanitizeRepresentable(aRaw);

  if (!question && !answer) {
    warnings.push(`skipped empty card "${String(card["name"] ?? "")}"`);
    return [];
  }

  if (CLOZE_RE.test(question) || CLOZE_RE.test(answer)) {
    const clozeQ = question || answer;
    if (!CLOZE_RE.test(clozeQ)) return [];
    return [{ kind: "cloze", question: clozeQ, answer: "" }];
  }

  if (!question) return [];
  return [{ kind: "qa", question, answer }];
}

export function parseMochi(files: Record<string, Uint8Array>): ForeignImport {
  const dataBytes = files["data.json"];
  if (!dataBytes) throw new InteropError("Mochi export missing data.json");

  const raw = JSON.parse(strFromU8(dataBytes)) as unknown;
  const data = unwrapTransit(raw) as {
    decks?: Array<{ name?: string; cards?: { list?: unknown[] } | unknown[] }>;
    templates?: { list?: unknown[] } | unknown[];
  };

  const templateList = Array.isArray(data.templates)
    ? data.templates
    : (data.templates as { list?: unknown[] })?.list ?? [];
  const templates = new Map<string, MochiTemplate>();
  for (const t of templateList) {
    const tmpl = t as MochiTemplate;
    if (tmpl.id) templates.set(tmpl.id, tmpl);
  }

  const warnings: string[] = [];
  const decks: ForeignDeck[] = [];
  const attachments: Record<string, ForeignAttachment> = {};

  for (const deck of data.decks ?? []) {
    const cards = Array.isArray(deck.cards)
      ? deck.cards
      : (deck.cards as { list?: unknown[] })?.list ?? [];
    const prompts: ForeignPrompt[] = [];
    for (const card of cards) {
      prompts.push(...mochiCardToPrompts(card as Record<string, unknown>, templates, warnings));
    }
    if (prompts.length) decks.push({ name: deck.name ?? "Mochi import", prompts });
  }

  if (!decks.length) throw new InteropError("no cards found in Mochi export");

  const referenced = new Set<string>();
  for (const deck of decks) {
    for (const p of deck.prompts) {
      for (const text of [p.question, p.answer]) {
        let m: RegExpExecArray | null;
        MEDIA_REF_RE.lastIndex = 0;
        while ((m = MEDIA_REF_RE.exec(text))) referenced.add(m[2]);
      }
    }
  }

  for (const [path, bytes] of Object.entries(files)) {
    if (path === "data.json") continue;
    const filename = path.includes("/") ? path.split("/").pop()! : path;
    if (!referenced.has(filename)) continue;
    const ext = filename.split(".").pop()?.toLowerCase();
    const type = ext === "png" ? "image/png"
      : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "gif" ? "image/gif"
      : ext === "webp" ? "image/webp"
      : ext === "avif" ? "image/avif"
      : "";
    if (!type) {
      warnings.push(`skipped unsupported attachment "${filename}"`);
      continue;
    }
    attachments[filename] = { bytes, type };
  }

  for (const name of referenced) {
    if (!attachments[name]) warnings.push(`referenced attachment missing from zip: ${name}`);
  }

  return { decks, attachments, warnings };
}

export const MEDIA_REF_RE = /!\[([^\]]*)\]\(@media\/([^)]+)\)/g;

export function rewriteMediaRefs(text: string, idByFile: Map<string, string>): string {
  return text.replace(MEDIA_REF_RE, (_, alt: string, file: string) => {
    const id = idByFile.get(file);
    return id ? `![${alt}](assets/${id})` : `![${alt}](@media/${file})`;
  });
}
