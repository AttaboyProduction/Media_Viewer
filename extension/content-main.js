// Page world, so F still arrives when a video player is focused.
// The isolated content script does the actual queue.
(function () {
  if (window.__scrapDownloadHotkeysMain) return;
  window.__scrapDownloadHotkeysMain = true;

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
      const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
      let which = "";
      if (event.code === "KeyF" || key === "f") which = "f";
      else if (event.code === "KeyP" || key === "p") which = "p";
      else return;
      // P stays a gallery shortcut. F also saves the largest file off a supported site.
      if (which === "p") {
        const root = document.documentElement;
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
