// node extension/hotkeyTarget.selftest.js
const { compileSites, chooseFileHotkey, scrapableUrl } = require("./shared.js");

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

console.log("hotkeyTarget.selftest: ok");
