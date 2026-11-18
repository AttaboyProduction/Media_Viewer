// Page world, so shortcuts still arrive when a video player is focused.
// The isolated content script does the actual queue.
// Never preventDefault — the key keeps its normal function (typing, page shortcuts).
(function () {
  if (window.__scrapDownloadHotkeysMain) return;
  window.__scrapDownloadHotkeysMain = true;

  function matchPart(event, code, keyName) {
    if (!code && !keyName) return false;
    if (code && event.code === code) return true;
    const pressed = typeof event.key === "string" ? event.key : "";
    const lower = pressed.toLowerCase();
    if (keyName && (pressed === keyName || lower === String(keyName).toLowerCase())) return true;
    return false;
  }

  function isTypingTarget(el) {
    if (!el) return false;
    if (el.nodeType === 3) el = el.parentElement;
    if (!el || !el.tagName) return false;
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

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
      if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
      const root = document.documentElement;
      const fileCode = (root && root.dataset.scrapHotkeyFileCode) || "Insert";
      const fileKey = (root && root.dataset.scrapHotkeyFileKey) || "Insert";
      const fileAltCode = (root && root.dataset.scrapHotkeyFileAltCode) || "";
      const fileAltKey = (root && root.dataset.scrapHotkeyFileAltKey) || "";
      const pageCode = (root && root.dataset.scrapHotkeyPageCode) || "Home";
      const pageKey = (root && root.dataset.scrapHotkeyPageKey) || "Home";
      const pageAltCode = (root && root.dataset.scrapHotkeyPageAltCode) || "";
      const pageAltKey = (root && root.dataset.scrapHotkeyPageAltKey) || "";
      let which = "";
      if (matchPart(event, fileCode, fileKey) || matchPart(event, fileAltCode, fileAltKey)) which = "f";
      else if (matchPart(event, pageCode, pageKey) || matchPart(event, pageAltCode, pageAltKey)) which = "p";
      else return;
      // Page shortcut stays a gallery shortcut. File also saves off a supported site.
      if (which === "p") {
        if (!root || root.dataset.scrapHotkeys !== "site") return;
      }
      // Let the key through (no preventDefault) and notify the isolated world.
      window.postMessage({ source: "scrap-download-hotkey", key: which }, "*");
    },
    true
  );
})();
