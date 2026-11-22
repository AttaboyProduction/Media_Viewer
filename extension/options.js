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
  const captureLabel = (slot) => (capturing === slot ? "Press key or click…" : "Capture");
  $("captureFile").textContent = captureLabel("file");
  $("captureFileAlt").textContent = captureLabel("fileAlt");
  $("capturePage").textContent = captureLabel("page");
  $("capturePageAlt").textContent = captureLabel("pageAlt");

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
  setStatus(
    `Press a key or mouse button for the ${labels[which]} shortcut (Esc cancels). Hold Ctrl / Shift / Alt (or Meta) with it if you want a chord.`
  );
  render();
}

function clonePart(part) {
  if (!part) return null;
  const out = { code: part.code, key: part.key };
  if (typeof part.button === "number") out.button = part.button;
  if (part.ctrl) out.ctrl = true;
  if (part.shift) out.shift = true;
  if (part.altMod) out.altMod = true;
  if (part.meta) out.meta = true;
  return out;
}

function cloneActions() {
  return {
    file: {
      ...clonePart(hotkeys.file),
      alt: clonePart(hotkeys.file.alt),
    },
    page: {
      ...clonePart(hotkeys.page),
      alt: clonePart(hotkeys.page.alt),
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
    ...clonePart(action),
    alt: clonePart(action.alt),
  };
  if (next.alt && ScrapHotkeySettings.sameBinding(binding, next.alt)) next.alt = null;
  return next;
}

function applyCapturedBinding(which, binding) {
  return (async () => {
    const action = actionName(which);
    const other = action === "file" ? "page" : "file";
    const next = cloneActions();

    // Same as this action's other slot → just use one copy.
    if (isAltSlot(which)) {
      if (ScrapHotkeySettings.sameBinding(binding, next[action])) {
        next[action].alt = null;
        await persist(next);
        setStatus("Second binding matches primary — left empty.");
        return;
      }
    } else if (next[action].alt && ScrapHotkeySettings.sameBinding(binding, next[action].alt)) {
      next[action].alt = null;
    }

    // Steal from the other action if that binding was already used there.
    for (const part of ScrapHotkeySettings.bindingsOf(next[other])) {
      if (ScrapHotkeySettings.sameBinding(binding, part)) {
        if (ScrapHotkeySettings.sameBinding(binding, next[other])) {
          // Taking the other primary — swap primaries when setting a primary.
          if (!isAltSlot(which)) {
            const stolen = clonePart(next[other]);
            next[other] = {
              ...clonePart(next[action]),
              alt: stripBinding(next[other], binding).alt,
            };
            next[action] = { ...stolen, alt: next[action].alt };
            next[action] = stripBinding(next[action], next[other]);
            await persist(next);
            setStatus(
              `Swapped with ${other}; saved ${action} as ${ScrapHotkeySettings.labelFor(binding)}.`
            );
            return;
          }
          // Restore capture so the user can try again.
          capturing = which;
          render();
          setStatus(
            `That binding is the ${other} primary shortcut. Pick another or change ${other} first.`,
            true
          );
          return;
        }
        next[other] = stripBinding(next[other], binding);
      }
    }

    if (isAltSlot(which)) {
      next[action].alt = clonePart(binding);
    } else {
      next[action] = {
        ...clonePart(binding),
        alt: next[action].alt,
      };
    }

    await persist(next);
    const slot = isAltSlot(which) ? "second" : "primary";
    setStatus(`Saved ${action} ${slot} as ${ScrapHotkeySettings.labelFor(binding)}.`);
  })();
}

function onCaptureInput(event) {
  if (!capturing) return;
  // Ignore the click that pressed Capture (click fires after mousedown on the button).
  if (event.type === "mousedown" || event.type === "auxclick") {
    const t = event.target;
    if (t && t.closest && t.closest("button")) return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.type === "keydown" && (event.key === "Escape" || event.code === "Escape")) {
    capturing = "";
    setStatus("Capture cancelled.");
    render();
    return;
  }
  const binding = ScrapHotkeySettings.bindingFromEvent(event);
  if (!binding) {
    if (event.type === "keydown") {
      setStatus("Hold Ctrl/Shift/Alt with a key, or press a key / mouse button alone.", true);
    }
    return;
  }
  // Clear synchronously so mousedown + auxclick cannot double-save.
  const which = capturing;
  capturing = "";
  render();
  applyCapturedBinding(which, binding);
}

$("captureFile").addEventListener("click", () => startCapture("file"));
$("captureFileAlt").addEventListener("click", () => startCapture("fileAlt"));
$("capturePage").addEventListener("click", () => startCapture("page"));
$("capturePageAlt").addEventListener("click", () => startCapture("pageAlt"));
$("clearFileAlt").addEventListener("click", async () => {
  const next = cloneActions();
  next.file.alt = null;
  await persist(next);
  setStatus("Cleared second file binding.");
});
$("clearPageAlt").addEventListener("click", async () => {
  const next = cloneActions();
  next.page.alt = null;
  await persist(next);
  setStatus("Cleared second page binding.");
});
$("reset").addEventListener("click", async () => {
  capturing = "";
  await persist(ScrapHotkeySettings.DEFAULTS);
  setStatus("Reset to Insert / Home (second bindings empty).");
});

window.addEventListener("keydown", onCaptureInput, true);
window.addEventListener("mousedown", onCaptureInput, true);
window.addEventListener("auxclick", onCaptureInput, true);
window.addEventListener(
  "contextmenu",
  (event) => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
  },
  true
);

ScrapHotkeySettings.loadHotkeys().then((loaded) => {
  hotkeys = loaded;
  render();
});
