/* Card-body markup shared by the review session (review.js) and the editors'
   live preview (prompt-preview.js). One builder, so what you see while
   authoring is exactly what review renders — the two cannot drift.

   card: { kind, questionHtml, answerHtml, sourceHtml?, topicName? }
   questionHtml / answerHtml / sourceHtml are rendered server-side through
   the sanitizing markdown pipeline and inserted as-is. */
(() => {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function attribution(c) {
    const src = c.sourceHtml ? `<div class="session-source">from ${c.sourceHtml}</div>` : "";
    const topic = c.topicName ? `<div class="session-topic">${esc(c.topicName)}</div>` : "";
    return src || topic ? `<div class="session-meta">${src}${topic}</div>` : "";
  }

  window.sessionCardBody = (c, revealed) => {
    if (!revealed) return `<div class="session-question">${c.questionHtml}</div>`;
    if (c.kind === "cloze") return `<div class="session-answer">${c.answerHtml}</div>${attribution(c)}`;
    return `<div class="session-question dimmed">${c.questionHtml}</div>
           <div class="session-divider"></div>
           <div class="session-answer">${c.answerHtml}</div>${attribution(c)}`;
  };
})();
