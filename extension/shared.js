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
            console.warn("MediaViewer: bad url pattern", pattern, err);
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

  // Keep query (post id often lives there), drop hash. Used as the queue/dot page key.
  function pageIdentity(url) {
    if (!url || typeof url !== "string") return "";
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return parsed.origin + parsed.pathname + parsed.search;
    } catch {
      return "";
    }
  }

  // True when key and page are the same post page (query kept). Avoids id=1 matching id=12.
  function pageKeysMatch(key, pageUrl) {
    const a = pageIdentity(key);
    const b = pageIdentity(pageUrl);
    if (!a || !b) return false;
    if (a === b) return true;
    try {
      const ua = new URL(a);
      const ub = new URL(b);
      const pathA = (ua.pathname.replace(/\/$/, "") || "/").toLowerCase();
      const pathB = (ub.pathname.replace(/\/$/, "") || "/").toLowerCase();
      if (ua.origin.toLowerCase() !== ub.origin.toLowerCase()) return false;
      if (pathA !== pathB) {
        // Left-prefix on the path only (e.g. /post/1 vs /post/1/extra), not on query values.
        if (!pathA.startsWith(pathB + "/") && !pathB.startsWith(pathA + "/")) return false;
      }
      if (!ua.search || !ub.search) return true;
      return ua.search === ub.search;
    } catch {
      return false;
    }
  }

  // The site whose page_matches cover this URL, or null. The homepage counts.
  function siteFor(sites, url) {
    const cleaned = cleanPageUrl(url);
    if (!cleaned) return null;
    return sites.find((site) => site.page.some((re) => re.test(cleaned))) || null;
  }

  // Post URL the scraper should use. Tries full URL (query kept) then path-only.
  function scrapableUrl(sites, url) {
    const withQuery = pageIdentity(url);
    const cleaned = cleanPageUrl(url);
    if (!withQuery && !cleaned) return "";
    for (const site of sites) {
      for (const re of site.posts) {
        if (withQuery && re.test(withQuery)) return withQuery;
        if (cleaned && re.test(cleaned)) return cleaned;
      }
    }
    return "";
  }

  function isPathPostPage(url) {
    return /\/post\/\d+(?:\/|$)/.test(url || "");
  }

  // F on a post page queues that post, even if the pointer is on the video file.
  // A hovered link to a different post (a listing thumbnail) still wins.
  function chooseFileHotkey(sites, pageUrl, hintUrl) {
    const pageHit = scrapableUrl(sites, pageUrl);
    const hintHit = scrapableUrl(sites, hintUrl);
    if (pageHit) {
      if (hintHit && hintHit !== pageHit && isPathPostPage(hintHit)) return hintHit;
      return pageHit;
    }
    return hintHit || "";
  }

  const api = {
    compileSites,
    cleanPageUrl,
    pageIdentity,
    pageKeysMatch,
    siteFor,
    scrapableUrl,
    matchPatternToRegExp,
    chooseFileHotkey,
  };
  globalThis.ScrapShared = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
