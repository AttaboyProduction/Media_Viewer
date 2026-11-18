// Page world, so shortcuts still arrive when a video player is focused.
// The isolated content script does the actual queue.
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

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
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
      const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
      if (tag === "textarea" || tag === "select") return;
      if (tag === "input") {
        const type = (event.target.type || "text").toLowerCase();
        if (["button", "checkbox", "radio", "range", "file", "submit", "reset", "color"].indexOf(type) === -1) {
          return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      window.postMessage({ source: "scrap-download-hotkey", key: which }, "*");
    },
    true
  );
})();
