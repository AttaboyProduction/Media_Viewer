// Pure helpers for toolbar busy badge + progress (service worker + node selftest).
(function (root) {
  const BUSY_POLL_MS = 5000;
  const IDLE_POLL_MS = 30000;
  const QUEUE_DOT_MS = 2000;
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

  function tooltipFor(status) {
    if (!status || typeof status !== "object") return DEFAULT_TITLE;
    const total = num(status.total);
    const processed = num(status.processed);
    if (!isBusy(status) && (total <= 0 || processed >= total)) return DEFAULT_TITLE;
    const parts = [`${DEFAULT_TITLE} · ${processed}/${total || "?"}`];
    parts.push(`downloaded ${num(status.downloaded)}`);
    parts.push(`skipped ${num(status.skipped)}`);
    return parts.join(" · ");
  }

  function dotMargin(size) {
    return Math.max(1, Math.round(size / 16));
  }

  // Top-right busy dot, twice the previous corner mark, flush with the right edge.
  function busyDotGeometry(size) {
    const diameter = Math.max(10, Math.round(size / 2));
    return {
      diameter,
      x: size - diameter / 2,
      y: dotMargin(size) + diameter / 2,
    };
  }

  // Same mark, flush with the top-left corner, for a post already in the library.
  function savedDotGeometry(size) {
    const diameter = Math.max(10, Math.round(size / 2));
    return {
      diameter,
      x: diameter / 2,
      y: diameter / 2,
    };
  }

  const api = {
    BUSY_POLL_MS,
    IDLE_POLL_MS,
    QUEUE_DOT_MS,
    DEFAULT_TITLE,
    isBusy,
    isWatchDone,
    progressRatio,
    tooltipFor,
    busyDotGeometry,
    savedDotGeometry,
  };
  if (typeof globalThis !== "undefined") globalThis.ScrapIconProgress = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ScrapIconProgress = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
