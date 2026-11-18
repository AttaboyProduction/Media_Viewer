// Shared hotkey defaults and helpers (background importScripts, options, popup, content).
(function (root) {
  // Insert / Home — not letter keys, so typing on gallery pages still works.
  // Each action has a primary key and an optional second key (`alt`), empty by default.
  const DEFAULTS = {
    file: { code: "Insert", key: "Insert", alt: null },
    page: { code: "Home", key: "Home", alt: null },
  };

  function normalizeKeyPart(raw, fallback) {
    if (!raw || typeof raw !== "object") return fallback ? { ...fallback } : null;
    const code = typeof raw.code === "string" && raw.code ? raw.code : fallback && fallback.code;
    let key = typeof raw.key === "string" && raw.key ? raw.key : fallback && fallback.key;
    if (!code || !key) return fallback ? { ...fallback } : null;
    if (key.length === 1) key = key.toLowerCase();
    return { code, key };
  }

  function normalizeAlt(raw) {
    if (!raw || typeof raw !== "object") return null;
    const code = typeof raw.code === "string" && raw.code ? raw.code : "";
    let key = typeof raw.key === "string" && raw.key ? raw.key : "";
    if (!code || !key) return null;
    if (key.length === 1) key = key.toLowerCase();
    return { code, key };
  }

  function normalizeBinding(raw, fallback) {
    const primary = normalizeKeyPart(raw, fallback);
    const altRaw = raw && typeof raw === "object" ? raw.alt : null;
    let alt = normalizeAlt(altRaw);
    if (alt && sameBinding(alt, primary)) alt = null;
    return { code: primary.code, key: primary.key, alt };
  }

  function normalizeHotkeys(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    return {
      file: normalizeBinding(src.file, DEFAULTS.file),
      page: normalizeBinding(src.page, DEFAULTS.page),
    };
  }

  function labelFor(binding) {
    if (!binding) return "—";
    const key = binding.key || "";
    if (key.length === 1) return key.toUpperCase();
    if (binding.code && binding.code.startsWith("Key") && binding.code.length === 4) {
      return binding.code.slice(3);
    }
    if (binding.code && binding.code.startsWith("Digit") && binding.code.length === 6) {
      return binding.code.slice(5);
    }
    return binding.code || key || "—";
  }

  /** Primary, or "Primary / Alt" when a second key is set. */
  function labelForAction(action) {
    if (!action) return "?";
    const primary = labelFor(action);
    if (!action.alt) return primary;
    return `${primary} / ${labelFor(action.alt)}`;
  }

  function sameBinding(a, b) {
    if (!a || !b) return false;
    if (a.code && b.code && a.code === b.code) return true;
    const ka = typeof a.key === "string" ? a.key.toLowerCase() : "";
    const kb = typeof b.key === "string" ? b.key.toLowerCase() : "";
    return Boolean(ka && kb && ka === kb);
  }

  function bindingsOf(action) {
    if (!action) return [];
    const out = [{ code: action.code, key: action.key }];
    if (action.alt) out.push(action.alt);
    return out;
  }

  function eventMatches(event, binding) {
    if (!event || !binding) return false;
    if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return false;
    for (const part of bindingsOf(binding)) {
      if (part.code && event.code === part.code) return true;
      const key =
        typeof event.key === "string" && event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (part.key && key === part.key) return true;
    }
    return false;
  }

  function bindingFromEvent(event) {
    if (!event || event.ctrlKey || event.altKey || event.metaKey) return null;
    if (!event.code || event.code === "Escape") return null;
    if (
      event.code === "ShiftLeft" ||
      event.code === "ShiftRight" ||
      event.code === "ControlLeft" ||
      event.code === "ControlRight" ||
      event.code === "AltLeft" ||
      event.code === "AltRight" ||
      event.code === "MetaLeft" ||
      event.code === "MetaRight"
    ) {
      return null;
    }
    let key = typeof event.key === "string" ? event.key : "";
    if (key.length === 1) key = key.toLowerCase();
    else if (event.code.startsWith("Key") && event.code.length === 4) key = event.code.slice(3).toLowerCase();
    else key = event.code;
    return { code: event.code, key };
  }

  async function loadHotkeys() {
    try {
      const stored = await chrome.storage.local.get("hotkeys");
      return normalizeHotkeys(stored.hotkeys);
    } catch {
      return normalizeHotkeys(null);
    }
  }

  function saveHotkeys(hotkeys) {
    const next = normalizeHotkeys(hotkeys);
    return chrome.storage.local.set({ hotkeys: next }).then(() => next);
  }

  const api = {
    DEFAULTS,
    normalizeHotkeys,
    normalizeBinding,
    normalizeAlt,
    labelFor,
    labelForAction,
    sameBinding,
    bindingsOf,
    eventMatches,
    bindingFromEvent,
    loadHotkeys,
    saveHotkeys,
  };

  root.ScrapHotkeySettings = api;
  if (typeof self !== "undefined") self.ScrapHotkeySettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
