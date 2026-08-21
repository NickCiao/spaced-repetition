(() => {
  const root = document.getElementById("refine");
  const prompts = [];

  // dataset values decode HTML entities — re-escape at every DOM re-interpolation.
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function promptForm() {
    return `
<div class="card" data-i="${prompts.length}">
  <label>Kind</label>
  <select class="kind"><option value="qa">Q / A</option><option value="cloze">Cloze</option></select>
  <label>Question (cloze: use {{spans}})</label>
  <textarea class="q"></textarea>
  <label class="a-label">Answer</label>
  <textarea class="a"></textarea>
  <label class="img-label">Image</label>
  <input type="file" class="img" accept="image/*">
  <div class="overflow"><a class="preview-toggle">Preview</a></div>
  <div class="preview"></div>
</div>`;
  }

  // Same downscale as capture.js: keeps refine's pasted/attached images consistent
  // with captured ones (bounded size, one encoding) rather than uploading originals.
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

  function render() {
    root.innerHTML = `
<label>Source</label>
<input type="text" id="src-name" list="source-list" value="${esc(root.dataset.sourceName)}">
<datalist id="source-list"></datalist>
<div id="forms">${promptForm()}</div>
<div class="btnrow"><button id="add">+ prompt</button><button id="save" class="primary">Save prompts</button></div>
<p class="flash" id="flash"></p>`;

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
      if (e.target.classList.contains("kind")) {
        const card = e.target.closest(".card");
        const isCloze = e.target.value === "cloze";
        card.querySelector(".a-label").style.display = isCloze ? "none" : "";
        card.querySelector(".a").style.display = isCloze ? "none" : "";
        return;
      }
      if (e.target.classList.contains("img")) {
        const card = e.target.closest(".card");
        const file = e.target.files[0];
        e.target.value = ""; // allow re-attaching the same file later
        if (!file) return;
        const isCloze = card.querySelector(".kind").value === "cloze";
        await attachImage(file, card.querySelector(isCloze ? ".q" : ".a"));
      }
    });
    // Paste an image directly into a question/answer textarea — same upload path
    // as the file input, targeting whichever textarea the cursor is in.
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
    kind: card.querySelector(".kind").value,
    question: card.querySelector(".q").value,
    answer: card.querySelector(".a").value
  });

  async function save() {
    const btn = document.getElementById("save");
    if (btn.disabled) return; // double-click guard — the server claim is the real defense
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
