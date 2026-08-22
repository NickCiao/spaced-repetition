(() => {
  const session = JSON.parse(document.getElementById("session").textContent);
  const el = document.getElementById("review");
  let i = 0, revealed = false;

  // sourceName/sourceUrl are raw DB strings — escape at the DOM boundary.
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // The schedule the page loaded with (session.nextDue / nextDueCount) goes stale as
  // soon as a grade lands, so the end screen also folds in the dues this session assigned.
  const gradedDues = [];
  const fmt = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

  // Earliest upcoming review and how many prompts share that day: prompts graded here
  // that land on it, plus the page-load count if session.nextDue falls on the same day.
  function nextReview() {
    const candidates = [session.nextDue, ...gradedDues].filter(Boolean);
    if (!candidates.length) return null;
    const next = candidates.reduce((a, b) => (new Date(b) < new Date(a) ? b : a));
    const count = gradedDues.filter(d => sameDay(d, next)).length
      + (session.nextDue && sameDay(session.nextDue, next) ? session.nextDueCount : 0);
    return { next, count };
  }
  const describe = (n) => fmt(n.next) + (n.count ? ` (${n.count} prompt${n.count === 1 ? "" : "s"})` : "");

  function finish() {
    let html = '<div class="done">';
    if (session.dueRemaining > 0) {
      html += `<p>${session.dueRemaining} more due — keep going?</p><p><a class="btn" href="/">Continue</a></p>`;
    } else {
      const n = nextReview();
      html += `<p>Done — next review ${n ? describe(n) : "—"}.</p><p><a class="btn" href="/?ahead=1">Review ahead</a></p>`;
    }
    el.innerHTML = html + "</div>";
  }

  function nothingDue() {
    const n = nextReview();
    el.innerHTML = `<div class="done"><p>Nothing due. Next: ${n ? describe(n) : "nothing scheduled"}.</p>
      <p><a class="btn" href="/?ahead=1">Review ahead</a></p></div>`;
  }

  async function grade(action, note) {
    const card = session.cards[i];
    try {
      const res = await fetch("/api/grade", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_id: card.id, action, note })
      });
      if (!res.ok) throw new Error(String(res.status));
      // Only real grades move a card; skip/flag leave it due and retire removes it.
      const { due } = await res.json().catch(() => ({}));
      if ((action === "remembered" || action === "forgot") && typeof due === "string") gradedDues.push(due);
    } catch {
      alert("Couldn't save that grade — check your connection and try again.");
      return; // stay on this card; nothing advanced, nothing lost silently
    }
    i += 1; revealed = false;
    i < session.cards.length ? render() : finish();
  }

  function render() {
    const c = session.cards[i];
    const src = c.sourceUrl && /^https?:\/\//i.test(c.sourceUrl)
      ? `<a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">${esc(c.sourceName)}</a>`
      : esc(c.sourceName);
    el.innerHTML = `
      <div class="card">
        <div>${revealed && c.kind === "cloze" ? c.answerHtml : c.questionHtml}</div>
        ${revealed && c.kind !== "cloze" ? `<hr><div>${c.answerHtml}</div>` : ""}
        ${revealed ? `<div class="source">${src}</div>` : ""}
      </div>
      ${revealed
        ? `<div class="btnrow"><button id="forgot">Forgot</button><button id="remembered" class="primary">Remembered</button></div>
           <div class="overflow"><a id="skip">Skip</a><a id="flag">Flag</a><a id="retire">Retire</a><a href="/prompt/${c.id}">Edit</a></div>`
        : `<div class="btnrow"><button id="reveal" class="primary">Reveal</button></div>`}`;
    if (revealed) {
      document.getElementById("forgot").onclick = () => grade("forgot");
      document.getElementById("remembered").onclick = () => grade("remembered");
      document.getElementById("skip").onclick = () => grade("skip");
      document.getElementById("retire").onclick = () => { if (confirm("Retire this prompt?")) grade("retire"); };
      document.getElementById("flag").onclick = () => {
        const note = prompt("What's wrong with this prompt?");
        if (note !== null) grade("flag", note);
      };
    } else {
      document.getElementById("reveal").onclick = () => { revealed = true; render(); };
    }
  }

  document.addEventListener("keydown", (e) => {
    if (i >= session.cards.length) return;
    if (e.key === " " && !revealed) { e.preventDefault(); revealed = true; render(); }
    else if (revealed && e.key === "ArrowLeft") grade("forgot");
    else if (revealed && e.key === "ArrowRight") grade("remembered");
  });

  session.cards.length ? render() : nothingDue();
})();
