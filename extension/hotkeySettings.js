// Shared hotkey defaults and helpers (background importScripts, options, popup, content).
(function (root) {
  // Insert / Home — not letter keys, so typing on gallery pages still works.
  // Each action has a primary binding and an optional second (`alt`), empty by default.
  // Bindings are keyboard `{ code, key, ctrl?, shift?, altMod?, meta? }` or mouse
  // `{ code: "MouseN", key: "MouseN", button: N, ctrl?, … }` plus optional nested `alt`.
  // (`alt` = second binding; `altMod` = Alt modifier — names stay distinct.)
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

  function normalizeModifiers(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    // Accept legacy `alt: true` only when it is a real boolean (not the nested second binding).
    const altMod =
      Boolean(src.altMod) || src.alt === true;
    return {
      ctrl: Boolean(src.ctrl),
      shift: Boolean(src.shift),
      altMod,
      meta: Boolean(src.meta),
    };
  }

  function modifiersFromEvent(event) {
    if (!event) return { ctrl: false, shift: false, altMod: false, meta: false };
    return {
      ctrl: Boolean(event.ctrlKey),
      shift: Boolean(event.shiftKey),
      altMod: Boolean(event.altKey),
      meta: Boolean(event.metaKey),
    };
  }

  function hasAnyModifier(part) {
    const m = normalizeModifiers(part);
    return m.ctrl || m.shift || m.altMod || m.meta;
  }

  function modifiersEqual(a, b) {
    const left = normalizeModifiers(a);
    const right = normalizeModifiers(b);
    return (
      left.ctrl === right.ctrl &&
      left.shift === right.shift &&
      left.altMod === right.altMod &&
      left.meta === right.meta
    );
  }

  function modifiersMatchEvent(event, part) {
    const want = normalizeModifiers(part);
    return (
      Boolean(event && event.ctrlKey) === want.ctrl &&
      Boolean(event && event.shiftKey) === want.shift &&
      Boolean(event && event.altKey) === want.altMod &&
      Boolean(event && event.metaKey) === want.meta
    );
  }

  /** Attach only true modifier flags so stored JSON stays small. */
  function withModifiers(base, mods) {
    const out = { ...base };
    const m = normalizeModifiers(mods);
    if (m.ctrl) out.ctrl = true;
    else delete out.ctrl;
    if (m.shift) out.shift = true;
    else delete out.shift;
    if (m.altMod) out.altMod = true;
    else delete out.altMod;
    if (m.meta) out.meta = true;
    else delete out.meta;
    return out;
  }

  /** Compact token for dataset bridging (e.g. "ctrl+shift+alt"). */
  function modsToken(part) {
    const m = normalizeModifiers(part);
    const bits = [];
    if (m.ctrl) bits.push("ctrl");
    if (m.shift) bits.push("shift");
    if (m.altMod) bits.push("alt");
    if (m.meta) bits.push("meta");
    return bits.join("+");
  }

  function parseModsToken(token) {
    const parts = String(token || "")
      .toLowerCase()
      .split("+")
      .map((p) => p.trim())
      .filter(Boolean);
    return {
      ctrl: parts.indexOf("ctrl") >= 0,
      shift: parts.indexOf("shift") >= 0,
      altMod: parts.indexOf("alt") >= 0,
      meta: parts.indexOf("meta") >= 0,
    };
  }

  function isModifierOnlyEvent(event) {
    if (!event) return false;
    const code = event.code || "";
    const key = event.key || "";
    return (
      code === "ShiftLeft" ||
      code === "ShiftRight" ||
      code === "ControlLeft" ||
      code === "ControlRight" ||
      code === "AltLeft" ||
      code === "AltRight" ||
      code === "MetaLeft" ||
      code === "MetaRight" ||
      key === "Shift" ||
      key === "Control" ||
      key === "Alt" ||
      key === "Meta"
    );
  }

  function normalizeKeyPart(raw, fallback) {
    if (!raw || typeof raw !== "object") {
      return fallback ? withModifiers({ code: fallback.code, key: fallback.key, button: fallback.button }, fallback) : null;
    }
    const mouseBtn = buttonFromPart(raw);
    const mods = normalizeModifiers(raw);
    if (mouseBtn != null) {
      const code = mouseCode(mouseBtn);
      return withModifiers({ code, key: code, button: mouseBtn }, mods);
    }
    const code = typeof raw.code === "string" && raw.code ? raw.code : fallback && fallback.code;
    let key = typeof raw.key === "string" && raw.key ? raw.key : fallback && fallback.key;
    if (!code || !key) {
      return fallback ? withModifiers({ code: fallback.code, key: fallback.key, button: fallback.button }, fallback) : null;
    }
    if (key.length === 1) key = key.toLowerCase();
    return withModifiers({ code, key }, mods);
  }

  function normalizeAlt(raw) {
    if (!raw || typeof raw !== "object") return null;
    // Nested second binding must be an object with code/key/button — not `alt: true`.
    if (raw === true) return null;
    const mouseBtn = buttonFromPart(raw);
    const mods = normalizeModifiers(raw);
    if (mouseBtn != null) {
      const code = mouseCode(mouseBtn);
      return withModifiers({ code, key: code, button: mouseBtn }, mods);
    }
    const code = typeof raw.code === "string" && raw.code ? raw.code : "";
    let key = typeof raw.key === "string" && raw.key ? raw.key : "";
    if (!code || !key) return null;
    if (key.length === 1) key = key.toLowerCase();
    return withModifiers({ code, key }, mods);
  }

  function normalizeBinding(raw, fallback) {
    const primary = normalizeKeyPart(raw, fallback);
    const altRaw = raw && typeof raw === "object" ? raw.alt : null;
    let alt = normalizeAlt(altRaw);
    if (alt && sameBinding(alt, primary)) alt = null;
    const out = withModifiers({ code: primary.code, key: primary.key }, primary);
    if (typeof primary.button === "number") out.button = primary.button;
    out.alt = alt;
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
    let base;
    if (mouseBtn != null) {
      base = MOUSE_LABELS[mouseBtn] || "Mouse " + mouseBtn;
    } else {
      const key = binding.key || "";
      if (key.length === 1) base = key.toUpperCase();
      else if (binding.code && binding.code.startsWith("Key") && binding.code.length === 4) {
        base = binding.code.slice(3);
      } else if (binding.code && binding.code.startsWith("Digit") && binding.code.length === 6) {
        base = binding.code.slice(5);
      } else if (binding.code && binding.code !== key) {
        // BrowserBack / F13 / NumpadEnter / etc.
        base = binding.code;
      } else {
        base = binding.code || key || "—";
      }
    }
    const bits = [];
    const mods = normalizeModifiers(binding);
    if (mods.ctrl) bits.push("Ctrl");
    if (mods.shift) bits.push("Shift");
    if (mods.altMod) bits.push("Alt");
    if (mods.meta) bits.push("Meta");
    if (!bits.length) return base;
    return bits.join("+") + "+" + base;
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
    if (!modifiersEqual(a, b)) return false;
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
    const primary = withModifiers({ code: action.code, key: action.key }, action);
    if (typeof action.button === "number") primary.button = action.button;
    const out = [primary];
    if (action.alt && typeof action.alt === "object") out.push(action.alt);
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
    if (event.repeat) return false;
    for (const part of bindingsOf(binding)) {
      if (!modifiersMatchEvent(event, part)) continue;
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
    if (!event) return null;

    // Mouse buttons (including back/forward / extra buttons), with optional modifiers.
    if (isMouseEvent(event)) {
      if (typeof event.button !== "number" || event.button < 0) return null;
      const code = mouseCode(event.button);
      return withModifiers({ code, key: code, button: event.button }, modifiersFromEvent(event));
    }

    if (!event.code && (!event.key || event.key === "Unidentified")) return null;
    if (event.code === "Escape" || event.key === "Escape") return null;
    // Wait for the non-modifier key (Ctrl alone is not a binding).
    if (isModifierOnlyEvent(event)) return null;

    // Exotic / non-default keys: BrowserBack, F13+, Numpad*, Media*, Unidentified+key, etc.
    let code =
      typeof event.code === "string" && event.code && event.code !== "Unidentified" ? event.code : "";
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
    return withModifiers({ code, key }, modifiersFromEvent(event));
  }

  /** True when firing this binding should cancel the browser default (nav, menu, find, etc.). */
  function shouldPreventDefault(bindingOrPart) {
    return isMousePart(bindingOrPart) || hasAnyModifier(bindingOrPart);
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
    normalizeModifiers,
    modifiersFromEvent,
    hasAnyModifier,
    modifiersEqual,
    modifiersMatchEvent,
    modsToken,
    parseModsToken,
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
