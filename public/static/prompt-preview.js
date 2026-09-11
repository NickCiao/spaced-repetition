/* Live prompt preview for the authoring surfaces (New/Edit prompt, Refine).

   Renders through POST /api/preview — the same server functions review uses —
   and draws the result with sessionCardBody (session-card.js), the same
   builder review.js uses. Front = what you see before Reveal; Back = after.
   Authoring hints from the server sit beneath; a Formatting cheat-sheet lists
   exactly what this renderer supports.

   Usage:
     const pv = window.promptPreview(hostEl, {
       getState: () => ({ kind, question, answer, source }),
       inputs: [textarea, ...],   // re-render ~300ms after typing stops
       collapsible: true          // start closed behind a Preview button (Refine)
     });
     pv.refresh();                // call after a kind toggle or programmatic edit */
window.promptPreview = (host, opts) => {
  const DEBOUNCE_MS = 300;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // Hint copy uses `code` ticks; escape first, then turn ticks into <code>.
  const hintHtml = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

  const HELP = `
<details class="md-help">
  <summary><i class="ph ph-text-aa"></i> Formatting</summary>
  <dl>
    <dt>Paragraphs</dt><dd>Leave a blank line between them — single line breaks are joined.</dd>
    <dt>Lists</dt><dd><code>- item</code> or <code>1. item</code>, with a blank line before and after.</dd>
    <dt>Emphasis</dt><dd><code>**bold**</code> · <code>*italic*</code></dd>
    <dt>Code</dt><dd><code>\`inline\`</code>, or <code>\`\`\`</code> on its own line around a block.</dd>
    <dt>Math</dt><dd><code>$x^2$</code> inline · <code>$$…$$</code> for display.</dd>
    <dt>Cloze</dt><dd><code>{{hidden}}</code> — every span in the block is hidden together.</dd>
    <dt>Images</dt><dd>Attached only: <code>![](assets/…)</code>.</dd>
    <dt>Links</dt><dd><code>[text](https://…)</code> — a full URL is required.</dd>
    <dt>HTML</dt><dd>Shown as text, never rendered.</dd>
  </dl>
</details>`;

  const collapsible = !!(opts && opts.collapsible);
  let open = !collapsible;
  let timer = null;
  let seq = 0;

  host.classList.add("prompt-preview");
  host.innerHTML = `
<div class="preview-head">
  ${collapsible
    ? `<button type="button" class="btn btn-ghost preview-toggle" aria-expanded="false"><i class="ph ph-eye"></i> Preview</button>`
    : `<span class="preview-label"><i class="ph ph-eye"></i> Preview</span>`}
  ${HELP}
</div>
<div class="preview-body" ${collapsible ? "hidden" : ""}>
  <p class="preview-status">Preview appears as you type.</p>
  <div class="preview-faces" hidden>
    <div class="preview-face">
      <span class="preview-face-label">Front</span>
      <div class="preview-card" data-face="front"></div>
    </div>
    <div class="preview-face">
      <span class="preview-face-label">Back</span>
      <div class="preview-card" data-face="back"></div>
    </div>
  </div>
  <ul class="preview-hints" hidden></ul>
</div>`;

  const body = host.querySelector(".preview-body");
  const status = host.querySelector(".preview-status");
  const faces = host.querySelector(".preview-faces");
  const front = host.querySelector('[data-face="front"]');
  const back = host.querySelector('[data-face="back"]');
  const hintList = host.querySelector(".preview-hints");

  function showStatus(text) {
    status.textContent = text;
    status.hidden = false;
    faces.hidden = true;
    hintList.hidden = true;
  }

  function draw(state, data) {
    const card = {
      kind: state.kind,
      questionHtml: data.questionHtml,
      answerHtml: data.answerHtml,
      sourceHtml: data.sourceHtml || ""
    };
    front.innerHTML = window.sessionCardBody(card, false);
    back.innerHTML = window.sessionCardBody(card, true);
    status.hidden = true;
    faces.hidden = false;

    const hints = Array.isArray(data.hints) ? data.hints : [];
    hintList.innerHTML = hints.map((h) => {
      const where = state.kind === "qa" ? `<span class="preview-hint-field">${h.field === "answer" ? "Answer" : "Question"}</span>` : "";
      return `<li>${where}<span class="preview-hint-text">${hintHtml(h.message)}</span></li>`;
    }).join("");
    hintList.hidden = hints.length === 0;
  }

  async function run() {
    if (!open) return;
    const state = opts.getState();
    if (!state.question.trim() && !(state.kind === "qa" && state.answer.trim())) {
      showStatus("Preview appears as you type.");
      return;
    }
    const mine = ++seq;
    try {
      const res = await fetch("/api/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: state.kind, question: state.question, answer: state.answer, source: state.source || "" })
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (mine !== seq) return; // a newer keystroke superseded this render
      draw(state, data);
    } catch {
      if (mine === seq) showStatus("Preview unavailable.");
    }
  }

  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  (opts.inputs || []).forEach((el) => el && el.addEventListener("input", refresh));

  if (collapsible) {
    const btn = host.querySelector(".preview-toggle");
    btn.onclick = () => {
      open = !open;
      body.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      host.classList.toggle("open", open);
      if (open) run();
    };
  } else {
    host.classList.add("open");
    run();
  }

  return { refresh, run };
};
