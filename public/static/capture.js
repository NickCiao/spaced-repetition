(() => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
  const QKEY = "sr-capture-queue";
  const form = document.getElementById("cap");
  const flash = document.getElementById("flash");

  const readQueue = () => JSON.parse(localStorage.getItem(QKEY) || "[]");
  const writeQueue = (q) => localStorage.setItem(QKEY, JSON.stringify(q));

  async function post(item) {
    const res = await fetch("/api/capture", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item)
    });
    if (!res.ok) throw new Error("capture failed");
  }

  async function flushQueue() {
    const q = readQueue();
    let flushed = false;
    while (q.length) {
      try { await post(q[0]); q.shift(); writeQueue(q); flushed = true; }
      catch { break; }
    }
    if (flushed) refreshToday();
  }

  async function refreshToday() {
    try {
      const res = await fetch("/api/captures/today");
      const { items } = await res.json();
      document.getElementById("today").innerHTML =
        items.map((i) => `<div class="item">${i.text.replace(/</g, "&lt;")}</div>`).join("") ||
        '<p class="source">Nothing yet.</p>';
    } catch { /* offline */ }
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

  form.onsubmit = async (e) => {
    e.preventDefault();
    const item = { text: document.getElementById("text").value, note: null };
    const src = document.getElementById("source").value.trim();
    if (src) item.title = src;
    const file = document.getElementById("photo").files[0];
    try {
      if (file) {
        const blob = await downscale(file);
        const up = await fetch("/api/assets", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
        item.image_id = (await up.json()).id;
      }
      await post(item);
      flash.textContent = "Saved ✓";
      refreshToday();
    } catch {
      const q = readQueue(); q.push(item); writeQueue(q);
      flash.textContent = "Offline — queued, will sync.";
    }
    form.reset();
  };

  document.getElementById("source").oninput = async (e) => {
    try {
      const res = await fetch(`/api/sources?q=${encodeURIComponent(e.target.value)}`);
      const { items } = await res.json();
      document.getElementById("source-list").innerHTML =
        items.map((s) => `<option value="${s.name.replace(/"/g, "&quot;")}">`).join("");
    } catch { /* offline */ }
  };

  window.addEventListener("online", flushQueue);
  flushQueue();
  refreshToday();
})();
