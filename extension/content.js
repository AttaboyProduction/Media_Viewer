// Hotkeys on supported gallery pages (registered / injected from the service worker).
// Insert (default) = download the image/link under the cursor, or this post page.
// Home (default) = download every supported post/picture on the page.
(function () {
  if (window.__scrapDownloadHotkeys) return;
  window.__scrapDownloadHotkeys = true;

  let hoverUrl = "";
  let lastHotkeyAt = 0;
  let hotkeys =
    typeof ScrapHotkeySettings !== "undefined"
      ? ScrapHotkeySettings.normalizeHotkeys(null)
      : {
          file: { code: "Insert", key: "Insert", alt: null },
          page: { code: "Home", key: "Home", alt: null },
        };

  function applyHotkeyDataset() {
    const root = document.documentElement;
    if (!root) return;
    root.dataset.scrapHotkeyFileCode = hotkeys.file.code || "";
    root.dataset.scrapHotkeyFileKey = hotkeys.file.key || "";
    root.dataset.scrapHotkeyFileAltCode = (hotkeys.file.alt && hotkeys.file.alt.code) || "";
    root.dataset.scrapHotkeyFileAltKey = (hotkeys.file.alt && hotkeys.file.alt.key) || "";
    root.dataset.scrapHotkeyPageCode = hotkeys.page.code || "";
    root.dataset.scrapHotkeyPageKey = hotkeys.page.key || "";
    root.dataset.scrapHotkeyPageAltCode = (hotkeys.page.alt && hotkeys.page.alt.code) || "";
    root.dataset.scrapHotkeyPageAltKey = (hotkeys.page.alt && hotkeys.page.alt.key) || "";
  }

  function loadHotkeysFromStorage() {
    try {
      chrome.storage.local.get("hotkeys", (stored) => {
        const raw = stored && stored.hotkeys;
        if (typeof ScrapHotkeySettings !== "undefined") {
          hotkeys = ScrapHotkeySettings.normalizeHotkeys(raw);
        } else if (raw && typeof raw === "object") {
          hotkeys = {
            file: {
              code: (raw.file && raw.file.code) || "Insert",
              key: (raw.file && raw.file.key) || "Insert",
              alt: raw.file && raw.file.alt ? raw.file.alt : null,
            },
            page: {
              code: (raw.page && raw.page.code) || "Home",
              key: (raw.page && raw.page.key) || "Home",
              alt: raw.page && raw.page.alt ? raw.page.alt : null,
            },
          };
        }
        applyHotkeyDataset();
      });
    } catch {
      applyHotkeyDataset();
    }
  }

  loadHotkeysFromStorage();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.hotkeys) return;
      loadHotkeysFromStorage();
    });
  } catch {
    // Storage API unavailable.
  }

  chrome.runtime.sendMessage({ type: "describePage", url: location.href }, (desc) => {
    if (desc && desc.onSite && document.documentElement) {
      document.documentElement.dataset.scrapHotkeys = "site";
    }
  });

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
    if (!el) return false;
    if (el.nodeType === 3) el = el.parentElement;
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      const notText = ["button", "checkbox", "radio", "range", "file", "submit", "reset", "color", "image"];
      return notText.indexOf(type) === -1;
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

  function matchesBinding(event, binding) {
    if (typeof ScrapHotkeySettings !== "undefined" && ScrapHotkeySettings.eventMatches) {
      return ScrapHotkeySettings.eventMatches(event, binding);
    }
    if (!binding || event.ctrlKey || event.altKey || event.metaKey || event.repeat) return false;
    const parts = [{ code: binding.code, key: binding.key }];
    if (binding.alt) parts.push(binding.alt);
    for (const part of parts) {
      if (part.code && event.code === part.code) return true;
      const key =
        typeof event.key === "string" && event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (part.key && key === part.key) return true;
    }
    return false;
  }

  document.addEventListener(
    "mouseover",
    (event) => {
      const url = urlFromNode(event.target);
      if (url) hoverUrl = url;
    },
    true
  );

  // Do not preventDefault — the key keeps its normal job (e.g. typing "f" in a box).
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
          if (result && result.ignored) return;
          if (result && result.ok) {
            flash(result.offline ? "Queued. Downloads when MediaViewer is running." : "Queued this file");
          }
          else flash((result && result.error) || "No supported file there");
        });
        return;
      }

      chrome.runtime.sendMessage({ type: "hotkeyPage" }, (result) => {
        if (chrome.runtime.lastError) {
          flash("MediaViewer is not available");
          return;
        }
        if (result && result.ignored) return;
        if (result && result.ok) {
          const n = (result.result && result.result.queued && result.result.queued.length) || 0;
          flash(
            result.offline
              ? "Queued. Downloads when MediaViewer is running."
              : n
                ? `Queued ${n} from this page`
                : "Added to the scrape queue"
          );
        } else flash((result && result.error) || "No supported posts on this page");
      });
  }

  function onHotkey(event) {
    if (event.type !== "keydown") return;
    const node = focusedNode(event);
    // In a text field the letter must type; skip the extension for that press.
    if (isTypingTarget(node) || isTypingTarget(document.activeElement)) return;
    const pressedFile = matchesBinding(event, hotkeys.file);
    const pressedPage = matchesBinding(event, hotkeys.page);
    if (!pressedFile && !pressedPage) return;
    if (
      pressedPage &&
      (!document.documentElement || document.documentElement.dataset.scrapHotkeys !== "site")
    ) {
      return;
    }
    queueHotkey(pressedFile ? "f" : "p", event);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "scrap-download-hotkey") return;
    if (isTypingTarget(document.activeElement)) return;
    queueHotkey(data.key, null);
  });

  window.addEventListener("keydown", onHotkey, true);
})();
