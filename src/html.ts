export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function page(title: string, body: string, opts: { extraHead?: string; script?: string } = {}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="stylesheet" href="/static/katex/katex.min.css">
${opts.extraHead ?? ""}
</head>
<body>
<main>${body}</main>
${opts.script ? `<script src="${opts.script}"></script>` : ""}
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
