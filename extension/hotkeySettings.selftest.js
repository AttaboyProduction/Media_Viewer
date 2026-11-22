/**
 * Run: node extension/hotkeySettings.selftest.js
 */
const path = require("path");
const fs = require("fs");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "hotkeySettings.js"), "utf8");
const sandbox = { self: {}, globalThis: {} };
vm.runInNewContext(src, sandbox);
const api = sandbox.globalThis.ScrapHotkeySettings || sandbox.self.ScrapHotkeySettings;
if (!api) throw new Error("ScrapHotkeySettings missing");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

const defaults = api.normalizeHotkeys(null);
assert(defaults.file.code === "Insert" && defaults.page.code === "Home", "defaults Insert/Home");
assert(defaults.file.alt === null && defaults.page.alt === null, "second keys empty by default");
assert(api.labelFor(defaults.file) === "Insert", "label Insert");
assert(api.labelForAction(defaults.file) === "Insert", "action label without alt");

const swapped = api.normalizeHotkeys({
  file: { code: "KeyQ", key: "q", alt: { code: "KeyF", key: "f" } },
  page: { code: "KeyW", key: "w" },
});
assert(api.labelFor(swapped.file) === "Q", "label Q");
assert(api.labelForAction(swapped.file) === "Q / F", "action label with alt");
assert(api.sameBinding(swapped.file, { code: "KeyQ", key: "q" }), "sameBinding");
assert(!api.sameBinding(swapped.file, swapped.page), "different bindings");
assert(api.bindingsOf(swapped.file).length === 2, "bindingsOf includes alt");

const event = {
  code: "KeyQ",
  key: "q",
  type: "keydown",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
};
assert(api.eventMatches(event, swapped.file), "eventMatches file primary");
assert(
  api.eventMatches(
    {
      code: "KeyF",
      key: "f",
      type: "keydown",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
    },
    swapped.file
  ),
  "eventMatches file alt"
);
assert(!api.eventMatches(event, swapped.page), "eventMatches page");
assert(
  !api.eventMatches(
    {
      code: "KeyQ",
      key: "q",
      type: "keydown",
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
    },
    swapped.file
  ),
  "plain binding ignores Ctrl+key"
);
assert(api.bindingFromEvent({ code: "Escape", key: "Escape", type: "keydown" }) === null, "escape rejected");
assert(
  api.bindingFromEvent({
    code: "ShiftLeft",
    key: "Shift",
    type: "keydown",
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    metaKey: false,
  }) === null,
  "modifier-only rejected"
);

const dupAlt = api.normalizeHotkeys({
  file: { code: "Insert", key: "Insert", alt: { code: "Insert", key: "Insert" } },
  page: { code: "Home", key: "Home" },
});
assert(dupAlt.file.alt === null, "alt matching primary is dropped");

// Mouse buttons
const mouseBack = api.bindingFromEvent({
  type: "mousedown",
  button: 3,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
});
assert(mouseBack && mouseBack.button === 3 && mouseBack.code === "Mouse3", "mouse back binding");
assert(api.labelFor(mouseBack) === "Mouse back", "mouse back label");

const mouseNorm = api.normalizeHotkeys({
  file: { code: "Mouse3", key: "Mouse3", button: 3 },
  page: { code: "Mouse4", button: 4 },
});
assert(mouseNorm.file.button === 3, "normalize keeps mouse button");
assert(mouseNorm.page.button === 4 && mouseNorm.page.code === "Mouse4", "normalize page mouse from button");
assert(api.labelFor(mouseNorm.page) === "Mouse forward", "mouse forward label");
assert(api.labelForAction(mouseNorm.file) === "Mouse back", "action label mouse");
assert(
  api.eventMatches(
    {
      type: "mousedown",
      button: 3,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    },
    mouseNorm.file
  ),
  "eventMatches mouse"
);
assert(
  !api.eventMatches(
    {
      type: "keydown",
      code: "Insert",
      key: "Insert",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
    },
    mouseNorm.file
  ),
  "mouse binding ignores keyboard"
);
assert(api.sameBinding(mouseNorm.file, { button: 3 }), "sameBinding mouse by button");
assert(api.isMousePart(mouseNorm.file) === true, "isMousePart");
assert(api.isMousePart(defaults.file) === false, "keyboard not mouse");

// Exotic / non-default keyboard
const browserBack = api.bindingFromEvent({
  type: "keydown",
  code: "BrowserBack",
  key: "BrowserBack",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
});
assert(browserBack && browserBack.code === "BrowserBack", "BrowserBack key");
assert(api.labelFor(browserBack) === "BrowserBack", "BrowserBack label");

const f13 = api.bindingFromEvent({
  type: "keydown",
  code: "F13",
  key: "F13",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
});
assert(f13 && f13.code === "F13", "F13 key");

const unidentified = api.bindingFromEvent({
  type: "keydown",
  code: "Unidentified",
  key: "LaunchApp1",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
});
assert(unidentified && unidentified.code === "Key:LaunchApp1", "Unidentified falls back to key");

const middleAlt = api.normalizeHotkeys({
  file: { code: "Insert", key: "Insert", alt: { button: 1 } },
  page: { code: "Home", key: "Home" },
});
assert(middleAlt.file.alt && middleAlt.file.alt.button === 1, "alt mouse middle");
assert(api.labelForAction(middleAlt.file) === "Insert / Middle click", "primary key + mouse alt label");

// Ctrl / Shift / Alt (+ Meta) chords
const ctrlShiftD = api.bindingFromEvent({
  type: "keydown",
  code: "KeyD",
  key: "d",
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  metaKey: false,
});
assert(ctrlShiftD && ctrlShiftD.ctrl && ctrlShiftD.shift && !ctrlShiftD.altMod, "capture Ctrl+Shift+D");
assert(api.labelFor(ctrlShiftD) === "Ctrl+Shift+D", "label Ctrl+Shift+D");
assert(api.modsToken(ctrlShiftD) === "ctrl+shift", "modsToken ctrl+shift");
assert(api.parseModsToken("ctrl+alt").altMod === true, "parseModsToken alt");

const chordNorm = api.normalizeHotkeys({
  file: { code: "KeyD", key: "d", ctrl: true, shift: true },
  page: { code: "KeyP", key: "p", altMod: true },
});
assert(chordNorm.file.ctrl && chordNorm.file.shift && chordNorm.file.alt === null, "normalize keeps chord + empty second");
assert(chordNorm.page.altMod === true && !chordNorm.page.ctrl, "normalize Alt+P");
assert(api.labelFor(chordNorm.page) === "Alt+P", "label Alt+P");
assert(
  api.eventMatches(
    {
      type: "keydown",
      code: "KeyD",
      key: "d",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      repeat: false,
    },
    chordNorm.file
  ),
  "eventMatches Ctrl+Shift+D"
);
assert(
  !api.eventMatches(
    {
      type: "keydown",
      code: "KeyD",
      key: "d",
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
    },
    chordNorm.file
  ),
  "Ctrl+D alone does not match Ctrl+Shift+D"
);
assert(
  api.eventMatches(
    {
      type: "keydown",
      code: "KeyP",
      key: "p",
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
      metaKey: false,
      repeat: false,
    },
    chordNorm.page
  ),
  "eventMatches Alt+P"
);
assert(api.shouldPreventDefault(chordNorm.file) === true, "chords preventDefault");
assert(api.shouldPreventDefault(defaults.file) === false, "bare Insert does not preventDefault");
assert(
  !api.sameBinding(chordNorm.file, { code: "KeyD", key: "d" }),
  "sameBinding requires matching modifiers"
);

const altClick = api.bindingFromEvent({
  type: "mousedown",
  button: 1,
  ctrlKey: false,
  shiftKey: false,
  altKey: true,
  metaKey: false,
});
assert(altClick && altClick.button === 1 && altClick.altMod, "Alt+middle click capture");
assert(api.labelFor(altClick) === "Alt+Middle click", "Alt+middle label");

// Second binding still named `alt` — must not be confused with Alt modifier.
const withSecond = api.normalizeHotkeys({
  file: {
    code: "Insert",
    key: "Insert",
    alt: { code: "KeyX", key: "x", ctrl: true },
  },
  page: { code: "Home", key: "Home" },
});
assert(withSecond.file.alt && withSecond.file.alt.ctrl && !withSecond.file.altMod, "second binding can be a chord");
assert(api.labelForAction(withSecond.file) === "Insert / Ctrl+X", "primary + chord second label");

console.log("hotkeySettings.selftest: ok");
