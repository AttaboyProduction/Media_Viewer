// Shared by the service worker. Site rules come from GET /api/extension/sites.
// The extension only decides whether a page URL is one the app can scrape.
(function () {
  function compileSites(sites) {
    const rules = [];
    for (const site of sites || []) {
      for (const pattern of site.url_patterns || []) {
        try {
          rules.push({ re: new RegExp(pattern) });
        } catch (err) {
          console.warn("Scrap Download: bad url pattern", pattern, err);
        }
      }
    }
    return rules;
  }

  // Drop the query and fragment. https://host/post/1?page=3 → https://host/post/1
  function cleanPageUrl(url) {
    if (!url || typeof url !== "string") return "";
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return parsed.origin + parsed.pathname;
    } catch {
      return "";
    }
  }

  // The cleaned page URL when the app can scrape it, otherwise "".
  function scrapableUrl(rules, url) {
    const cleaned = cleanPageUrl(url);
    if (!cleaned) return "";
    for (const rule of rules) {
      if (rule.re.test(cleaned)) return cleaned;
    }
    return "";
  }

  globalThis.ScrapShared = { compileSites, cleanPageUrl, scrapableUrl };
})();
