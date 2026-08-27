import { getSettings } from "./db";
import { countDue } from "./session";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * JSON safe to inline inside a <script> tag: "<" is \u003c-escaped so content
 * containing "</script>" cannot break out of the tag.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export type AppPage = "review" | "capture" | "inbox" | "browse" | "settings";

// Fish mono mark (see assets/icon/handoff.md). The eye knockout is faked with the
// page bg colour; the standalone icon-mono.svg uses a real mask.
const FISH_MARK = `<svg width="16" height="16" viewBox="0 0 64 64" aria-hidden="true"><path d="M6 41 H58" stroke="var(--color-accent)" stroke-width="3" stroke-linecap="round"/><g transform="rotate(22 30 33)" fill="var(--color-accent)"><path d="M40 32 Q51 20 56 22.5 Q58.5 25 50.5 32.5 Q58.5 40 56 42.5 Q51 45 40 33.5 Z"/><ellipse cx="28" cy="33" rx="14" ry="11.5"/><circle cx="21" cy="29.5" r="3.2" fill="#161826"/></g><path d="M11 6.5 l2 4.9 4.9 2 -4.9 2 -2 4.9 -2 -4.9 -4.9 -2 4.9 -2 z" fill="var(--color-accent)"/></svg>`;

const NAV: { page: AppPage; href: string; label: string; icon: string }[] = [
  { page: "review", href: "/", label: "Review", icon: "ph-cards" },
  { page: "capture", href: "/capture", label: "Capture", icon: "ph-plus-circle" },
  { page: "inbox", href: "/inbox", label: "Inbox", icon: "ph-tray" },
  { page: "browse", href: "/browse", label: "Browse", icon: "ph-books" },
  { page: "settings", href: "/settings", label: "Settings", icon: "ph-gear-six" },
];

function navItem(n: typeof NAV[number], active: AppPage, dueCount: number, mobile: boolean): string {
  const cur = n.page === active ? ` aria-current="page"` : "";
  const due = n.page === "review" ? `<span class="rail-due">${dueCount}</span>` : "";
  if (mobile) {
    return `<a class="tab" href="${n.href}"${cur}><i class="ph ${n.icon}"></i> ${escapeHtml(n.label)}</a>`;
  }
  return `<a class="rail-item" href="${n.href}"${cur}><i class="ph ${n.icon}"></i> ${escapeHtml(n.label)} ${due}</a>`;
}

export function shell(active: AppPage, dueCount: number, content: string): string {
  const railNav = NAV.map(n => navItem(n, active, dueCount, false)).join("\n    ");
  const tabNav = NAV.map(n => navItem(n, active, dueCount, true)).join("\n  ");
  return `<aside class="rail">
  <div class="rail-brand">${FISH_MARK} Resurface</div>
  <nav class="rail-nav">
    ${railNav}
  </nav>
</aside>
<nav class="tabbar">
  ${tabNav}
</nav>
<div class="content">${content}</div>`;
}

export function humanDate(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
}

export function hostOnly(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function captureRowMeta(
  c: { title?: string | null; url?: string | null; created_at: string },
  tz: string
): string {
  const parts: string[] = [];
  const label = c.title ?? c.url ?? "";
  if (label) parts.push(`<span>${escapeHtml(label)}</span>`);
  const date = humanDate(c.created_at, tz);
  if (date) {
    if (parts.length) parts.push("<span>·</span>");
    parts.push(`<span>${escapeHtml(date)}</span>`);
  }
  return parts.length ? `<div class="row-meta">${parts.join("")}</div>` : "";
}

export function captureCardMeta(
  c: { title?: string | null; url?: string | null; created_at: string; note?: string | null },
  tz: string
): string {
  const parts: string[] = [];
  if (c.note) parts.push(`<span class="card-meta">note: ${escapeHtml(c.note)}</span>`);
  const srcParts: string[] = [];
  if (c.url && /^https?:\/\//i.test(c.url)) {
    srcParts.push(`<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.title ?? c.url)}</a>`);
  } else if (c.title) {
    srcParts.push(escapeHtml(c.title));
  }
  const date = humanDate(c.created_at, tz);
  if (date) {
    if (srcParts.length) srcParts.push(` · ${escapeHtml(date)}`);
    else srcParts.push(escapeHtml(date));
  }
  if (srcParts.length) parts.push(`<span class="card-meta">${srcParts.join("")}</span>`);
  return parts.join("\n  ");
}

export async function shellFor(db: D1Database, active: AppPage, now = new Date()) {
  const settings = await getSettings(db);
  return { active, dueCount: await countDue(db, settings.timezone, now) };
}

const DEFAULT_STYLES = [
  "/static/nocturne.css",
  "/static/phosphor/style.css",
  "/static/katex/katex.min.css",
  "/static/nocturne-app.css",
];

export function page(
  title: string,
  body: string,
  opts: {
    extraHead?: string;
    script?: string;
    styles?: string[];
    bodyClass?: string;
    shell?: { active: AppPage; dueCount: number };
  } = {}
): Response {
  const styles = opts.styles ?? DEFAULT_STYLES;
  const styleLinks = styles.map(href => `<link rel="stylesheet" href="${href}">`).join("\n");
  const inner = opts.shell ? shell(opts.shell.active, opts.shell.dueCount, body) : body;
  const bodyClass = opts.bodyClass ? ` class="${escapeHtml(opts.bodyClass)}"` : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/static/favicon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<link rel="manifest" href="/static/manifest.webmanifest" crossorigin="use-credentials">
${styleLinks}
${opts.extraHead ?? ""}
</head>
<body${bodyClass}>
${inner}
${opts.script ? `<script src="${opts.script}"></script>` : ""}
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
