(() => {
  const MODES = {
    native: {
      accept: ".zip",
      fileNameDefault: "Select a file to import",
      fileHint: ".zip export from this app",
      consequence: "Can edit, add, and retire existing prompts — preview first.",
      applyLabel: "Apply changes",
      expects: ["export"],
    },
    foreign: {
      accept: ".txt,.mochi,.zip",
      fileNameDefault: "Select a file to import",
      fileHint: ".txt, .mochi, or .zip from Anki / Mochi",
      consequence: "Adds new prompts with fresh scheduling — never touches existing cards.",
      applyLabel: "Import new",
      expects: ["anki-txt", "mochi", "unknown-zip"],
    },
  };

  const MISMATCH = {
    "native:anki-txt": {
      text: "That looks like an Anki plain-text export.",
      switchMode: "foreign",
      switchLabel: "Switch to Migrate in?",
    },
    "native:mochi": {
      text: "That looks like a Mochi export.",
      switchMode: "foreign",
      switchLabel: "Switch to Migrate in?",
    },
    "native:anki-apkg": {
      text: "Anki .apkg isn't supported — re-export from Anki as plain text.",
      switchMode: "foreign",
      switchLabel: "Switch to Migrate in?",
    },
    "native:unknown-zip": {
      text: "This zip doesn't look like an export from this app.",
      switchMode: "foreign",
      switchLabel: "Try Migrate in instead?",
    },
    "foreign:export": {
      text: "That looks like an export from this app.",
      switchMode: "native",
      switchLabel: "Switch to Restore / refactor?",
    },
    "foreign:anki-apkg": {
      text: "Anki .apkg isn't supported — re-export from Anki as plain text.",
      switchMode: null,
      switchLabel: null,
    },
  };

  const fileInput = document.getElementById("import-file");
  const fileName = document.getElementById("file-name");
  const fileMeta = document.getElementById("file-meta");
  const fileHint = document.getElementById("file-hint");
  const consequence = document.getElementById("import-consequence");
  const importSlot = document.getElementById("import-slot");
  const applyBtn = document.getElementById("import-apply");
  const dryBtn = document.getElementById("import-dry");
  const importOut = document.getElementById("importout");
  const warnBox = document.getElementById("import-file-warn");
  const warnText = document.getElementById("import-file-warn-text");
  const switchBtn = document.getElementById("import-switch-btn");

  let mode = "native";
  let pendingSwitchMode = null;

  function ext(name) {
    const i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i).toLowerCase() : "";
  }

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
    return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  }

  function dosToDate(date, time) {
    const day = date & 0x1f;
    const month = (date >> 5) & 0x0f;
    const year = ((date >> 9) & 0x7f) + 1980;
    const sec = (time & 0x1f) * 2;
    const min = (time >> 5) & 0x3f;
    const hour = (time >> 11) & 0x1f;
    if (month < 1 || day < 1) return null;
    return new Date(year, month - 1, day, hour, min, sec);
  }

  function zipLatestDosDate(buffer) {
    const u8 = new Uint8Array(buffer);
    let latest = null;
    for (let i = 0; i < u8.length - 30; i++) {
      if (u8[i] !== 0x50 || u8[i + 1] !== 0x4b || u8[i + 2] !== 0x03 || u8[i + 3] !== 0x04) continue;
      const time = u8[i + 10] | (u8[i + 11] << 8);
      const date = u8[i + 12] | (u8[i + 13] << 8);
      const d = dosToDate(date, time);
      if (d && (!latest || d > latest)) latest = d;
      const nameLen = u8[i + 26] | (u8[i + 27] << 8);
      const extraLen = u8[i + 28] | (u8[i + 29] << 8);
      i += 29 + nameLen + extraLen;
    }
    return latest;
  }

  function fmtExportAge(d) {
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return "exported today";
    if (days === 1) return "exported yesterday";
    return `exported ${days} days ago`;
  }

  async function sniffZip(buf) {
    const latin = new TextDecoder("latin1").decode(
      new Uint8Array(buf.slice(0, Math.min(buf.byteLength, 512000)))
    );
    if (latin.includes("settings.json") && latin.includes("prompts/")) return "export";
    if (latin.includes("data.json")) return "mochi";
    if (/collection\.anki2/.test(latin)) return "anki-apkg";
    return "unknown-zip";
  }

  async function classifyFile(file) {
    const e = ext(file.name);
    if (e === ".txt") return "anki-txt";
    if (e === ".mochi") return "mochi";
    if (e !== ".zip") return "unknown";
    const buf = await file.arrayBuffer();
    return sniffZip(buf);
  }

  function clearFileDisplay() {
    const cfg = MODES[mode];
    fileName.textContent = cfg.fileNameDefault;
    fileMeta.hidden = true;
    fileMeta.textContent = "";
    fileHint.hidden = false;
    fileHint.textContent = cfg.fileHint;
  }

  async function updateFileDisplay(file, kind) {
    fileName.textContent = file.name;
    fileHint.hidden = true;
    let meta = fmtBytes(file.size);
    if (kind === "export") {
      const buf = await file.arrayBuffer();
      const latest = zipLatestDosDate(buf);
      if (latest) meta += ` · ${fmtExportAge(latest)}`;
    }
    fileMeta.textContent = meta;
    fileMeta.hidden = false;
  }

  function hideWarn() {
    warnBox.hidden = true;
    pendingSwitchMode = null;
    dryBtn.disabled = false;
    applyBtn.disabled = false;
  }

  function showWarn(key) {
    const msg = MISMATCH[key];
    if (!msg) {
      hideWarn();
      return;
    }
    warnText.textContent = msg.text;
    if (msg.switchMode) {
      switchBtn.hidden = false;
      switchBtn.textContent = msg.switchLabel;
      pendingSwitchMode = msg.switchMode;
    } else {
      switchBtn.hidden = true;
      pendingSwitchMode = null;
    }
    warnBox.hidden = false;
    dryBtn.disabled = true;
    applyBtn.disabled = true;
  }

  async function validateFile() {
    const file = fileInput.files[0];
    if (!file) {
      clearFileDisplay();
      hideWarn();
      return;
    }
    const kind = await classifyFile(file);
    await updateFileDisplay(file, kind);
    const cfg = MODES[mode];
    if (cfg.expects.includes(kind)) {
      hideWarn();
      return;
    }
    showWarn(`${mode}:${kind}`);
  }

  function setMode(m, opts = {}) {
    mode = m;
    const cfg = MODES[m];
    document.querySelectorAll(".seg-opt[data-mode]").forEach((btn) => {
      const on = btn.dataset.mode === m;
      btn.classList.toggle("checked", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    fileInput.accept = cfg.accept;
    importSlot.classList.toggle("open", m === "foreign");
    if (!opts.keepFile) {
      fileInput.value = "";
      clearFileDisplay();
      hideWarn();
    } else if (!fileInput.files[0]) {
      clearFileDisplay();
    }
    consequence.textContent = cfg.consequence;
    applyBtn.textContent = cfg.applyLabel;
    if (!opts.keepFile) importOut.textContent = "";
    if (opts.keepFile || fileInput.files[0]) validateFile();
  }

  document.querySelectorAll(".seg-opt[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  fileInput.addEventListener("change", () => {
    if (!fileInput.files[0]) {
      clearFileDisplay();
      hideWarn();
      return;
    }
    validateFile();
  });

  switchBtn.addEventListener("click", () => {
    if (!pendingSwitchMode) return;
    setMode(pendingSwitchMode, { keepFile: true });
  });

  document.getElementById("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      session_cap: parseInt(document.getElementById("session_cap").value, 10),
      desired_retention: parseFloat(document.getElementById("desired_retention").value),
      email_hour: parseInt(document.getElementById("email_hour").value, 10),
      timezone: document.getElementById("timezone").value.trim(),
      email_to: document.getElementById("email_to").value.trim(),
      base_url: document.getElementById("base_url").value.trim(),
      resend_api_key: document.getElementById("resend_api_key").value,
    };
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const flash = document.getElementById("flash");
    if (res.ok) {
      flash.textContent = "Saved ✓";
      location.reload();
    } else {
      flash.textContent = (await res.json()).error;
    }
  });

  document.getElementById("clear-resend").addEventListener("click", async () => {
    const body = {
      session_cap: parseInt(document.getElementById("session_cap").value, 10),
      desired_retention: parseFloat(document.getElementById("desired_retention").value),
      email_hour: parseInt(document.getElementById("email_hour").value, 10),
      timezone: document.getElementById("timezone").value.trim(),
      email_to: document.getElementById("email_to").value.trim(),
      base_url: document.getElementById("base_url").value.trim(),
      clear_resend_api_key: true,
    };
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    document.getElementById("flash").textContent = res.ok ? "API key cleared" : (await res.json()).error;
    if (res.ok) location.reload();
  });

  document.getElementById("import-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = fileInput.files[0];
    if (!f || dryBtn.disabled) return;
    const apply = e.submitter?.id === "import-apply" ? 1 : 0;
    let res;
    if (mode === "native") {
      res = await fetch("/import?apply=" + apply, { method: "POST", body: f });
    } else {
      const source = encodeURIComponent(document.getElementById("foreignsource").value.trim() || "Anki import");
      res = await fetch("/import/foreign?apply=" + apply + "&source=" + source, { method: "POST", body: f });
    }
    importOut.textContent = JSON.stringify(await res.json(), null, 2);
  });

  setMode("native");
})();
