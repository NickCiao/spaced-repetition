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
  <div class="overflow"><a class="preview-toggle">Preview</a></div>
  <div class="preview"></div>
</div>`;
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
    root.addEventListener("change", (e) => {
      if (!e.target.classList.contains("kind")) return;
      const card = e.target.closest(".card");
      const isCloze = e.target.value === "cloze";
      card.querySelector(".a-label").style.display = isCloze ? "none" : "";
      card.querySelector(".a").style.display = isCloze ? "none" : "";
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
