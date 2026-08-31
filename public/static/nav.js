function setNavCount(page, n) {
  document.querySelectorAll(`[data-nav="${page}"]`).forEach((el) => {
    const cls = el.classList.contains("tab") ? "tab-due" : "rail-due";
    let b = el.querySelector("." + cls);
    if (n <= 0) {
      if (b) b.remove();
      return;
    }
    if (!b) {
      b = document.createElement("span");
      b.className = cls;
      el.appendChild(b);
    }
    b.textContent = String(n);
  });
}

function applyNavCounts(body) {
  if (typeof setNavCount !== "function" || !body) return;
  if (typeof body.dueCount === "number") setNavCount("review", body.dueCount);
  if (typeof body.inboxCount === "number") setNavCount("inbox", body.inboxCount);
}
