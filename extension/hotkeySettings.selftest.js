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

const event = { code: "KeyQ", key: "q", ctrlKey: false, altKey: false, metaKey: false, repeat: false };
assert(api.eventMatches(event, swapped.file), "eventMatches file primary");
assert(
  api.eventMatches(
    { code: "KeyF", key: "f", ctrlKey: false, altKey: false, metaKey: false, repeat: false },
    swapped.file
  ),
  "eventMatches file alt"
);
assert(!api.eventMatches(event, swapped.page), "eventMatches page");
assert(api.bindingFromEvent({ code: "Escape", key: "Escape" }) === null, "escape rejected");
assert(
  api.bindingFromEvent({
    code: "ShiftLeft",
    key: "Shift",
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

console.log("hotkeySettings.selftest: ok");
