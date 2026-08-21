(() => {
  const session = JSON.parse(document.getElementById("session").textContent);
  const el = document.getElementById("review");
  let i = 0, revealed = false;

  // sourceName/sourceUrl are raw DB strings — escape at the DOM boundary.
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // nextDueCount is only meaningful alongside a real nextDue date; when nextDue is
  // null the count is always 0, so the suffix naturally disappears too.
  const dueSuffix = () => session.nextDueCount ? ` (${session.nextDueCount} prompt${session.nextDueCount === 1 ? "" : "s"})` : "";

  function finish() {
    let html = '<div class="done">';
    if (session.dueRemaining > 0) {
      html += `<p>${session.dueRemaining} more due — keep going?</p><p><a class="btn" href="/">Continue</a></p>`;
    } else {
      const next = session.nextDue ? new Date(session.nextDue).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : "—";
      html += `<p>Done — next review ${next}${dueSuffix()}.</p><p><a class="btn" href="/?ahead=1">Review ahead</a></p>`;
    }
    el.innerHTML = html + "</div>";
  }

  function nothingDue() {
    const next = session.nextDue ? new Date(session.nextDue).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : "nothing scheduled";
    el.innerHTML = `<div class="done"><p>Nothing due. Next: ${next}${dueSuffix()}.</p>
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
