/* Combobox over /api/topics: opens on focus with the most-recently-used list,
   filters as you type (client-side — the whole list is small), arrow/Enter/Esc
   keys, and an explicit "New topic" row when the text matches nothing exactly.

   Usage: const picker = topicPicker(document.getElementById("topic-picker"));
   picker.get() → { id, name } — id of the chosen existing topic, or null with
   free text in name (server creates/dedupes). picker.resolveInitial() marks a
   prefilled value as an existing topic when it matches one, case-insensitively. */
window.topicPicker = (root) => {
  const input = root.querySelector("input");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const menu = document.createElement("div");
  menu.className = "topic-menu";
  menu.setAttribute("role", "listbox");
  menu.id = (input.id || "topic") + "-menu";
  menu.hidden = true;
  root.appendChild(menu);

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", menu.id);

  let topics = null; // null until fetched; [] when fetch failed (offline) or empty
  let items = [];
  let active = -1;
  let selectedId = null;

  async function load() {
    if (topics) return;
    try {
      const res = await fetch("/api/topics");
      topics = (await res.json()).items || [];
    } catch { topics = []; } // offline: degrades to a plain text input
  }

  function rows(q) {
    const needle = q.trim().toLowerCase();
    const matches = needle
      ? (topics || []).filter((t) => t.name.toLowerCase().includes(needle))
      : (topics || []).slice();
    const out = matches.map((t) => ({ id: t.id, name: t.name, count: t.count }));
    if (needle && !matches.some((t) => t.name.toLowerCase() === needle)) {
      out.push({ id: null, name: q.trim(), create: true });
    }
    return out;
  }

  function renderMenu() {
    items = rows(input.value);
    if (!items.length) { close(); return; }
    menu.innerHTML = items.map((t, i) => {
      const cls = `topic-opt${t.create ? " topic-opt-new" : ""}${i === active ? " active" : ""}`;
      const label = t.create
        ? `<i class="ph ph-plus"></i> New topic: \u201C${esc(t.name)}\u201D`
        : `${esc(t.name)}${t.count ? `<span class="topic-opt-count">${t.count}</span>` : ""}`;
      return `<div class="${cls}" role="option" id="${menu.id}-${i}" data-i="${i}" aria-selected="${i === active}">${label}</div>`;
    }).join("");
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", `${menu.id}-${active}`);
      menu.children[active].scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function close() {
    menu.hidden = true;
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function choose(i) {
    const t = items[i];
    if (!t) return;
    input.value = t.name;
    selectedId = t.id;
    close();
  }

  input.addEventListener("focus", async () => { await load(); active = -1; renderMenu(); });
  input.addEventListener("input", () => { selectedId = null; active = -1; renderMenu(); });
  input.addEventListener("keydown", (e) => {
    if (menu.hidden) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); renderMenu(); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); renderMenu(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); renderMenu(); }
    else if (e.key === "Enter") { if (active >= 0) { e.preventDefault(); choose(active); } else close(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  // pointerdown + preventDefault keeps focus in the input, so blur never races the pick
  menu.addEventListener("pointerdown", (e) => {
    const opt = e.target.closest(".topic-opt");
    if (!opt) return;
    e.preventDefault();
    choose(parseInt(opt.dataset.i, 10));
  });
  input.addEventListener("blur", () => setTimeout(close, 100));

  return {
    get: () => ({ id: selectedId, name: input.value.trim() }),
    async resolveInitial() {
      if (!input.value.trim()) return;
      await load();
      const needle = input.value.trim().toLowerCase();
      const hit = (topics || []).find((t) => t.name.toLowerCase() === needle);
      if (hit) { selectedId = hit.id; input.value = hit.name; }
    }
  };
};
