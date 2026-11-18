const params = new URLSearchParams(location.search);
const siteId = params.get("site") || "";
const siteName = params.get("name") || "this site";
const pageUrl = params.get("url") || "";
const origins = (params.get("origins") || "")
  .split("\n")
  .map((part) => part.trim())
  .filter(Boolean);
const msg = document.getElementById("msg");
const allow = document.getElementById("allow");

allow.textContent = `Allow shortcuts on ${siteName}`;

chrome.storage.local.get("hotkeys", (stored) => {
  const hotkeys = (stored && stored.hotkeys) || {};
  const file = (hotkeys.file && hotkeys.file.key) || "Insert";
  const page = (hotkeys.page && hotkeys.page.key) || "Home";
  const fileLabel = file.length === 1 ? file.toUpperCase() : file;
  const pageLabel = page.length === 1 ? page.toUpperCase() : page;
  allow.textContent = `Allow ${fileLabel} / ${pageLabel} on ${siteName}`;
  msg.textContent =
    `Shortcut keys: ${fileLabel} = one file, ${pageLabel} = whole page. Chrome will ask to read this site so those keys can find posts.`;
});

allow.addEventListener("click", async () => {
  allow.disabled = true;
  if (!origins.length) {
    msg.textContent = "No site to allow.";
    return;
  }
  try {
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      msg.textContent = "Not allowed. You can close this window.";
      allow.disabled = false;
      return;
    }
    // Pass origins explicitly — chrome.permissions.getAll() can lag and leave F/P uninjected.
    await chrome.runtime.sendMessage({
      type: "hotkeysGranted",
      siteId,
      url: pageUrl,
      origins,
    });
    await chrome.runtime.sendMessage({
      type: "setupHotkeys",
      siteId,
      url: pageUrl,
      origins,
    });
    msg.textContent = "Shortcuts on. Refresh the gallery tab once, then F / P work. Closing…";
    allow.hidden = true;
    setTimeout(() => window.close(), 1200);
  } catch (err) {
    msg.textContent = err && err.message ? err.message : String(err);
    allow.disabled = false;
  }
});
