// Page world, so shortcuts still arrive when a video player is focused.
// The isolated content script does the actual queue.
// Bare keyboard bindings: never preventDefault — the key keeps its normal function.
// Mouse bindings and Ctrl/Shift/Alt/Meta chords: preventDefault so the browser does not also handle them.
(function () {
  if (window.__scrapDownloadHotkeysMain) return;
  window.__scrapDownloadHotkeysMain = true;

  function mouseButtonFromCode(code) {
    const m = /^Mouse(\d+)$/i.exec(code || "");
    return m ? Number(m[1]) : null;
  }

  function parseMods(token) {
    const parts = String(token || "")
      .toLowerCase()
      .split("+")
      .map((p) => p.trim())
      .filter(Boolean);
    return {
      ctrl: parts.indexOf("ctrl") >= 0,
      shift: parts.indexOf("shift") >= 0,
      alt: parts.indexOf("alt") >= 0,
      meta: parts.indexOf("meta") >= 0,
    };
  }

  function modsMatch(event, token) {
    const want = parseMods(token);
    return (
      Boolean(event.ctrlKey) === want.ctrl &&
      Boolean(event.shiftKey) === want.shift &&
      Boolean(event.altKey) === want.alt &&
      Boolean(event.metaKey) === want.meta
    );
  }

  function matchPart(event, code, keyName, modsToken) {
    if (!code && !keyName) return false;
    if (!modsMatch(event, modsToken)) return false;
    const mouseBtn = mouseButtonFromCode(code) ?? mouseButtonFromCode(keyName);
    if (mouseBtn != null) {
      if (typeof event.button !== "number") return false;
      if (event.type && String(event.type).indexOf("key") === 0) return false;
      return event.button === mouseBtn;
    }
    if (typeof event.button === "number" && event.type && String(event.type).indexOf("key") !== 0) {
      return false;
    }
    if (code && event.code === code) return true;
    const pressed = typeof event.key === "string" ? event.key : "";
    const lower = pressed.toLowerCase();
    if (keyName && (pressed === keyName || lower === String(keyName).toLowerCase())) return true;
    return false;
  }

  function isMediaNode(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    return tag === "video" || tag === "audio";
  }

  function pathHasMedia(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (let i = 0; i < path.length; i++) {
      if (isMediaNode(path[i])) return true;
    }
    if (isMediaNode(event && event.target)) return true;
    if (isMediaNode(document.activeElement)) return true;
    return false;
  }

  function isHiddenFocusTrap(el) {
    if (!el || !el.getBoundingClientRect) return false;
    try {
      const style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return true;
      }
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return true;
      if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) {
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function isTypingTarget(el) {
    if (!el) return false;
    if (el.nodeType === 3) el = el.parentElement;
    if (!el || !el.tagName) return false;
    if (isMediaNode(el)) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (["button", "checkbox", "radio", "range", "file", "submit", "reset", "color"].indexOf(type) === -1) {
        return true;
      }
    }
    if (el.isContentEditable) return true;
    const role = (el.getAttribute && (el.getAttribute("role") || "")).toLowerCase();
    if (role === "textbox" || role === "searchbox" || role === "combobox") return true;
    return Boolean(
      el.closest &&
        el.closest(
          "textarea, select, [contenteditable='true'], [contenteditable=''], [role='textbox'], [role='searchbox']"
        )
    );
  }

  function shouldSkipHotkey(event) {
    // Video/audio focus (and player focus traps) must still fire shortcuts.
    if (pathHasMedia(event)) return false;
    const target = event && event.target;
    const active = document.activeElement;
    if (isTypingTarget(target) && !isHiddenFocusTrap(target)) return true;
    if (isTypingTarget(active) && !isHiddenFocusTrap(active)) return true;
    return false;
  }

  function notifyIsolated(which) {
    const payload = { source: "scrap-download-hotkey", key: which };
    window.postMessage(payload, "*");
    // Video players often live in iframes — also tell the top frame's content script.
    try {
      if (window.top && window.top !== window) {
        window.top.postMessage(payload, "*");
      }
    } catch {
      // Cross-origin top: iframe content.js (all_frames) still handles locally.
    }
  }

  function resolveWhich(event) {
    const root = document.documentElement;
    const fileCode = (root && root.dataset.scrapHotkeyFileCode) || "Insert";
    const fileKey = (root && root.dataset.scrapHotkeyFileKey) || "Insert";
    const fileMods = (root && root.dataset.scrapHotkeyFileMods) || "";
    const fileAltCode = (root && root.dataset.scrapHotkeyFileAltCode) || "";
    const fileAltKey = (root && root.dataset.scrapHotkeyFileAltKey) || "";
    const fileAltMods = (root && root.dataset.scrapHotkeyFileAltMods) || "";
    const pageCode = (root && root.dataset.scrapHotkeyPageCode) || "Home";
    const pageKey = (root && root.dataset.scrapHotkeyPageKey) || "Home";
    const pageMods = (root && root.dataset.scrapHotkeyPageMods) || "";
    const pageAltCode = (root && root.dataset.scrapHotkeyPageAltCode) || "";
    const pageAltKey = (root && root.dataset.scrapHotkeyPageAltKey) || "";
    const pageAltMods = (root && root.dataset.scrapHotkeyPageAltMods) || "";
    if (
      matchPart(event, fileCode, fileKey, fileMods) ||
      matchPart(event, fileAltCode, fileAltKey, fileAltMods)
    ) {
      return "f";
    }
    if (
      matchPart(event, pageCode, pageKey, pageMods) ||
      matchPart(event, pageAltCode, pageAltKey, pageAltMods)
    ) {
      return "p";
    }
    return "";
  }

  function allowPageShortcut() {
    const root = document.documentElement;
    const onSite = root && root.dataset.scrapHotkeys === "site";
    let isTop = true;
    try {
      isTop = !window.top || window.top === window;
    } catch {
      isTop = false;
    }
    // In an iframe, forward anyway — top frame enforces site.
    return onSite || !isTop;
  }

  function onInput(event) {
    const isMouse =
      (event.type === "mousedown" || event.type === "auxclick") && typeof event.button === "number";
    if (event.type === "keydown") {
      if (event.repeat) return;
      const commandMod = Boolean(event.ctrlKey || event.altKey || event.metaKey);
      if (shouldSkipHotkey(event) && !commandMod) return;
    } else if (!isMouse) {
      return;
    }

    const which = resolveWhich(event);
    if (!which) return;
    if (which === "p" && !allowPageShortcut()) return;

    const navKey =
      event.code === "BrowserBack" ||
      event.code === "BrowserForward" ||
      event.key === "BrowserBack" ||
      event.key === "BrowserForward";
    const chord = Boolean(event.ctrlKey || event.shiftKey || event.altKey || event.metaKey);
    if (isMouse || navKey || chord) {
      event.preventDefault();
      event.stopPropagation();
    }
    notifyIsolated(which);
  }

  window.addEventListener("keydown", onInput, true);
  window.addEventListener("mousedown", onInput, true);
  window.addEventListener("auxclick", onInput, true);
})();
