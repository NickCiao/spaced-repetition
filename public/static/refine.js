(() => {
  const root = document.getElementById("refine");
  let formIndex = 0;

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function promptForm() {
    formIndex += 1;
    return `
<div class="card elev-sm prompt-editor" data-i="${formIndex}">
  <div class="seg" role="tablist" aria-label="Prompt kind">
    <button type="button" class="seg-opt checked" data-kind="qa" role="tab" aria-selected="true">Q / A</button>
    <button type="button" class="seg-opt" data-kind="cloze" role="tab" aria-selected="false">Cloze</button>
  </div>
  <div class="field">
    <label>Question</label>
    <textarea class="input q"></textarea>
  </div>
  <div class="field a-field">
    <label class="a-label">Answer</label>
    <textarea class="input a"></textarea>
  </div>
  <div class="prompt-editor-foot">
    <label class="btn btn-ghost"><i class="ph ph-image"></i> Attach image<input type="file" class="img" accept="image/*" hidden></label>
    <button type="button" class="btn btn-ghost preview-toggle">Preview</button>
  </div>
  <div class="preview"></div>
</div>`;
  }

  async function downscale(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  }

  async function uploadImage(file) {
    const blob = await downscale(file);
    const res = await fetch("/api/assets", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
    if (!res.ok) throw new Error("upload failed");
    return (await res.json()).id;
  }

  async function attachImage(file, target) {
    try {
      const id = await uploadImage(file);
      target.value += `\n![](assets/${id})\n`;
    } catch {
      document.getElementById("flash").textContent = "Image upload failed.";
    }
  }

  function setKind(card, kind) {
    card.querySelectorAll(".seg-opt").forEach((b) => {
      const on = b.dataset.kind === kind;
      b.classList.toggle("checked", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    const aField = card.querySelector(".a-field");
    if (aField) aField.style.display = kind === "cloze" ? "none" : "";
  }

  function render() {
    root.innerHTML = `
<div class="form">
  <div class="field">
    <label for="src-name">Source</label>
    <input class="input" type="text" id="src-name" list="source-list" value="${esc(root.dataset.sourceName)}">
    <datalist id="source-list"></datalist>
  </div>
  <div id="forms">${promptForm()}</div>
  <div class="form-actions">
    <button type="button" class="btn btn-secondary" id="add"><i class="ph ph-plus"></i> Another prompt</button>
    <button type="button" class="btn btn-primary" id="save">Save prompts</button>
  </div>
  <p class="flash" id="flash"></p>
</div>`;

    document.getElementById("src-name").oninput = async (e) => {
      const res = await fetch(`/api/sources?q=${encodeURIComponent(e.target.value)}`);
      const { items } = await res.json();
      document.getElementById("source-list").innerHTML =
        items.map((s) => `<option value="${esc(s.name)}">`).join("");
    };
    document.getElementById("add").onclick = () =>
      document.getElementById("forms").insertAdjacentHTML("beforeend", promptForm());
    document.getElementById("save").onclick = save;
    root.addEventListener("click", async (e) => {
      const seg = e.target.closest(".seg-opt");
      if (seg) {
        const card = seg.closest(".card");
        setKind(card, seg.dataset.kind);
        return;
      }
      if (!e.target.classList.contains("preview-toggle")) return;
      const card = e.target.closest(".card");
      const body = collect(card);
      const res = await fetch("/api/preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const { questionHtml, answerHtml } = await res.json();
      card.querySelector(".preview").innerHTML = `<hr>${questionHtml}<hr>${answerHtml}`;
    });
    root.addEventListener("change", async (e) => {
      if (e.target.classList.contains("img")) {
        const card = e.target.closest(".card");
        const file = e.target.files[0];
        e.target.value = "";
        if (!file) return;
        const kind = card.querySelector(".seg-opt.checked")?.dataset.kind ?? "qa";
        await attachImage(file, card.querySelector(kind === "cloze" ? ".q" : ".a"));
      }
    });
    root.addEventListener("paste", async (e) => {
      const t = e.target;
      if (!t.classList || !(t.classList.contains("q") || t.classList.contains("a"))) return;
      const file = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
      if (!file || !file.type.startsWith("image/")) return;
      e.preventDefault();
      await attachImage(file, t);
    });
  }

  const collect = (card) => ({
    kind: card.querySelector(".seg-opt.checked")?.dataset.kind ?? "qa",
    question: card.querySelector(".q").value,
    answer: card.querySelector(".a").value
  });

  async function save() {
    const btn = document.getElementById("save");
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const cards = [...document.querySelectorAll("#forms .card")].map(collect)
        .filter((p) => p.question.trim());
      const res = await fetch("/api/refine", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capture_id: root.dataset.capture,
          source: { name: document.getElementById("src-name").value, url: root.dataset.sourceUrl || undefined },
          prompts: cards
        })
      });
      if (res.ok) { location.href = "/inbox"; return; }
      document.getElementById("flash").textContent = (await res.json()).error;
    } finally { btn.disabled = false; }
  }

  render();
})();
