(() => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
  const QKEY = "sr-capture-queue";
  const form = document.getElementById("cap");
  const flash = document.getElementById("flash");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const readQueue = () => JSON.parse(localStorage.getItem(QKEY) || "[]");
  const writeQueue = (q) => localStorage.setItem(QKEY, JSON.stringify(q));

  async function post(item) {
    const res = await fetch("/api/capture", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item)
    });
    if (res.ok) return;
    const err = new Error("capture failed " + res.status);
    err.permanent = res.status === 400; // validation rejects never succeed on retry
    throw err;
  }

  let flushing = false;
  async function flushQueue() {
    if (flushing) return; // reconnects can fire online twice — one flusher at a time
    flushing = true;
    try {
      const q = readQueue();
      let flushed = false;
      while (q.length) {
        try { await post(q[0]); q.shift(); writeQueue(q); flushed = true; }
        catch (err) {
          if (err && err.permanent) { q.shift(); writeQueue(q); continue; } // drop poison items, keep the rest
          break; // transient: retry on next reconnect
        }
      }
      if (flushed) refreshToday();
    } finally { flushing = false; }
  }

  async function refreshToday() {
    try {
      const res = await fetch("/api/captures/today");
      const { items } = await res.json();
      document.getElementById("today-count").textContent = items.length ? String(items.length) : "";
      document.getElementById("today").innerHTML =
        items.map((i) => `<div class="row"><div class="row-main"><div class="row-text">${esc(i.text)}</div></div></div>`).join("") ||
        '<p class="empty">Nothing yet.</p>';
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
    const text = document.getElementById("text").value;
    if (!text.trim()) { flash.textContent = "Nothing to save."; return; }
    const item = { text };
    const src = document.getElementById("source").value.trim();
    if (src) item.title = src;
    const file = document.getElementById("photo").files[0];
    let photoFailed = false;
    if (file) {
      try {
        const blob = await downscale(file);
        const up = await fetch("/api/assets", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
        if (!up.ok) throw new Error("upload failed");
        item.image_id = (await up.json()).id;
      } catch { photoFailed = true; } // photo needs a connection; text still saves honestly
    }
    try {
      await post(item);
      flash.textContent = photoFailed ? "Saved text ✓ — photo upload failed" : "Saved ✓";
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
        items.map((s) => `<option value="${esc(s.name)}">`).join("");
    } catch { /* offline */ }
  };

  window.addEventListener("online", flushQueue);
  flushQueue();
  refreshToday();
})();
