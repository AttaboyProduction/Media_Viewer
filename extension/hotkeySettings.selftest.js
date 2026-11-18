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

const event = { code: "KeyQ", key: "q", type: "keydown", ctrlKey: false, altKey: false, metaKey: false, repeat: false };
assert(api.eventMatches(event, swapped.file), "eventMatches file primary");
assert(
  api.eventMatches(
    { code: "KeyF", key: "f", type: "keydown", ctrlKey: false, altKey: false, metaKey: false, repeat: false },
    swapped.file
  ),
  "eventMatches file alt"
);
assert(!api.eventMatches(event, swapped.page), "eventMatches page");
assert(api.bindingFromEvent({ code: "Escape", key: "Escape", type: "keydown" }) === null, "escape rejected");
assert(
  api.bindingFromEvent({
    code: "ShiftLeft",
    key: "Shift",
    type: "keydown",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  }) === null,
  "modifier rejected"
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
    { type: "mousedown", button: 3, ctrlKey: false, altKey: false, metaKey: false },
    mouseNorm.file
  ),
  "eventMatches mouse"
);
assert(
  !api.eventMatches(
    { type: "keydown", code: "Insert", key: "Insert", ctrlKey: false, altKey: false, metaKey: false, repeat: false },
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
  altKey: false,
  metaKey: false,
});
assert(f13 && f13.code === "F13", "F13 key");

const unidentified = api.bindingFromEvent({
  type: "keydown",
  code: "Unidentified",
  key: "LaunchApp1",
  ctrlKey: false,
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

console.log("hotkeySettings.selftest: ok");
