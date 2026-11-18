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

  function partIsMouse(part) {
    if (!part) return false;
    if (typeof ScrapHotkeySettings !== "undefined" && ScrapHotkeySettings.isMousePart) {
      return ScrapHotkeySettings.isMousePart(part);
    }
    return /^Mouse\d+$/i.test(part.code || part.key || "");
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

  function isMediaNode(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    return tag === "video" || tag === "audio";
  }

  function pathHasMedia(event) {
    if (!event) return isMediaNode(document.activeElement);
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (let i = 0; i < path.length; i++) {
      if (isMediaNode(path[i])) return true;
    }
    if (isMediaNode(event.target)) return true;
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

  function shouldSkipHotkey(event) {
    if (pathHasMedia(event)) return false;
    const node = event ? focusedNode(event) : document.activeElement;
    const active = document.activeElement;
    if (isTypingTarget(node) && !isHiddenFocusTrap(node)) return true;
    if (isTypingTarget(active) && !isHiddenFocusTrap(active)) return true;
    return false;
  }

  function focusedNode(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path[0] || event.target || document.activeElement;
  }

  function pageUrlForHotkey() {
    try {
      if (window.top && window.top.location && window.top.location.href) {
        return absUrl(window.top.location.href);
      }
    } catch {
      // Cross-origin iframe — fall back to this frame URL; background uses tab URL too.
    }
    return absUrl(location.href);
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
    const parts = [{ code: binding.code, key: binding.key, button: binding.button }];
    if (binding.alt) parts.push(binding.alt);
    const isMouse = typeof event.button === "number" && (!event.type || event.type.indexOf("key") !== 0);
    for (const part of parts) {
      if (partIsMouse(part)) {
        if (!isMouse) continue;
        const m = /^Mouse(\d+)$/i.exec(part.code || part.key || "");
        const btn = typeof part.button === "number" ? part.button : m ? Number(m[1]) : -1;
        if (event.button === btn) return true;
        continue;
      }
      if (isMouse) continue;
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
          pageUrl: pageUrlForHotkey(),
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
    const isMouse =
      (event.type === "mousedown" || event.type === "auxclick") && typeof event.button === "number";
    if (event.type !== "keydown" && !isMouse) return;
    // In a text field the letter must type; skip the extension for that press.
    // Video/audio focus (and hidden player traps) still fire shortcuts.
    // Mouse shortcuts still run over media (skip typing check for pure mouse).
    if (!isMouse && shouldSkipHotkey(event)) return;
    const pressedFile = matchesBinding(event, hotkeys.file);
    const pressedPage = matchesBinding(event, hotkeys.page);
    if (!pressedFile && !pressedPage) return;
    if (
      pressedPage &&
      (!document.documentElement || document.documentElement.dataset.scrapHotkeys !== "site")
    ) {
      return;
    }
    // Mouse + browser nav keys cancel defaults; normal keys still type / keep their job.
    const navKey =
      event.code === "BrowserBack" ||
      event.code === "BrowserForward" ||
      event.key === "BrowserBack" ||
      event.key === "BrowserForward";
    if (isMouse || navKey) {
      event.preventDefault();
      event.stopPropagation();
    }
    queueHotkey(pressedFile ? "f" : "p", event);
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "scrap-download-hotkey") return;
    if (data.key !== "f" && data.key !== "p") return;
    // MAIN world posts from this window; iframe players may post to top.
    if (shouldSkipHotkey(null)) return;
    queueHotkey(data.key, null);
  });

  window.addEventListener("keydown", onHotkey, true);
  window.addEventListener("mousedown", onHotkey, true);
  window.addEventListener("auxclick", onHotkey, true);
  window.addEventListener(
    "contextmenu",
    (event) => {
      if (matchesBinding(event, hotkeys.file) || matchesBinding(event, hotkeys.page)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );
})();
