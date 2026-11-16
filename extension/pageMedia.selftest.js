// node extension/pageMedia.selftest.js
const { isMediaLink, isTinyIcon, fileLabel, formatBytes, sortBySize } = require("./pageMedia.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(isMediaLink("https://cdn.example/a.jpg"), "jpg link");
assert(isMediaLink("https://cdn.example/a.mp4?token=1"), "video link keeps query");
assert(!isMediaLink("https://cdn.example/page"), "page is not a media link");
assert(!isMediaLink("https://cdn.example/icon.svg"), "svg is not listed");
assert(isTinyIcon(16, 16) && !isTinyIcon(16, 200) && !isTinyIcon(0, 0), "only a fully tiny image is an icon");
assert(fileLabel("https://cdn.example/folder/Cat%20Pic.jpg") === "Cat Pic.jpg", "label is the file name");
assert(formatBytes(1536) === "1.5 KB", "small kilobytes keep one decimal");
assert(formatBytes(5 * 1024 * 1024) === "5.0 MB", "megabytes");

const sorted = sortBySize([
  { url: "a", bytes: null, order: 0 },
  { url: "b", bytes: 10, order: 1 },
  { url: "c", bytes: 50, order: 2 },
  { url: "d", bytes: null, order: 3 },
]);
assert(sorted.map((item) => item.url).join(",") === "c,b,a,d", "largest first, unknown sizes stay in page order");

console.log("pageMedia.selftest: ok");
