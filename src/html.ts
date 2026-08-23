export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function page(
  title: string,
  body: string,
  opts: { extraHead?: string; script?: string; styles?: string[]; bodyClass?: string } = {}
): Response {
  const styles = opts.styles ?? ["/static/app.css", "/static/katex/katex.min.css"];
  const styleLinks = styles.map(href => `<link rel="stylesheet" href="${href}">`).join("\n");
  const bodyClass = opts.bodyClass ? ` class="${escapeHtml(opts.bodyClass)}"` : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
${styleLinks}
${opts.extraHead ?? ""}
</head>
<body${bodyClass}>
<main>${body}</main>
${opts.script ? `<script src="${opts.script}"></script>` : ""}
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
