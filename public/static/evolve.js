/* Evolve session (routes/evolve.ts): one streamed conversation with the tutor.
   POST /api/evolve/:id/start opens a session and streams the tutor's opening;
   each reply (or "Skip to proposals") is a POST /api/evolve/:id/turn. Events
   arrive as SSE `data: <JSON TurnEvent>` lines. Proposal cards are edited
   inline and written only when the user presses Accept; fate and the private
   worth-it answer close the session. Model text is always inserted as text
   nodes, never as HTML. Reads its prompt id from #evolve data attributes. */
(() => {
  const root = document.getElementById("evolve");
  if (!root) return;
  const promptId = root.dataset.promptId;
  const api = (op) => `/api/evolve/${promptId}/${op}`;
  // Review session to return to, already validated server-side (routes/evolve.ts); never read from location.
  const returnTo = root.dataset.return || "";
  const editorHref = (id) => `/prompt/${id}` + (returnTo ? `?return=${encodeURIComponent(returnTo)}` : "");

  let sessionId = null;
  let streaming = false;
  let current = null;   // assistant bubble receiving text-deltas
  let statusEl = null;  // quiet "reading topic…" line under the current bubble

  root.innerHTML = `
    <div class="evo-thread" id="evo-thread"></div>
    <form class="evo-composer" id="evo-composer">
      <textarea class="input" id="evo-input" rows="2" placeholder="Reply to the tutor…" disabled></textarea>
      <div class="evo-actions">
        <button type="submit" class="btn btn-primary" id="evo-send" disabled>Send</button>
        <button type="button" class="btn btn-ghost" id="evo-skip" disabled>Skip to proposals</button>
      </div>
    </form>`;
  const thread = document.getElementById("evo-thread");
  const composer = document.getElementById("evo-composer");
  const input = document.getElementById("evo-input");
  const sendBtn = document.getElementById("evo-send");
  const skipBtn = document.getElementById("evo-skip");

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const scrollToEnd = () => window.scrollTo({ top: document.documentElement.scrollHeight });

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // ── thread rendering ──────────────────────────────────────────────────
  function setBusy(on) {
    streaming = on;
    const disabled = on || !sessionId;
    input.disabled = disabled;
    sendBtn.disabled = disabled;
    skipBtn.disabled = disabled;
    if (!disabled) input.focus();
  }

  function clearStatus() {
    if (statusEl) statusEl.remove();
    statusEl = null;
  }

  function setStatus(text) {
    clearStatus();
    statusEl = el("div", "evo-status", text);
    thread.appendChild(statusEl);
    scrollToEnd();
  }

  function assistantBubble() {
    if (!current) {
      current = el("div", "evo-msg evo-assistant");
      thread.appendChild(current);
    }
    return current;
  }

  function addUser(text) {
    current = null;
    thread.appendChild(el("div", "evo-msg evo-user", text));
    scrollToEnd();
  }

  function showError(message) {
    current = null;
    thread.appendChild(el("p", "flash evo-error", message || "Something went wrong."));
    scrollToEnd();
  }

  function field(labelText, id, value) {
    const wrap = el("div", "field");
    const label = el("label", null, labelText);
    label.htmlFor = id;
    const ta = el("textarea", "input");
    ta.id = id;
    ta.value = value || "";
    wrap.append(label, ta);
    return { wrap, ta };
  }

  function renderProposal(p) {
    current = null;
    const isNew = p.kind === "new";
    const cloze = isNew && p.promptKind === "cloze";
    const safeId = String(p.id).replace(/[^a-z0-9]/gi, "");
    const card = el("div", "card elev-sm evo-proposal");
    card.appendChild(el("span", "card-kicker", isNew ? `new · ${p.move}` : "edit to original"));
    const q = field(cloze ? "Cloze (wrap deletions in {{…}})" : "Question", `evo-q-${safeId}`, p.question);
    card.appendChild(q.wrap);
    let a = null;
    if (!cloze) {
      a = field("Answer", `evo-a-${safeId}`, p.answer);
      card.appendChild(a.wrap);
    }
    if (p.rationale) card.appendChild(el("span", "card-meta evo-rationale", p.rationale));
    const actions = el("div", "evo-actions");
    const accept = el("button", "btn btn-primary", "Accept");
    accept.type = "button";
    const discard = el("button", "btn btn-ghost", "Discard");
    discard.type = "button";
    actions.append(accept, discard);
    const flash = el("p", "flash");
    card.append(actions, flash);
    thread.appendChild(card);
    scrollToEnd();

    const lock = (on) => { accept.disabled = on; discard.disabled = on; };

    accept.onclick = async () => {
      flash.textContent = "";
      lock(true);
      try {
        const { ok, data } = await postJson(api("accept"), {
          session: sessionId, proposal_id: p.id, question: q.ta.value, answer: a ? a.ta.value : ""
        });
        if (!ok) { flash.textContent = data.error || "Couldn't save."; lock(false); return; }
        q.ta.readOnly = true;
        if (a) a.ta.readOnly = true;
        actions.replaceChildren(el("span", "evo-saved", "Saved ✓"));
        if (isNew && data.prompt_id) {
          const link = el("a", "btn btn-ghost", "Open prompt");
          link.href = editorHref(data.prompt_id);
          actions.appendChild(link);
        }
      } catch (err) {
        flash.textContent = err.message || "Couldn't save.";
        lock(false);
      }
    };

    discard.onclick = async () => {
      flash.textContent = "";
      lock(true);
      try {
        const { ok, data } = await postJson(api("discard"), { session: sessionId, proposal_id: p.id });
        if (!ok) { flash.textContent = data.error || "Couldn't discard."; lock(false); return; }
        const gist = (p.question || "").replace(/\s+/g, " ").trim();
        const line = el("div", "evo-discarded",
          `Discarded ${isNew ? "proposal" : "edit"}: ${gist.length > 70 ? gist.slice(0, 70) + "…" : gist}`);
        card.replaceWith(line);
      } catch (err) {
        flash.textContent = err.message || "Couldn't discard.";
        lock(false);
      }
    };
  }

  function renderFate(rec) {
    current = null;
    const card = el("div", "card elev-sm evo-fate");
    card.appendChild(el("span", "card-kicker", `the original · tutor says ${rec.fate}`));
    card.appendChild(el("p", "context-text", rec.reasoning || ""));
    const actions = el("div", "evo-actions");
    const keep = el("button", rec.fate === "keep" ? "btn btn-primary" : "btn btn-secondary", "Keep");
    keep.type = "button";
    const retire = el("button", rec.fate === "retire" ? "btn btn-primary" : "btn btn-secondary", "Retire");
    retire.type = "button";
    actions.append(keep, retire);
    const flash = el("p", "flash");
    card.append(actions, flash);
    thread.appendChild(card);
    scrollToEnd();

    const choose = async (fate) => {
      flash.textContent = "";
      keep.disabled = retire.disabled = true;
      try {
        const { ok, data } = await postJson(api("fate"), { session: sessionId, fate });
        if (!ok) { flash.textContent = data.error || "Couldn't save."; keep.disabled = retire.disabled = false; return; }
        actions.replaceChildren(el("span", "evo-saved", data.retired ? "Retired. Hidden from review; history kept." : "Kept."));
        askWorth(card);
      } catch (err) {
        flash.textContent = err.message || "Couldn't save.";
        keep.disabled = retire.disabled = false;
      }
    };
    keep.onclick = () => choose("keep");
    retire.onclick = () => choose("retire");
  }

  function askWorth(after) {
    const box = el("div", "evo-worth");
    box.appendChild(el("p", "evo-worth-q", "Worth the minutes?"));
    const actions = el("div", "evo-actions");
    const yes = el("button", "btn btn-secondary", "Yes");
    yes.type = "button";
    const no = el("button", "btn btn-secondary", "No");
    no.type = "button";
    actions.append(yes, no);
    const flash = el("p", "flash");
    box.append(actions, flash);
    after.insertAdjacentElement("afterend", box);
    scrollToEnd();

    const answer = async (worth) => {
      flash.textContent = "";
      yes.disabled = no.disabled = true;
      try {
        const { ok, data } = await postJson(api("worth"), { session: sessionId, worth_it: worth });
        if (!ok) { flash.textContent = data.error || "Couldn't save."; yes.disabled = no.disabled = false; return; }
        box.remove();
        closing();
      } catch (err) {
        flash.textContent = err.message || "Couldn't save.";
        yes.disabled = no.disabled = false;
      }
    };
    yes.onclick = () => answer(true);
    no.onclick = () => answer(false);
  }

  function closing() {
    const done = el("div", "evo-close");
    done.appendChild(el("p", "evo-close-line", "Done. Anything you accepted will surface in review in a few days."));
    const back = el("a", "btn btn-secondary", "Back to prompt");
    back.href = editorHref(promptId);
    done.appendChild(back);
    thread.appendChild(done);
    composer.hidden = true;
    scrollToEnd();
  }

  // ── event stream ──────────────────────────────────────────────────────
  function handleEvent(ev) {
    switch (ev.type) {
      case "session":
        sessionId = ev.id;
        break;
      case "text-delta":
        clearStatus();
        assistantBubble().appendChild(document.createTextNode(ev.text));
        scrollToEnd();
        break;
      case "status":
        setStatus(ev.text);
        break;
      case "proposal":
        clearStatus();
        renderProposal(ev.proposal);
        break;
      case "fate":
        clearStatus();
        renderFate(ev.recommendation);
        break;
      case "error":
        clearStatus();
        showError(ev.message);
        break;
      case "done":
        clearStatus();
        break;
      default:
        break;
    }
  }

  function handleChunk(chunk) {
    const lines = chunk.split("\n").filter((l) => l.startsWith("data:"));
    if (!lines.length) return;
    const json = lines.map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    let ev;
    try { ev = JSON.parse(json); } catch { return; }
    handleEvent(ev);
  }

  async function runTurn(op, body) {
    if (streaming) return;
    setBusy(true);
    current = null;
    try {
      const res = await fetch(api(op), {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `The tutor didn't answer (${res.status}).`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          handleChunk(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      }
      buf += dec.decode();
      if (buf.trim()) handleChunk(buf);
    } catch (err) {
      showError(err.message || "Connection lost.");
    } finally {
      clearStatus();
      current = null;
      setBusy(false);
    }
  }

  // ── composer ──────────────────────────────────────────────────────────
  function send() {
    const text = input.value.trim();
    if (!text || streaming || !sessionId) return;
    input.value = "";
    addUser(text);
    runTurn("turn", { session: sessionId, message: text });
  }
  composer.onsubmit = (e) => { e.preventDefault(); send(); };
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };
  skipBtn.onclick = () => {
    if (streaming || !sessionId) return;
    skipBtn.hidden = true;
    addUser("Skip to proposals →");
    runTurn("turn", { session: sessionId, action: "skip" });
  };

  runTurn("start");
})();
