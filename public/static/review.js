(() => {
  const session = JSON.parse(document.getElementById("session").textContent);
  const el = document.getElementById("review");
  let i = 0, revealed = false, flagging = false;

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const gradedDues = [];
  const fmt = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const weekday = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "long" });
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

  function nextReview() {
    const candidates = [session.nextDue, ...gradedDues].filter(Boolean);
    if (!candidates.length) return null;
    const next = candidates.reduce((a, b) => (new Date(b) < new Date(a) ? b : a));
    const count = gradedDues.filter(d => sameDay(d, next)).length
      + (session.nextDue && sameDay(session.nextDue, next) ? session.nextDueCount : 0);
    return { next, count };
  }

  const describe = (n) => fmt(n.next) + (n.count ? ` (${n.count} prompt${n.count === 1 ? "" : "s"})` : "");
  const commitment = (count) => {
    const n = count || 0;
    const mins = Math.max(1, Math.ceil((n * 20) / 60));
    return `${n} prompt${n === 1 ? "" : "s"} · ~${mins} min`;
  };

  function sessionHref(params = {}) {
    const q = new URLSearchParams();
    if (session.ahead) q.set("ahead", "1");
    if (session.sourceId) q.set("source", session.sourceId);
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `/?${s}` : "/";
  }

  const synapseIcon = () => `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style="display:block;flex:none">
    <circle cx="3.5" cy="7" r="2.2" fill="var(--color-accent)"/>
    <line x1="5.8" y1="7" x2="8.2" y2="7" stroke="var(--color-accent)" stroke-width="1.4" stroke-linecap="round"/>
    <circle cx="10.5" cy="7" r="2.2" fill="var(--color-accent)"/>
  </svg>`;

  function closeScreen(label, title, meta, ctaHref, ctaLabel, kickerDone) {
    const kicker = kickerDone
      ? `<div class="session-close-kicker">${synapseIcon()} Done for today</div>`
      : `<p class="session-close-label">${esc(label)}</p>`;
    el.innerHTML = `<div class="session-close">
      ${kicker}
      <h1 class="session-close-title">${title}</h1>
      ${meta ? `<p class="session-close-meta">${esc(meta)}</p>` : ""}
      <a class="btn btn-secondary" href="${esc(ctaHref)}">${esc(ctaLabel)}</a>
    </div>`;
  }

  function setInSession(on) {
    document.body.classList.toggle("in-session", on);
  }

  function finish() {
    if (session.dueRemaining > 0) {
      setInSession(false);
      closeScreen(
        `${session.dueRemaining} more due`,
        "Keep going?",
        commitment(session.dueRemaining),
        sessionHref(),
        "Continue",
        false
      );
      return;
    }
    setInSession(false);
    const n = nextReview();
    closeScreen(
      "",
      n ? `Next review ${weekday(n.next)}` : "Nothing scheduled",
      n ? commitment(n.count) : "",
      sessionHref({ ahead: "1" }),
      "Review ahead",
      true
    );
  }

  function nothingDue() {
    setInSession(false);
    const n = nextReview();
    closeScreen(
      "Nothing due",
      n ? `Next review ${weekday(n.next)}` : "Nothing scheduled",
      n ? commitment(n.count) : "",
      sessionHref({ ahead: "1" }),
      "Review ahead",
      false
    );
  }

  async function removeCard() {
    const card = session.cards[i];
    try {
      const res = await fetch(`/api/prompt/${card.id}/delete`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      if (typeof applyNavCounts === "function") applyNavCounts(await res.json().catch(() => ({})));
    } catch {
      alert("Couldn't delete — check your connection and try again.");
      return;
    }
    flagging = false;
    i += 1;
    revealed = false;
    i < session.cards.length ? render() : finish();
  }

  async function grade(action, note) {
    const card = session.cards[i];
    try {
      const res = await fetch("/api/grade", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_id: card.id, action, note })
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json().catch(() => ({}));
      if ((action === "remembered" || action === "forgot") && typeof body.due === "string") gradedDues.push(body.due);
      if (typeof applyNavCounts === "function") applyNavCounts(body);
    } catch {
      alert("Couldn't save that grade — check your connection and try again.");
      return;
    }
    flagging = false;
    i += 1;
    revealed = false;
    i < session.cards.length ? render() : finish();
  }

  function progressDots() {
    return session.cards.map((_, j) => {
      const cls = j < i ? "done" : j === i ? "current" : "";
      return `<span class="dot ${cls}"></span>`;
    }).join("");
  }

  function sourceLine(c) {
    const src = c.sourceUrl && /^https?:\/\//i.test(c.sourceUrl)
      ? `<a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">${esc(c.sourceName)}</a>`
      : esc(c.sourceName);
    return c.sourceName ? `<div class="session-source">from ${src}</div>` : "";
  }

  function render() {
    const c = session.cards[i];
    const cardBody = !revealed
      ? `<div class="session-question">${c.questionHtml}</div>`
      : c.kind === "cloze"
        ? `<div class="session-answer">${c.answerHtml}</div>${sourceLine(c)}`
        : `<div class="session-question dimmed">${c.questionHtml}</div>
           <div class="session-divider"></div>
           <div class="session-answer">${c.answerHtml}</div>${sourceLine(c)}`;

    const flagPanel = flagging ? `
      <div class="flag-panel card elev-md">
        <label class="field">
          <span>What's wrong with this prompt?</span>
          <textarea class="input" id="flag-note" rows="3"></textarea>
        </label>
        <div class="flag-actions">
          <button type="button" class="btn btn-secondary" id="flag-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="flag-submit">Flag & continue</button>
        </div>
      </div>` : "";

    const actions = revealed && !flagging
      ? `<div class="grade-bar">
           <button type="button" class="btn btn-forgot" id="forgot">Forgot</button>
           <button type="button" class="btn btn-remembered" id="remembered">Remembered</button>
         </div>
         <div class="overflow">
           <a id="skip">Skip</a><a id="flag">Flag</a><a id="retire">Retire</a>
           <a id="delete">Delete</a>
           <a href="/prompt/${esc(c.id)}">Edit</a>
         </div>
         <p class="session-hint">← forgot · remembered →</p>`
      : flagging ? ""
      : `<div class="reveal-slot"><button type="button" class="btn btn-primary" id="reveal">Reveal</button></div>
         <p class="session-hint">tap the card or press space</p>`;

    el.innerHTML = `
      <div class="session">
        <div class="session-top">
          <div class="progress-dots">${progressDots()}</div>
          <a class="session-end" id="end">End</a>
        </div>
        <div class="session-card${revealed || flagging ? "" : " tappable"}" id="card">${cardBody}</div>
        <div class="session-actions${flagging ? " waiting" : ""}">
          ${flagPanel}
          ${actions}
        </div>
      </div>`;

    document.getElementById("end").onclick = (e) => {
      e.preventDefault();
      finish();
    };

    if (flagging) {
      const noteEl = document.getElementById("flag-note");
      document.getElementById("flag-cancel").onclick = () => { flagging = false; render(); };
      document.getElementById("flag-submit").onclick = () => grade("flag", noteEl.value);
      noteEl.focus();
      return;
    }

    if (revealed) {
      document.getElementById("forgot").onclick = () => grade("forgot");
      document.getElementById("remembered").onclick = () => grade("remembered");
      document.getElementById("skip").onclick = () => grade("skip");
      document.getElementById("retire").onclick = () => {
        if (confirm("Retire this prompt? It will be hidden from review but can be recovered from export or edit.")) grade("retire");
      };
      document.getElementById("delete").onclick = () => {
        if (confirm("Delete this prompt permanently? Its review history will be gone and this cannot be undone.")) removeCard();
      };
      document.getElementById("flag").onclick = () => { flagging = true; render(); };
    } else {
      document.getElementById("reveal").onclick = () => { revealed = true; render(); };
      document.getElementById("card").onclick = () => { revealed = true; render(); };
    }
  }

  document.addEventListener("keydown", (e) => {
    if (flagging) {
      if (e.key === "Escape") { e.preventDefault(); flagging = false; render(); }
      return;
    }
    if (i >= session.cards.length) return;
    if (e.key === " " && !revealed) {
      e.preventDefault();
      revealed = true;
      render();
    } else if (revealed && e.key === "ArrowLeft") grade("forgot");
    else if (revealed && e.key === "ArrowRight") grade("remembered");
  });

  session.cards.length ? (setInSession(true), render()) : nothingDue();
})();
