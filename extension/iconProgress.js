// Pure helpers for toolbar busy badge + progress (service worker + node selftest).
(function (root) {
  const BUSY_POLL_MS = 5000;
  const IDLE_POLL_MS = 30000;
  const DEFAULT_TITLE = "MediaViewer";

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function isBusy(status) {
    if (!status || typeof status !== "object") return false;
    if (status.running) return true;
    const total = num(status.total);
    const processed = num(status.processed);
    return total > 0 && processed < total;
  }

  function isWatchDone(status) {
    if (!status || typeof status !== "object") return true;
    if (status.running) return false;
    const total = num(status.total);
    const processed = num(status.processed);
    if (total <= 0) return true;
    return processed >= total;
  }

  function progressRatio(status) {
    if (!status || typeof status !== "object") return null;
    const total = num(status.total);
    if (total <= 0) return null;
    const processed = num(status.processed);
    return Math.min(1, Math.max(0, processed / total));
  }

  function shouldShowProgress(status) {
    if (!status || typeof status !== "object") return false;
    return num(status.total) > 0;
  }

  function outcomeCounts(status) {
    // Cancelled rows are also stored as skips. The line counts each list once.
    const items = status && Array.isArray(status.skipped_items) ? status.skipped_items : null;
    const cancelled = status && Array.isArray(status.cancelled_urls) ? status.cancelled_urls.length : 0;
    if (items) {
      const skipped = items.filter((item) => item && item.reason !== "cancelled").length;
      return { skipped, cancelled };
    }
    return { skipped: Math.max(0, num(status && status.skipped) - cancelled), cancelled };
  }

  function tooltipFor(status) {
    if (!status || typeof status !== "object") return DEFAULT_TITLE;
    const total = num(status.total);
    const processed = num(status.processed);
    if (!shouldShowProgress(status)) return DEFAULT_TITLE;
    const counts = outcomeCounts(status);
    const parts = [`${DEFAULT_TITLE} · ${processed}/${total || "?"}`];
    parts.push(`downloaded ${num(status.downloaded)}`);
    parts.push(`skipped ${counts.skipped}`);
    if (counts.cancelled > 0) parts.push(`cancelled ${counts.cancelled}`);
    return parts.join(" · ");
  }

  // Top-right busy dot, flush with the corner, mirroring the blue dot on the left.
  function busyDotGeometry(size) {
    const diameter = Math.max(10, Math.round(size / 2));
    return {
      diameter,
      x: size - diameter / 2,
      y: diameter / 2,
    };
  }

  // Same mark, flush with the top-left corner: blue in library, red while queued.
  function savedDotGeometry(size) {
    const diameter = Math.max(10, Math.round(size / 2));
    return {
      diameter,
      x: diameter / 2,
      y: diameter / 2,
    };
  }

  const DOT_SAVED = "#6aa8ff";
  const DOT_QUEUED = "#c62828";

  /** Pick the scrape panel for the open page (site id, or unsupported). */
  function panelForPage(status, siteId) {
    const sources = status && Array.isArray(status.sources) ? status.sources : [];
    const key = siteId || "unsupported";
    const match = sources.find((panel) => panel && panel.key === key);
    if (match) return match;
    if (status && !sources.length && (!siteId || status.source_key === key)) {
      // Older servers without sources[] — fall back to the flat job counters.
      return status;
    }
    return {
      key,
      label: key === "unsupported" ? "Unsupported" : key,
      running: false,
      total: 0,
      processed: 0,
      downloaded: 0,
      skipped: 0,
      similar: 0,
      message: "",
      current_url: null,
      last_gallery_url: null,
      errors: [],
      skipped_items: [],
      cancelled_urls: [],
      queue_urls: [],
    };
  }

  /** Short popup lines for one post: library and/or which queue(s). */
  function formatMediaStatus({ saved, queues }) {
    const parts = [];
    if (saved) parts.push("In library");
    for (const name of queues || []) {
      const text = String(name || "").trim();
      if (text) parts.push(`In ${text}`);
    }
    return parts.join(" · ");
  }

  const api = {
    BUSY_POLL_MS,
    IDLE_POLL_MS,
    DEFAULT_TITLE,
    DOT_SAVED,
    DOT_QUEUED,
    isBusy,
    isWatchDone,
    progressRatio,
    shouldShowProgress,
    outcomeCounts,
    tooltipFor,
    busyDotGeometry,
    savedDotGeometry,
    panelForPage,
    formatMediaStatus,
  };
  if (typeof globalThis !== "undefined") globalThis.ScrapIconProgress = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ScrapIconProgress = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
