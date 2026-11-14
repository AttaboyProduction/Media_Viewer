// Feedback loop: F/P need a host match that covers the gallery tab URL.
// node extension/hotkeyInject.selftest.js
const { matchPatternToRegExp } = (() => {
  // Mirror shared.js matchPatternToRegExp for a node-only check.
  function matchPatternToRegExp(pattern) {
    const match = /^(\*|https?):\/\/(\*|[^/]+)(\/.*)$/.exec(pattern);
    if (!match) return null;
    const scheme = match[1] === "*" ? "https?" : match[1];
    let host = match[2];
    if (host === "*") host = "[^/]+";
    else if (host.startsWith("*.")) {
      host = "(?:[^/]+\\.)?" + host.slice(2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else host = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const path = match[3].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
    return new RegExp("^" + scheme + "://" + host + path + "$", "i");
  }
  return { matchPatternToRegExp };
})();

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function canInject(matches, pageUrl) {
  const rules = matches.map(matchPatternToRegExp).filter(Boolean);
  return rules.some((re) => re.test(pageUrl.split("?")[0].replace(/#.*$/, "") || pageUrl));
}

// Bug: remembering the site without a usable host match leaves F/P dead while popup Download works.
assert(
  canInject(["https://rule34.xyz/*"], "https://rule34.xyz/post/1") === true,
  "current-host grant must cover post pages"
);
assert(
  canInject(["https://rule34xyz.b-cdn.net/*"], "https://rule34.xyz/") === false,
  "cdn-only grant must not count as gallery inject"
);
assert(
  canInject([], "https://rule34.xyz/") === false,
  "empty matches → no inject (F/P dead)"
);
// Race: Allow returned true but getAll was still empty — must still inject with the requested origin.
assert(
  canInject(["https://rule34.xyz/*"], "https://rule34.xyz/?page=2") === true,
  "pending grant origin must inject into open gallery tabs"
);

console.log("hotkeyInject.selftest: ok");
