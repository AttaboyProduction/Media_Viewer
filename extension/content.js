// Hotkeys on supported gallery pages (registered / injected from the service worker).
// F = download the image/link under the cursor, or this post page.
// P = download every supported post/picture on the page.
(function () {
  if (window.__scrapDownloadHotkeys) return;
  window.__scrapDownloadHotkeys = true;

  let hoverUrl = "";
  let lastHotkeyAt = 0;

  function absUrl(value) {
    if (!value || typeof value !== "string") return "";
    try {
      const parsed = new URL(value, location.href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return parsed.href;
    } catch {
      return "";
    }
  }

  function urlFromNode(node) {
    if (!node || !node.closest) return "";
    const el = node.closest("a[href], img[src], video[src], video[poster], source[src]");
    if (!el) return "";
    return absUrl(el.href || el.currentSrc || el.src || el.poster || "");
  }

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      const notText = ["button", "checkbox", "radio", "range", "file", "submit", "reset", "color", "image"];
      return notText.indexOf(type) === -1;
    }
    if (el.isContentEditable) return true;
    return Boolean(el.closest && el.closest("textarea, select, [contenteditable='true']"));
  }

  function focusedNode(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path[0] || event.target || document.activeElement;
  }

  function flash(text) {
    let box = document.getElementById("scrap-download-flash");
    if (!box) {
      box = document.createElement("div");
      box.id = "scrap-download-flash";
      box.style.cssText =
        "position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);" +
        "max-width:min(420px,90vw);padding:8px 12px;border-radius:6px;font:13px/1.35 system-ui,sans-serif;" +
        "color:#f4f4f5;background:#18181b;border:1px solid #3f3f46;box-shadow:0 8px 24px rgba(0,0,0,.35);" +
        "pointer-events:none;opacity:0;transition:opacity .15s ease";
      (document.documentElement || document.body).appendChild(box);
    }
    box.textContent = text;
    box.style.opacity = "1";
    clearTimeout(flash._t);
    flash._t = setTimeout(() => {
      box.style.opacity = "0";
    }, 1600);
  }

  function isHotkey(event, code, letter) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return false;
    if (event.code === code) return true;
    const key = typeof event.key === "string" && event.key.length === 1 ? event.key.toLowerCase() : event.key;
    return key === letter;
  }

  document.addEventListener(
    "mouseover",
    (event) => {
      const url = urlFromNode(event.target);
      if (url) hoverUrl = url;
    },
    true
  );

  // Capture phase + stopImmediatePropagation so page shortcuts (and Find-like
  // handlers that listen for bare F/P) do not swallow the key first.
  function queueHotkey(which, event) {
      const now = Date.now();
      if (now - lastHotkeyAt < 400) return;
      lastHotkeyAt = now;
      const node = event ? focusedNode(event) : document.activeElement;
      if (which === "f") {
        const hinted = hoverUrl || urlFromNode(node) || urlFromNode(document.activeElement);
        chrome.runtime.sendMessage({
          type: "hotkeyFile",
          pageUrl: absUrl(location.href),
          hint: hinted && hinted.indexOf("blob:") === 0 ? "" : hinted,
        }, (result) => {
          if (chrome.runtime.lastError) {
            flash("MediaViewer is not available");
            return;
          }
          if (result && result.ok) flash("Queued this file");
          else flash((result && result.error) || "No supported file there");
        });
        return;
      }

      chrome.runtime.sendMessage({ type: "hotkeyPage" }, (result) => {
        if (chrome.runtime.lastError) {
          flash("MediaViewer is not available");
          return;
        }
        if (result && result.ok) {
          const n = (result.result && result.result.queued && result.result.queued.length) || 0;
          flash(n ? `Queued ${n} from this page` : "Added to the scrape queue");
        } else flash((result && result.error) || "No supported posts on this page");
      });
  }

  function onHotkey(event) {
    const node = focusedNode(event);
    if (isTypingTarget(node)) return;
    const pressedF = isHotkey(event, "KeyF", "f");
    const pressedP = isHotkey(event, "KeyP", "p");
    if (!pressedF && !pressedP) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    queueHotkey(pressedF ? "f" : "p", event);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "scrap-download-hotkey") return;
    if (isTypingTarget(document.activeElement)) return;
    queueHotkey(data.key, null);
  });

  window.addEventListener("keydown", onHotkey, true);
  window.addEventListener("keyup", onHotkey, true);
})();
