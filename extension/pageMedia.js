// Media files on a page that is not a supported gallery.
// collectFromDocument runs in the tab. The rest is pure and tested in Node.
(function (root) {
  const MIN_ICON_PX = 48;
  const MEDIA_EXT = /\.(avif|bmp|gif|jpe?g|m4v|mkv|mov|mp4|ogg|ogv|png|webm|webp)(?:$|[?#])/i;
  const VIDEO_EXT = /\.(m4v|mkv|mov|mp4|ogg|ogv|webm)(?:$|[?#])/i;
  const SVG_EXT = /\.svg(?:$|[?#])/i;

  function isMediaLink(url) {
    if (!url || typeof url !== "string" || SVG_EXT.test(url)) return false;
    try {
      return MEDIA_EXT.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  function isSvg(url) {
    return typeof url === "string" && SVG_EXT.test(url);
  }

  // Both sides known and tiny: an icon, not a file worth listing.
  function isTinyIcon(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    return w > 0 && h > 0 && w < MIN_ICON_PX && h < MIN_ICON_PX;
  }

  function fileLabel(url) {
    try {
      const parsed = new URL(url);
      const base = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
      return base || parsed.hostname;
    } catch {
      return url || "";
    }
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return "";
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 * 1024) {
      const kb = n / 1024;
      return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    }
    const mb = n / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }

  // Known sizes first, largest first. Unknown sizes keep page order at the end.
  function sortBySize(items) {
    return (items || []).slice().sort((a, b) => {
      const aKnown = Number.isFinite(a.bytes) && a.bytes >= 0;
      const bKnown = Number.isFinite(b.bytes) && b.bytes >= 0;
      if (aKnown && bKnown && a.bytes !== b.bytes) return b.bytes - a.bytes;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return (a.order || 0) - (b.order || 0);
    });
  }

  function collectFromDocument() {
    const found = [];
    const seen = new Set();
    function absolute(raw) {
      if (!raw || typeof raw !== "string") return "";
      try {
        const parsed = new URL(raw, location.href);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
        return parsed.href;
      } catch {
        return "";
      }
    }
    function add(raw, width, height, preview, kind) {
      const url = absolute(raw);
      if (!url || seen.has(url) || url === location.href || isSvg(url)) return;
      if (isTinyIcon(width, height)) return;
      seen.add(url);
      const still = kind === "video" ? absolute(preview) : url;
      found.push({ url, order: found.length, preview: still, kind: kind || "image" });
    }
    document.querySelectorAll("img").forEach((el) => {
      add(el.currentSrc || el.src, el.naturalWidth, el.naturalHeight, "", "image");
    });
    document.querySelectorAll("video").forEach((el) => {
      const file = el.currentSrc || el.src;
      if (file) add(file, el.videoWidth, el.videoHeight, el.poster, "video");
      else if (el.poster) add(el.poster, 0, 0, "", "image");
    });
    document.querySelectorAll("source[src]").forEach((el) => {
      const video = el.closest && el.closest("video");
      add(el.src, 0, 0, video && video.poster, video ? "video" : "image");
    });
    document.querySelectorAll("a[href]").forEach((el) => {
      if (!isMediaLink(el.href)) return;
      add(el.href, 0, 0, "", VIDEO_EXT.test(el.href) ? "video" : "image");
    });
    return found;
  }

  const api = {
    MIN_ICON_PX,
    isMediaLink,
    isTinyIcon,
    fileLabel,
    formatBytes,
    sortBySize,
    collectFromDocument,
  };
  root.PageMedia = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
