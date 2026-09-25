/* New / Edit prompt form (browse.ts promptForm): kind toggle, cloze helper,
   topic picker (moving a prompt = picking another topic), live preview, save,
   retire/restore (immediate, keeps unsaved edits) and delete. Reads its initial state from #prompt-editor data attributes. */
(() => {
  const root = document.getElementById("prompt-editor");
  const $ = (id) => document.getElementById(id);
  const originalTopicId = root.dataset.topicId;
  const originalTopicName = root.dataset.topicName || "";

  const picker = window.topicPicker($("topic-picker"));
  picker.resolveInitial();

  const preview = window.promptPreview($("preview"), {
    getState: () => ({ kind: $("kind").value, question: $("q").value, answer: $("a").value, source: $("psource").value }),
    inputs: [$("q"), $("a"), $("psource")]
  });

  function setKind(k) {
    $("kind").value = k;
    document.querySelectorAll(".seg-opt").forEach((b) => {
      const on = b.dataset.kind === k;
      b.classList.toggle("checked", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    const cloze = k === "cloze";
    $("answer-field").style.display = cloze ? "none" : "";
    const hint = document.querySelector(".cloze-hint");
    if (hint) hint.hidden = !cloze;
    $("cloze-hide").hidden = !cloze;
    $("q").placeholder = cloze ? (window.CLOZE_PLACEHOLDER || "") : "";
    preview.refresh();
  }
  document.querySelectorAll(".seg-opt").forEach((b) => (b.onclick = () => setKind(b.dataset.kind)));
  $("cloze-hide").onclick = () => {
    window.wrapClozeSelection($("q"));
    preview.refresh();
  };
  setKind($("kind").value);

  // The original topic is the default; a different pick moves the prompt. A typed
  // name that matches nothing is created (the server dedupes case-insensitively).
  async function resolveTopicId() {
    const t = picker.get();
    if (t.id) return t.id;
    if (!t.name) return null;
    if (t.name.toLowerCase() === originalTopicName.toLowerCase()) return originalTopicId;
    const res = await fetch("/api/topic", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: t.name })
    });
    if (!res.ok) throw new Error((await res.json()).error || "topic failed");
    return (await res.json()).id;
  }

  $("prompt-form").onsubmit = async (e) => {
    e.preventDefault();
    const flash = $("flash");
    const btn = $("save");
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const topicId = await resolveTopicId();
      if (!topicId) { flash.textContent = "topic required"; return; }
      const body = {
        id: $("pid").value || undefined,
        topic_id: topicId,
        kind: $("kind").value,
        question: $("q").value,
        answer: $("a").value,
        source: $("psource").value,
        clear_flag: true
      };
      const res = await fetch("/api/prompt", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (res.ok) { location.href = "/browse/" + topicId; return; }
      flash.textContent = (await res.json()).error;
    } catch (err) {
      flash.textContent = err.message || "Save failed";
    } finally { btn.disabled = false; }
  };

  const retire = $("retire-prompt");
  if (retire) {
    retire.onclick = async () => {
      const toRetired = retire.dataset.retired !== "1";
      if (toRetired && !confirm("Retire this prompt? It will be hidden from review but can be restored here.")) return;
      retire.disabled = true;
      try {
        const res = await fetch(`/api/prompt/${$("pid").value}/retire`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retired: toRetired })
        });
        if (!res.ok) { $("flash").textContent = (await res.json()).error || "Retire failed"; return; }
        retire.dataset.retired = toRetired ? "1" : "0";
        retire.textContent = toRetired ? "Restore to review" : "Retire";
        $("retire-note").textContent = toRetired
          ? "Retired: hidden from review. Restoring keeps its schedule and history."
          : "Hides this prompt from review. Recoverable: its schedule and history are kept.";
        $("retired-tag").hidden = !toRetired;
      } catch (err) {
        $("flash").textContent = err.message || "Retire failed";
      } finally { retire.disabled = false; }
    };
  }

  const del = $("delete-prompt");
  if (del) {
    del.onclick = async () => {
      if (!confirm("Delete this prompt permanently? Its review history will be gone and this cannot be undone.")) return;
      const res = await fetch(`/api/prompt/${$("pid").value}/delete`, { method: "POST" });
      if (res.ok) location.href = "/browse/" + originalTopicId;
      else $("flash").textContent = (await res.json()).error || "Delete failed";
    };
  }
})();
