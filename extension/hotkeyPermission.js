// Pure helpers for F/P host permission. Loaded by the service worker and by node --check tests.
(function (root) {
  function originPatternFromUrl(url) {
    if (!url || typeof url !== "string") return "";
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return `${parsed.protocol}//${parsed.hostname}/*`;
    } catch {
      return "";
    }
  }

  function originListsCover(pageOrigin, lists) {
    if (!pageOrigin) return false;
    const merged = [];
    for (const list of lists) {
      if (Array.isArray(list)) merged.push(...list);
    }
    if (merged.includes("*://*/*") || merged.includes("<all_urls>")) return true;
    return merged.includes(pageOrigin);
  }

  // Hide Allow after a successful Allow for this site, or when this page's host is granted.
  function hotkeysAllowed({ pageOrigin, granted, pendingOrigins, rememberedSite }) {
    if (rememberedSite) return true;
    return originListsCover(pageOrigin, [granted, pendingOrigins]);
  }

  function shouldShowAllowButton(hotkeys, hotkeyOrigins) {
    return !hotkeys && Array.isArray(hotkeyOrigins) && hotkeyOrigins.length > 0;
  }

  const api = { originPatternFromUrl, originListsCover, hotkeysAllowed, shouldShowAllowButton };
  if (typeof globalThis !== "undefined") globalThis.ScrapHotkeyPermission = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ScrapHotkeyPermission = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
