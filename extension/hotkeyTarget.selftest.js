// node extension/hotkeyTarget.selftest.js
const {
  compileSites,
  chooseFileHotkey,
  scrapableUrl,
  pageIdentity,
  pageKeysMatch,
} = require("./shared.js");

const sites = compileSites([
  {
    id: "rule34_xyz",
    name: "rule34.xyz",
    page_matches: ["https://rule34.xyz/*", "https://rule34xyz.b-cdn.net/*"],
    url_patterns: [
      "^https?://(?:[\\w-]+\\.)?rule34\\.xyz/post/(\\d+)",
      "^https?://rule34xyz\\.b-cdn\\.net/posts/\\d+/(\\d+)/",
    ],
  },
  {
    id: "rule34_xxx",
    name: "rule34.xxx",
    page_matches: ["https://rule34.xxx/*"],
    url_patterns: [
      "^https?://rule34\\.xxx/index\\.php\\?page=post&s=view&id=(\\d+)",
    ],
  },
]);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const page = "https://rule34.xyz/post/3348391";
const video = "https://rule34xyz.b-cdn.net/posts/3348/3348391/3348391.mov720.mp4";
const other = "https://rule34.xyz/post/111";

assert(chooseFileHotkey(sites, page, video) === page, "F on a playing video queues this post");
assert(chooseFileHotkey(sites, page, "") === page, "F with no hint queues this post");
assert(chooseFileHotkey(sites, page, other) === other, "F on a different post link queues that post");
assert(
  chooseFileHotkey(sites, "https://rule34.xyz/", other) === other,
  "F on a listing thumbnail queues that post"
);

const xxx = "https://rule34.xxx/index.php?page=post&s=view&id=18055730";
assert(
  scrapableUrl(sites, xxx) === pageIdentity(xxx),
  "query-string post keeps id in the scrapable URL"
);
assert(
  chooseFileHotkey(sites, xxx, "https://cdn.rule34.xxx/images/18055730.jpg") === pageIdentity(xxx),
  "F on a query-string post queues that page even when hint is a file"
);
assert(pageKeysMatch(xxx, xxx + "#frag"), "page key ignores hash");
assert(pageKeysMatch(xxx, xxx), "exact page key matches");
assert(!pageKeysMatch(xxx, "https://rule34.xxx/index.php?page=post&s=view&id=1"), "different ids do not match");

console.log("hotkeyTarget.selftest: ok");
