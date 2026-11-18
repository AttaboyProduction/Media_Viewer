const $ = (id) => document.getElementById(id);
let hotkeys = ScrapHotkeySettings.normalizeHotkeys(null);
/** @type {"" | "file" | "fileAlt" | "page" | "pageAlt"} */
let capturing = "";

function setStatus(text, isError) {
  const el = $("status");
  el.textContent = text || "";
  el.className = isError ? "err" : "";
}

function setKeyChip(id, binding) {
  const el = $(id);
  if (!binding) {
    el.textContent = "—";
    el.classList.add("empty");
    return;
  }
  el.textContent = ScrapHotkeySettings.labelFor(binding);
  el.classList.remove("empty");
}

function render() {
  setKeyChip("fileKey", hotkeys.file);
  setKeyChip("fileAltKey", hotkeys.file.alt);
  setKeyChip("pageKey", hotkeys.page);
  setKeyChip("pageAltKey", hotkeys.page.alt);

  const busy = Boolean(capturing);
  $("captureFile").textContent = capturing === "file" ? "Press a key…" : "Capture";
  $("captureFileAlt").textContent = capturing === "fileAlt" ? "Press a key…" : "Capture";
  $("capturePage").textContent = capturing === "page" ? "Press a key…" : "Capture";
  $("capturePageAlt").textContent = capturing === "pageAlt" ? "Press a key…" : "Capture";

  $("captureFile").disabled = busy && capturing !== "file";
  $("captureFileAlt").disabled = busy && capturing !== "fileAlt";
  $("capturePage").disabled = busy && capturing !== "page";
  $("capturePageAlt").disabled = busy && capturing !== "pageAlt";
  $("clearFileAlt").disabled = busy || !hotkeys.file.alt;
  $("clearPageAlt").disabled = busy || !hotkeys.page.alt;
}

async function persist(next) {
  hotkeys = await ScrapHotkeySettings.saveHotkeys(next);
  render();
}

function startCapture(which) {
  capturing = which;
  const labels = {
    file: "primary file",
    fileAlt: "second file",
    page: "primary page",
    pageAlt: "second page",
  };
  setStatus(`Press a key for the ${labels[which]} shortcut (Esc cancels).`);
  render();
}

function cloneActions() {
  return {
    file: {
      code: hotkeys.file.code,
      key: hotkeys.file.key,
      alt: hotkeys.file.alt ? { ...hotkeys.file.alt } : null,
    },
    page: {
      code: hotkeys.page.code,
      key: hotkeys.page.key,
      alt: hotkeys.page.alt ? { ...hotkeys.page.alt } : null,
    },
  };
}

function actionName(which) {
  return which.startsWith("file") ? "file" : "page";
}

function isAltSlot(which) {
  return which === "fileAlt" || which === "pageAlt";
}

/** If `binding` is used anywhere on `action`, clear that slot (primary becomes placeholder only via caller). */
function stripBinding(action, binding) {
  if (!action || !binding) return action;
  const next = {
    code: action.code,
    key: action.key,
    alt: action.alt ? { ...action.alt } : null,
  };
  if (next.alt && ScrapHotkeySettings.sameBinding(binding, next.alt)) next.alt = null;
  return next;
}

async function onKeyDown(event) {
  if (!capturing) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    capturing = "";
    setStatus("Capture cancelled.");
    render();
    return;
  }
  const binding = ScrapHotkeySettings.bindingFromEvent(event);
  if (!binding) {
    setStatus("Use a normal key (not only Shift/Ctrl/Alt).", true);
    return;
  }

  const which = capturing;
  const action = actionName(which);
  const other = action === "file" ? "page" : "file";
  const next = cloneActions();

  // Same as this action's other slot → just use one copy.
  if (isAltSlot(which)) {
    if (ScrapHotkeySettings.sameBinding(binding, next[action])) {
      next[action].alt = null;
      capturing = "";
      await persist(next);
      setStatus("Second key matches primary — left empty.");
      return;
    }
  } else if (next[action].alt && ScrapHotkeySettings.sameBinding(binding, next[action].alt)) {
    next[action].alt = null;
  }

  // Steal from the other action if that key was already bound there.
  for (const part of ScrapHotkeySettings.bindingsOf(next[other])) {
    if (ScrapHotkeySettings.sameBinding(binding, part)) {
      if (ScrapHotkeySettings.sameBinding(binding, next[other])) {
        // Taking the other primary — swap primaries when setting a primary.
        if (!isAltSlot(which)) {
          const stolen = { code: next[other].code, key: next[other].key };
          next[other] = {
            code: next[action].code,
            key: next[action].key,
            alt: stripBinding(next[other], binding).alt,
          };
          next[action] = { code: stolen.code, key: stolen.key, alt: next[action].alt };
          next[action] = stripBinding(next[action], next[other]);
          capturing = "";
          await persist(next);
          setStatus(`Swapped with ${other}; saved ${action} as ${ScrapHotkeySettings.labelFor(binding)}.`);
          return;
        }
        // Setting an alt to the other primary: move other primary aside is awkward — clear other primary by swapping with a dash? Better: reject.
        setStatus(`That key is the ${other} primary shortcut. Pick another or change ${other} first.`, true);
        return;
      }
      next[other] = stripBinding(next[other], binding);
    }
  }

  if (isAltSlot(which)) {
    next[action].alt = binding;
  } else {
    next[action] = { code: binding.code, key: binding.key, alt: next[action].alt };
  }

  capturing = "";
  await persist(next);
  const slot = isAltSlot(which) ? "second" : "primary";
  setStatus(`Saved ${action} ${slot} key as ${ScrapHotkeySettings.labelFor(binding)}.`);
}

$("captureFile").addEventListener("click", () => startCapture("file"));
$("captureFileAlt").addEventListener("click", () => startCapture("fileAlt"));
$("capturePage").addEventListener("click", () => startCapture("page"));
$("capturePageAlt").addEventListener("click", () => startCapture("pageAlt"));
$("clearFileAlt").addEventListener("click", async () => {
  const next = cloneActions();
  next.file.alt = null;
  await persist(next);
  setStatus("Cleared second file key.");
});
$("clearPageAlt").addEventListener("click", async () => {
  const next = cloneActions();
  next.page.alt = null;
  await persist(next);
  setStatus("Cleared second page key.");
});
$("reset").addEventListener("click", async () => {
  capturing = "";
  await persist(ScrapHotkeySettings.DEFAULTS);
  setStatus("Reset to Insert / Home (second keys empty).");
});

window.addEventListener("keydown", onKeyDown, true);

ScrapHotkeySettings.loadHotkeys().then((loaded) => {
  hotkeys = loaded;
  render();
});
