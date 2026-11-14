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

allow.textContent = `Allow F / P on ${siteName}`;

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
