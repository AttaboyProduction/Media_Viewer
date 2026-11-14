// node extension/hotkeyPermission.selftest.js
const {
  originPatternFromUrl,
  hotkeysAllowed,
  shouldShowAllowButton,
} = require("./hotkeyPermission.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(originPatternFromUrl("https://rule34.xyz/post/1?x=1") === "https://rule34.xyz/*", "origin from post url");
assert(originPatternFromUrl("chrome://extensions") === "", "ignore chrome urls");

assert(
  hotkeysAllowed({
    pageOrigin: "https://rule34.xyz/*",
    granted: ["https://rule34.xyz/*"],
    pendingOrigins: [],
  }) === true,
  "page host alone is enough"
);
assert(
  hotkeysAllowed({
    pageOrigin: "https://rule34.xyz/*",
    granted: ["https://rule34xyz.b-cdn.net/*"],
    pendingOrigins: [],
  }) === false,
  "cdn grant does not unlock the gallery host"
);
assert(
  hotkeysAllowed({
    pageOrigin: "https://rule34.xyz/*",
    granted: [],
    pendingOrigins: [],
    rememberedSite: false,
  }) === false,
  "no grant and not remembered keeps Allow visible"
);
assert(
  hotkeysAllowed({
    pageOrigin: "https://rule34.xyz/*",
    granted: [],
    pendingOrigins: [],
    rememberedSite: true,
  }) === true,
  "a finished Allow hides the button after the service worker restarts"
);
assert(
  hotkeysAllowed({
    pageOrigin: "https://rule34.xyz/*",
    granted: [],
    pendingOrigins: ["https://rule34.xyz/*"],
  }) === true,
  "just-granted pending origin unlocks before getAll catches up"
);
assert(shouldShowAllowButton(false, ["https://rule34.xyz/*"]) === true, "show when not allowed");
assert(shouldShowAllowButton(true, ["https://rule34.xyz/*"]) === false, "hide when allowed");
assert(shouldShowAllowButton(false, []) === false, "no origins → no button");

console.log("hotkeyPermission.selftest: ok");
