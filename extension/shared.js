// Shared by the service worker. Site rules come from GET /api/extension/sites.
// Nothing site-specific lives here: page_matches, file_matches, and the post
// regexes are all from the installed adapter.
(function () {
  function matchPatternToRegExp(pattern) {
    const match = /^(\*|https?):\/\/(\*|[^/]+)(\/.*)$/.exec(pattern);
    if (!match) return null;
    const scheme = match[1] === "*" ? "https?" : match[1];
    let host = match[2];
    if (host === "*") {
      host = "[^/]+";
    } else if (host.startsWith("*.")) {
      host = "(?:[^/]+\\.)?" + host.slice(2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else {
      host = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    const path = match[3].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
    return new RegExp("^" + scheme + "://" + host + path + "$", "i");
  }

  function compileSites(sites) {
    return (sites || []).map((site) => ({
      id: site.id,
      name: site.name,
      pageMatches: site.page_matches || [],
      fileMatches: site.file_matches || [],
      page: (site.page_matches || []).map(matchPatternToRegExp).filter(Boolean),
      posts: (site.url_patterns || [])
        .map((pattern) => {
          try {
            return new RegExp(pattern);
          } catch (err) {
            console.warn("Scrap Download: bad url pattern", pattern, err);
            return null;
          }
        })
        .filter(Boolean),
    }));
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

  // The site whose page_matches cover this URL, or null. The homepage counts.
  function siteFor(sites, url) {
    const cleaned = cleanPageUrl(url);
    if (!cleaned) return null;
    return sites.find((site) => site.page.some((re) => re.test(cleaned))) || null;
  }

  // The cleaned URL when a post regex matches it, otherwise "".
  function scrapableUrl(sites, url) {
    const cleaned = cleanPageUrl(url);
    if (!cleaned) return "";
    for (const site of sites) {
      if (site.posts.some((re) => re.test(cleaned))) return cleaned;
    }
    return "";
  }

  globalThis.ScrapShared = { compileSites, cleanPageUrl, siteFor, scrapableUrl, matchPatternToRegExp };
})();
