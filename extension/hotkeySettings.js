// Shared hotkey defaults and helpers (background importScripts, options, popup, content).
(function (root) {
  // Insert / Home — not letter keys, so typing on gallery pages still works.
  // Each action has a primary binding and an optional second (`alt`), empty by default.
  // Bindings are keyboard `{ code, key }` or mouse `{ code: "MouseN", key: "MouseN", button: N }`.
  const DEFAULTS = {
    file: { code: "Insert", key: "Insert", alt: null },
    page: { code: "Home", key: "Home", alt: null },
  };

  const MOUSE_LABELS = {
    0: "Left click",
    1: "Middle click",
    2: "Right click",
    3: "Mouse back",
    4: "Mouse forward",
  };

  function mouseCode(button) {
    return "Mouse" + String(button);
  }

  function buttonFromPart(part) {
    if (!part || typeof part !== "object") return null;
    if (typeof part.button === "number" && part.button >= 0 && Number.isFinite(part.button)) {
      return part.button;
    }
    const raw = part.code || part.key || "";
    const m = /^Mouse(\d+)$/i.exec(raw);
    if (!m) return null;
    return Number(m[1]);
  }

  function isMousePart(part) {
    return buttonFromPart(part) != null;
  }

  function normalizeKeyPart(raw, fallback) {
    if (!raw || typeof raw !== "object") return fallback ? { ...fallback } : null;
    const mouseBtn = buttonFromPart(raw);
    if (mouseBtn != null) {
      const code = mouseCode(mouseBtn);
      return { code, key: code, button: mouseBtn };
    }
    const code = typeof raw.code === "string" && raw.code ? raw.code : fallback && fallback.code;
    let key = typeof raw.key === "string" && raw.key ? raw.key : fallback && fallback.key;
    if (!code || !key) return fallback ? { ...fallback } : null;
    if (key.length === 1) key = key.toLowerCase();
    const out = { code, key };
    return out;
  }

  function normalizeAlt(raw) {
    if (!raw || typeof raw !== "object") return null;
    const mouseBtn = buttonFromPart(raw);
    if (mouseBtn != null) {
      const code = mouseCode(mouseBtn);
      return { code, key: code, button: mouseBtn };
    }
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
    const out = { code: primary.code, key: primary.key, alt };
    if (typeof primary.button === "number") out.button = primary.button;
    return out;
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
    const mouseBtn = buttonFromPart(binding);
    if (mouseBtn != null) {
      return MOUSE_LABELS[mouseBtn] || "Mouse " + mouseBtn;
    }
    const key = binding.key || "";
    if (key.length === 1) return key.toUpperCase();
    if (binding.code && binding.code.startsWith("Key") && binding.code.length === 4) {
      return binding.code.slice(3);
    }
    if (binding.code && binding.code.startsWith("Digit") && binding.code.length === 6) {
      return binding.code.slice(5);
    }
    // BrowserBack / F13 / NumpadEnter / etc.
    if (binding.code && binding.code !== key) return binding.code;
    return binding.code || key || "—";
  }

  /** Primary, or "Primary / Alt" when a second binding is set. */
  function labelForAction(action) {
    if (!action) return "?";
    const primary = labelFor(action);
    if (!action.alt) return primary;
    return `${primary} / ${labelFor(action.alt)}`;
  }

  function sameBinding(a, b) {
    if (!a || !b) return false;
    const ba = buttonFromPart(a);
    const bb = buttonFromPart(b);
    if (ba != null || bb != null) return ba != null && bb != null && ba === bb;
    if (a.code && b.code && a.code === b.code) return true;
    const ka = typeof a.key === "string" ? a.key.toLowerCase() : "";
    const kb = typeof b.key === "string" ? b.key.toLowerCase() : "";
    return Boolean(ka && kb && ka === kb);
  }

  function bindingsOf(action) {
    if (!action) return [];
    const primary = { code: action.code, key: action.key };
    if (typeof action.button === "number") primary.button = action.button;
    const out = [primary];
    if (action.alt) out.push(action.alt);
    return out;
  }

  function isKeyboardEvent(event) {
    if (!event) return false;
    if (typeof event.type === "string" && event.type.indexOf("key") === 0) return true;
    return typeof event.code === "string" && typeof event.key === "string" && typeof event.button !== "number";
  }

  function isMouseEvent(event) {
    if (!event) return false;
    if (typeof event.button !== "number") return false;
    if (typeof event.type === "string" && event.type.indexOf("key") === 0) return false;
    return true;
  }

  function eventMatches(event, binding) {
    if (!event || !binding) return false;
    if (event.ctrlKey || event.altKey || event.metaKey) return false;
    if (event.repeat) return false;
    for (const part of bindingsOf(binding)) {
      const mouseBtn = buttonFromPart(part);
      if (mouseBtn != null) {
        if (!isMouseEvent(event)) continue;
        if (event.button === mouseBtn) return true;
        continue;
      }
      if (!isKeyboardEvent(event) && typeof event.code !== "string") continue;
      if (isMouseEvent(event) && !event.code) continue;
      if (part.code && event.code === part.code) return true;
      const key =
        typeof event.key === "string" && event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (part.key && key === part.key) return true;
    }
    return false;
  }

  function bindingFromEvent(event) {
    if (!event || event.ctrlKey || event.altKey || event.metaKey) return null;

    // Mouse buttons (including back/forward / extra buttons).
    if (isMouseEvent(event)) {
      if (typeof event.button !== "number" || event.button < 0) return null;
      const code = mouseCode(event.button);
      return { code, key: code, button: event.button };
    }

    if (!event.code && (!event.key || event.key === "Unidentified")) return null;
    if (event.code === "Escape" || event.key === "Escape") return null;
    if (
      event.code === "ShiftLeft" ||
      event.code === "ShiftRight" ||
      event.code === "ControlLeft" ||
      event.code === "ControlRight" ||
      event.code === "AltLeft" ||
      event.code === "AltRight" ||
      event.code === "MetaLeft" ||
      event.code === "MetaRight" ||
      event.key === "Shift" ||
      event.key === "Control" ||
      event.key === "Alt" ||
      event.key === "Meta"
    ) {
      return null;
    }

    // Exotic / non-default keys: BrowserBack, F13+, Numpad*, Media*, Unidentified+key, etc.
    let code = typeof event.code === "string" && event.code && event.code !== "Unidentified"
      ? event.code
      : "";
    let key = typeof event.key === "string" ? event.key : "";
    if (!code) {
      if (!key || key === "Unidentified" || key === "Dead") return null;
      code = "Key:" + key;
    }
    if (key.length === 1) key = key.toLowerCase();
    else if (!key || key === "Unidentified") {
      if (code.startsWith("Key") && code.length === 4) key = code.slice(3).toLowerCase();
      else key = code;
    }
    return { code, key };
  }

  /** True when firing this binding should cancel the browser default (nav, menu, autoscroll). */
  function shouldPreventDefault(bindingOrPart) {
    return isMousePart(bindingOrPart);
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
    MOUSE_LABELS,
    normalizeHotkeys,
    normalizeBinding,
    normalizeAlt,
    labelFor,
    labelForAction,
    sameBinding,
    bindingsOf,
    buttonFromPart,
    isMousePart,
    eventMatches,
    bindingFromEvent,
    shouldPreventDefault,
    loadHotkeys,
    saveHotkeys,
  };

  root.ScrapHotkeySettings = api;
  if (typeof self !== "undefined") self.ScrapHotkeySettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
