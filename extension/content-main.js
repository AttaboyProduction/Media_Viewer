// Page world, so shortcuts still arrive when a video player is focused.
// The isolated content script does the actual queue.
// Keyboard: never preventDefault — the key keeps its normal function.
// Mouse bindings: preventDefault so back/forward / context menu do not navigate.
(function () {
  if (window.__scrapDownloadHotkeysMain) return;
  window.__scrapDownloadHotkeysMain = true;

  function mouseButtonFromCode(code) {
    const m = /^Mouse(\d+)$/i.exec(code || "");
    return m ? Number(m[1]) : null;
  }

  function matchPart(event, code, keyName) {
    if (!code && !keyName) return false;
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
    const fileAltCode = (root && root.dataset.scrapHotkeyFileAltCode) || "";
    const fileAltKey = (root && root.dataset.scrapHotkeyFileAltKey) || "";
    const pageCode = (root && root.dataset.scrapHotkeyPageCode) || "Home";
    const pageKey = (root && root.dataset.scrapHotkeyPageKey) || "Home";
    const pageAltCode = (root && root.dataset.scrapHotkeyPageAltCode) || "";
    const pageAltKey = (root && root.dataset.scrapHotkeyPageAltKey) || "";
    if (matchPart(event, fileCode, fileKey) || matchPart(event, fileAltCode, fileAltKey)) return "f";
    if (matchPart(event, pageCode, pageKey) || matchPart(event, pageAltCode, pageAltKey)) return "p";
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
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
      if (shouldSkipHotkey(event)) return;
    } else if (isMouse) {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
    } else {
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
    if (isMouse || navKey) {
      event.preventDefault();
      event.stopPropagation();
    }
    notifyIsolated(which);
  }

  window.addEventListener("keydown", onInput, true);
  window.addEventListener("mousedown", onInput, true);
  window.addEventListener("auxclick", onInput, true);
})();
