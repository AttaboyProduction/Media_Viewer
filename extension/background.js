importScripts("shared.js", "hotkeyPermission.js", "hotkeySettings.js", "iconProgress.js", "pageMedia.js");

const API = "http://127.0.0.1:8000/api";
const VIEWER_URL = "http://127.0.0.1:8000/";
const MENU_PAGE = "scrap-download-page";
const MENU_FILE = "scrap-download-file";
const MENU_RAW = "scrap-download-raw";
const ALARM_IDLE = "scrap-idle-watch";
const ALARM_SITES = "scrap-sites-sync";
const SITE_UNSUPPORTED = "Site is not supported";
const ICONS = {
  on: { 16: "icons/green16.png", 32: "icons/green32.png", 48: "icons/green48.png" },
  off: { 16: "icons/red16.png", 32: "icons/red32.png", 48: "icons/red48.png" },
};

let sites = [];
let scrapeEnabled = false;
let online = false;
let menuGen = 0;
let watching = false;
let lastJob = null;
// Cleaned post/file URLs that already have a library row.
const savedPostUrls = new Set();
let watchTimer = 0;
let idleTimer = 0;
const bitmapCache = new Map();
// Origins just granted this session — getAll() can lag and leave F/P uninjected.
let pendingHotkeyOrigins = [];

async function api(path, options = {}) {
  try {
    const response = await fetch(API + path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (setOnline(path === "/health" ? response.ok : true) && online) {
      scheduleIdlePoll();
    }
    return { ok: response.ok, status: response.status, data };
  } catch {
    setOnline(false);
    return { ok: false, status: 0, data: null };
  }
}

function applyChromeBadge() {
  // Busy uses a drawn top-right dot on the icon (smaller than Chrome's badge).
  // The badge text is only for "app offline".
  if (!online) {
    chrome.action.setBadgeBackgroundColor({ color: "#333333" });
    chrome.action.setBadgeText({ text: "off" });
    return;
  }
  chrome.action.setBadgeText({ text: "" });
}

function setOnline(value) {
  if (online === value) {
    applyChromeBadge();
    return false;
  }
  online = value;
  applyChromeBadge();
  return true;
}

async function loadBitmap(path) {
  if (bitmapCache.has(path)) return bitmapCache.get(path);
  const response = await fetch(chrome.runtime.getURL(path));
  const bitmap = await createImageBitmap(await response.blob());
  bitmapCache.set(path, bitmap);
  return bitmap;
}

function libraryKey(url) {
  return ScrapShared.scrapableUrl(sites, url) || ScrapShared.pageIdentity(url);
}

function pageKey(url) {
  return ScrapShared.pageIdentity(url) || libraryKey(url);
}

function setHasPage(set, pageUrl) {
  if (!pageUrl || !set || !set.size) return false;
  for (const key of set) {
    if (ScrapShared.pageKeysMatch(key, pageUrl)) return true;
  }
  return false;
}

function fillDot(ctx, dot, color, size) {
  const radius = dot.diameter / 2;
  const border = Math.max(1, Math.round(size / 16));
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = "#000000";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, Math.max(1, radius - border), 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawIconOverlays(bitmap, { ratio, busy, corner }) {
  const size = bitmap.width;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  if (ratio != null) {
    const h = Math.max(2, Math.round(size * 0.14));
    const y = size - h;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, y, size, h);
    ctx.fillStyle = "#43a047";
    ctx.fillRect(0, y, Math.round(size * ratio), h);
  }
  // Top-left: red while in any queue, blue once fully in the library.
  if (corner === "queued") {
    fillDot(ctx, ScrapIconProgress.savedDotGeometry(size), ScrapIconProgress.DOT_QUEUED, size);
  } else if (corner === "saved") {
    fillDot(ctx, ScrapIconProgress.savedDotGeometry(size), ScrapIconProgress.DOT_SAVED, size);
  }
  if (busy) fillDot(ctx, ScrapIconProgress.busyDotGeometry(size), ScrapIconProgress.DOT_QUEUED, size);
  return ctx.getImageData(0, 0, size, size);
}

async function refreshSavedPosts(urls) {
  const unique = [...new Set(urls.filter(Boolean).map((url) => pageKey(url) || url))];
  if (!unique.length) return;
  const res = await api("/extension/saved", {
    method: "POST",
    body: JSON.stringify({ urls: unique.slice(0, 500) }),
  });
  if (!res.ok || !res.data || !Array.isArray(res.data.saved)) return;
  const saved = new Set(res.data.saved);
  for (const url of unique) {
    const hit = [...saved].some((item) => ScrapShared.pageKeysMatch(item, url)) || saved.has(url);
    if (hit) savedPostUrls.add(url);
    else savedPostUrls.delete(url);
  }
}

const queuedPostUrls = new Set();
let queuedPostsLoaded = null;

function loadQueuedPosts() {
  if (!queuedPostsLoaded) {
    queuedPostsLoaded = new Promise((resolve) => {
      chrome.storage.local.get({ queuedPosts: [] }, (stored) => {
        const list = Array.isArray(stored.queuedPosts) ? stored.queuedPosts : [];
        for (const url of list) queuedPostUrls.add(url);
        resolve();
      });
    });
  }
  return queuedPostsLoaded;
}

function persistQueuedPosts() {
  chrome.storage.local.set({ queuedPosts: [...queuedPostUrls] }).catch(() => {});
}

function markQueued(urls, pageUrl) {
  const list = (urls || []).filter(Boolean);
  if (!list.length) return;
  let changed = false;
  const keys = [];
  const page = pageKey(pageUrl);
  if (page) keys.push(page);
  for (const url of list) {
    const key = libraryKey(url) || pageKey(url);
    if (key) keys.push(key);
  }
  for (const key of keys) {
    if (!key || queuedPostUrls.has(key)) continue;
    queuedPostUrls.add(key);
    changed = true;
  }
  if (changed) persistQueuedPosts();
  paintAllTabs().catch(() => {});
}

function queuedUrlsFrom(result, fallback) {
  if (!result || !result.ok) return [];
  if (result.offline) return fallback;
  const data = result.result || {};
  if (Array.isArray(data.queued) && data.queued.length) return data.queued;
  if (data.started || data.appended) return fallback;
  return [];
}

function addWaitingUrls(waiting, urls) {
  for (const url of urls || []) {
    const key = libraryKey(url) || url;
    if (key) waiting.add(key);
  }
}

function waitingHasPage(waiting, pageUrl) {
  if (!pageUrl || !waiting || !waiting.size) return false;
  for (const key of waiting) {
    if (ScrapShared.pageKeysMatch(key, pageUrl)) return true;
  }
  return false;
}

async function settleQueuedPosts() {
  await loadQueuedPosts();
  if (queuedPostUrls.size) await refreshSavedPosts([...queuedPostUrls]);
  await readOfflineQueue();
  const waiting = new Set();
  addWaitingUrls(waiting, offlineQueue);
  for (const url of offlineQueue) {
    const page = pageKey(url);
    if (page) waiting.add(page);
  }
  const status = await api("/scrape/status");
  if (status.ok && status.data) {
    addWaitingUrls(waiting, status.data.queue_urls);
    if (status.data.current_url) {
      waiting.add(libraryKey(status.data.current_url) || pageKey(status.data.current_url));
    }
    for (const panel of status.data.sources || []) {
      addWaitingUrls(waiting, panel.queue_urls);
      if (panel.current_url) {
        waiting.add(libraryKey(panel.current_url) || pageKey(panel.current_url));
      }
    }
  }
  let changed = false;
  for (const url of [...queuedPostUrls]) {
    // Stay red until the file is fully in the library, or it left every queue
    // without downloading (cleared / cancelled / failed).
    if (setHasPage(savedPostUrls, url) || !waitingHasPage(waiting, url)) {
      queuedPostUrls.delete(url);
      changed = true;
    }
  }
  if (changed) persistQueuedPosts();
}

async function iconImageData(url) {
  await loadQueuedPosts();
  const jobBusy = !!(lastJob && ScrapIconProgress.isBusy(lastJob));
  const showProgress = !!(lastJob && ScrapIconProgress.shouldShowProgress(lastJob));
  const busy = jobBusy;
  const ratio = showProgress ? ScrapIconProgress.progressRatio(lastJob) : null;
  const queued = setHasPage(queuedPostUrls, url);
  const inLibrary = setHasPage(savedPostUrls, url);
  const corner = queued ? "queued" : inLibrary ? "saved" : null;
  if (!busy && ratio == null && !corner) return null;
  const paths = iconFor(url);
  const imageData = {};
  for (const size of [16, 32, 48]) {
    const path = paths[size] || ICONS.off[size];
    imageData[size] = drawIconOverlays(await loadBitmap(path), { ratio, busy, corner });
  }
  return imageData;
}

async function applyTitle() {
  const title = lastJob ? ScrapIconProgress.tooltipFor(lastJob) : ScrapIconProgress.DEFAULT_TITLE;
  try {
    await chrome.action.setTitle({ title });
  } catch {
    // No action context yet.
  }
}

async function startWatch() {
  watching = true;
  applyChromeBadge();
  await applyTitle();
  await paintAllTabs();
  await tickWatch();
}

async function stopWatch() {
  watching = false;
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = 0;
  }
  applyChromeBadge();
  await applyTitle();
  await settleQueuedPosts();
  await paintAllTabs();
}

function scheduleWatchTick() {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    tickWatch().catch(() => scheduleWatchTick());
  }, ScrapIconProgress.BUSY_POLL_MS);
}

async function tickWatch() {
  const res = await api("/scrape/status");
  if (!res.ok || !res.data) {
    applyChromeBadge();
    if (watching) scheduleWatchTick();
    return;
  }
  lastJob = res.data;
  if (ScrapIconProgress.isWatchDone(lastJob)) {
    await stopWatch();
    return;
  }
  watching = true;
  applyChromeBadge();
  await applyTitle();
  await paintAllTabs();
  scheduleWatchTick();
}

let offlineQueue = [];
let flushingQueue = false;

function queueIdentity(url) {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    let path = parsed.pathname || "/";
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return host + path;
  } catch {
    return "";
  }
}

function readOfflineQueue() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ offlineQueue: [] }, (stored) => {
      offlineQueue = Array.isArray(stored.offlineQueue) ? stored.offlineQueue : [];
      resolve(offlineQueue);
    });
  });
}

function rememberOffline(urls, pageByUrl) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ offlineQueue: [], offlinePageUrls: {} }, (stored) => {
      const current = Array.isArray(stored.offlineQueue) ? stored.offlineQueue : [];
      const pages =
        stored.offlinePageUrls && typeof stored.offlinePageUrls === "object"
          ? { ...stored.offlinePageUrls }
          : {};
      const seen = new Set(current.map((url) => queueIdentity(url)));
      const next = current.slice();
      for (const url of urls) {
        const key = queueIdentity(url);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        next.push(url);
        const pageUrl = pageByUrl && pageByUrl[url];
        if (pageUrl) pages[key] = pageUrl;
      }
      offlineQueue = next;
      chrome.storage.local.set({ offlineQueue: next, offlinePageUrls: pages }, () => resolve(next));
    });
  });
}

function dropOffline(urls) {
  const drop = new Set(urls.map((url) => queueIdentity(url)).filter(Boolean));
  return new Promise((resolve) => {
    chrome.storage.local.get({ offlineQueue: [], offlinePageUrls: {} }, (stored) => {
      const current = Array.isArray(stored.offlineQueue) ? stored.offlineQueue : [];
      const pages =
        stored.offlinePageUrls && typeof stored.offlinePageUrls === "object"
          ? { ...stored.offlinePageUrls }
          : {};
      const next = current.filter((url) => !drop.has(queueIdentity(url)));
      for (const key of drop) delete pages[key];
      offlineQueue = next;
      chrome.storage.local.set({ offlineQueue: next, offlinePageUrls: pages }, () => resolve(next));
    });
  });
}

function heldOffline(res) {
  if (res.status === 0) return true;
  const detail = res.data && res.data.detail;
  return res.status === 409 && typeof detail === "string" && /Hide Scrape page/.test(detail);
}

async function flushOfflineQueue() {
  if (flushingQueue) return;
  await readOfflineQueue();
  if (!offlineQueue.length) return;
  flushingQueue = true;
  try {
    const stored = await chrome.storage.local.get({ offlinePageUrls: {} });
    const pages =
      stored.offlinePageUrls && typeof stored.offlinePageUrls === "object"
        ? stored.offlinePageUrls
        : {};
    const batch = offlineQueue.slice(0, 500);
    const raw = [];
    const gallery = [];
    for (const url of batch) {
      const key = queueIdentity(url);
      if (key && pages[key]) raw.push({ url, page_url: pages[key] });
      else gallery.push(url);
    }
    if (gallery.length) {
      const res = await api("/extension/enqueue", {
        method: "POST",
        body: JSON.stringify({ urls: gallery }),
      });
      if (res.ok) {
        await dropOffline(gallery);
        if (res.data && res.data.status) noteJobStarted(res.data.status);
      }
    }
    for (const item of raw) {
      const res = await api("/extension/save-file", {
        method: "POST",
        body: JSON.stringify({ url: item.url, page_url: item.page_url }),
      });
      if (res.ok) {
        await dropOffline([item.url]);
        if (res.data && res.data.status) noteJobStarted(res.data.status);
      }
    }
  } finally {
    flushingQueue = false;
  }
}

async function checkIdleForJob({ rescheduleIdle = true } = {}) {
  try {
    await flushOfflineQueue();
    if (watching) return;
    const res = await api("/scrape/status");
    if (res.ok && res.data) {
      lastJob = res.data;
      await applyTitle();
      await paintAllTabs();
    }
    if (lastJob && ScrapIconProgress.isBusy(lastJob)) {
      await startWatch();
    }
  } finally {
    if (rescheduleIdle) scheduleIdlePoll();
  }
}

function scheduleIdlePoll() {
  if (idleTimer) clearTimeout(idleTimer);
  const wait = online || offlineQueue.length ? ScrapIconProgress.BUSY_POLL_MS : ScrapIconProgress.IDLE_POLL_MS;
  idleTimer = setTimeout(async () => {
    try {
      if (!online) {
        const health = await api("/health");
        if (!health.ok) return;
      }
      await checkIdleForJob({ rescheduleIdle: false });
    } finally {
      scheduleIdlePoll();
    }
  }, wait);
}

function noteJobStarted(status) {
  if (status && typeof status === "object") lastJob = status;
  startWatch().catch((err) => console.warn("MediaViewer: watch", err));
}

function detailOf(res) {
  if (res.status === 0) return "App is not running";
  const detail = res.data && res.data.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail[0] && detail[0].msg) return detail[0].msg;
  return `HTTP ${res.status}`;
}

function iconFor(url) {
  return ScrapShared.siteFor(sites, url) ? ICONS.on : ICONS.off;
}

async function ensureSitesForUrl(url) {
  await loadConfig();
  if (url && !ScrapShared.siteFor(sites, url)) {
    await pullConfig();
  }
}

async function requireSupportedPage(pageUrl) {
  await pullConfig();
  const site = pageUrl ? ScrapShared.siteFor(sites, pageUrl) : null;
  if (!site) {
    const tab = await activeTab();
    if (tab && tab.id) await paintTab(tab.id, pageUrl || tab.url, { refresh: false });
    return { ok: false, error: SITE_UNSUPPORTED };
  }
  return { ok: true, site };
}

async function paintTab(tabId, url, options = {}) {
  if (typeof tabId !== "number") return;
  try {
    if (options.refresh !== false) {
      await ensureSitesForUrl(url);
      const key = pageKey(url);
      if (key) await refreshSavedPosts([key]);
    }
    const imageData = await iconImageData(url);
    if (imageData) await chrome.action.setIcon({ tabId, imageData });
    else await chrome.action.setIcon({ tabId, path: iconFor(url) });
  } catch {
    // Tab closed.
  }
}

async function paintAllTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    tabs = [];
  }
  await refreshSavedPosts(tabs.map((tab) => pageKey(tab.url)));
  await Promise.all(tabs.map((tab) => paintTab(tab.id, tab.url, { refresh: false })));
  try {
    const imageData = await iconImageData("");
    if (imageData) await chrome.action.setIcon({ imageData });
    else await chrome.action.setIcon({ path: ICONS.off });
  } catch {
    // No window yet.
  }
}

function applyConfig(config) {
  const raw = config && Array.isArray(config.sites) ? config.sites : [];
  sites = ScrapShared.compileSites(raw);
  scrapeEnabled = !!(config && config.scrape_enabled);
}

async function loadConfig() {
  const { config } = await chrome.storage.local.get("config");
  const stored = config && Array.isArray(config.sites) ? config.sites : [];
  // An empty saved list must not wipe sites just read from the running app.
  if (stored.length || !sites.length) applyConfig(config);
  return config || { sites: [], scrape_enabled: false };
}

// The popup asks every couple of seconds. Read the app's list then, instead of
// keeping an empty copy from before the site adapter was installed.
async function pullConfig() {
  const res = await api("/extension/sites");
  if (res.ok && res.data && Array.isArray(res.data.sites)) {
    applyConfig(res.data);
    chrome.storage.local.set({ config: res.data }).catch(() => {});
    return true;
  }
  await loadConfig();
  return false;
}

function createMenu(item) {
  try {
    chrome.contextMenus.create(item);
  } catch (err) {
    console.warn("MediaViewer: menu", item.id, err);
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function setupMenu() {
  const gen = ++menuGen;
  await loadConfig();
  await chrome.contextMenus.removeAll();
  if (gen !== menuGen) return;

  const pagePatterns = [...new Set(sites.flatMap((site) => site.pageMatches))];
  const filePatterns = [...new Set(sites.flatMap((site) => site.fileMatches))];
  if (pagePatterns.length) {
    createMenu({
      id: MENU_PAGE,
      title: "Download this page",
      contexts: ["page", "link", "image", "video"],
      documentUrlPatterns: pagePatterns,
    });
    const fileItem = {
      id: MENU_FILE,
      title: "Download this file",
      contexts: ["link", "image", "video"],
      documentUrlPatterns: pagePatterns,
    };
    if (filePatterns.length) fileItem.targetUrlPatterns = filePatterns;
    createMenu(fileItem);
  }

  const tab = await activeTab();
  const onSite = tab && ScrapShared.siteFor(sites, tab.url);
  if (!onSite) {
    createMenu({
      id: MENU_RAW,
      title: "Download this file (site not supported)",
      contexts: ["image"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    });
  }
}

function pageMatchOrigins() {
  return [...new Set(sites.flatMap((site) => site.pageMatches))];
}

function originsForSite(site) {
  return site && site.pageMatches ? [...site.pageMatches] : [];
}

async function grantedHostOrigins() {
  try {
    const all = await chrome.permissions.getAll();
    return all.origins || [];
  } catch {
    return [];
  }
}

function originGranted(origin, granted) {
  if (!origin) return false;
  if (granted.includes("*://*/*") || granted.includes("<all_urls>")) return true;
  return granted.includes(origin);
}

async function rememberedHotkeySites() {
  try {
    const stored = await chrome.storage.local.get("hotkeySites");
    const value = stored.hotkeySites;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function rememberHotkeySites(siteIds) {
  const hotkeySites = await rememberedHotkeySites();
  for (const siteId of siteIds) {
    if (siteId) hotkeySites[siteId] = true;
  }
  await chrome.storage.local.set({ hotkeySites });
}

async function loadPersistedHotkeyOrigins() {
  try {
    const stored = await chrome.storage.local.get("hotkeyOriginsGranted");
    pendingHotkeyOrigins = mergeOriginLists(pendingHotkeyOrigins, stored.hotkeyOriginsGranted || []);
  } catch {
    // Storage unavailable.
  }
}

async function hotkeysAllowedForSite(site, pageUrl) {
  if (!site) return false;
  const remembered = await rememberedHotkeySites();
  const pageOrigin = ScrapHotkeyPermission.originPatternFromUrl(pageUrl || "");
  let granted = await grantedHostOrigins();
  if (pageOrigin && !granted.includes(pageOrigin)) {
    try {
      if (await chrome.permissions.contains({ origins: [pageOrigin] })) {
        granted = mergeOriginLists(granted, [pageOrigin]);
        rememberPendingOrigins([pageOrigin]);
      }
    } catch {
      // Pattern Chrome will not store.
    }
  }
  return ScrapHotkeyPermission.hotkeysAllowed({
    pageOrigin,
    granted,
    pendingOrigins: pendingHotkeyOrigins,
    rememberedSite: !!remembered[site.id],
  });
}

function mergeOriginLists(...lists) {
  const out = [];
  for (const list of lists) {
    for (const origin of list || []) {
      if (origin && !out.includes(origin)) out.push(origin);
    }
  }
  return out;
}

async function grantedPageMatches(extraMatches) {
  const granted = await grantedHostOrigins();
  const listed = pageMatchOrigins().filter((origin) => originGranted(origin, granted));
  const fromGranted = granted.filter(
    (origin) => origin !== "*://*/*" && origin !== "<all_urls>" && !listed.includes(origin)
  );
  return mergeOriginLists(listed, fromGranted, pendingHotkeyOrigins, extraMatches);
}

async function injectHotkeysIntoTab(tabId) {
  if (typeof tabId !== "number") return false;
  try {
    // Re-inject even if an older content.js set the guard — clear it first.
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          delete window.__scrapDownloadHotkeysMain;
        } catch {
          window.__scrapDownloadHotkeysMain = false;
        }
      },
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          delete window.__scrapDownloadHotkeys;
        } catch {
          window.__scrapDownloadHotkeys = false;
        }
      },
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-main.js"], world: "MAIN" });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["hotkeySettings.js", "content.js"],
    });
    return true;
  } catch {
    return false;
  }
}

async function injectHotkeysIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (typeof tab.id !== "number" || !tab.url || !/^https?:/i.test(tab.url)) return;
      await injectHotkeysIntoTab(tab.id);
    })
  );
}

async function setupHotkeys() {
  const anyPage = ["http://*/*", "https://*/*"];
  try {
    await chrome.scripting.unregisterContentScripts({
      ids: ["scrap-hotkeys", "scrap-hotkeys-main", "scrap-hotkeys-any", "scrap-hotkeys-any-main"],
    });
  } catch {
    // Not registered yet.
  }
  try {
    // F works on every page. P still only acts on a supported site (see content.js).
    await chrome.scripting.registerContentScripts([
      {
        id: "scrap-hotkeys-any-main",
        matches: anyPage,
        js: ["content-main.js"],
        runAt: "document_start",
        allFrames: true,
        persistAcrossSessions: true,
        world: "MAIN",
      },
      {
        id: "scrap-hotkeys-any",
        matches: anyPage,
        js: ["hotkeySettings.js", "content.js"],
        runAt: "document_start",
        allFrames: true,
        persistAcrossSessions: true,
      },
    ]);
  } catch (err) {
    console.warn("MediaViewer: hotkey script", err);
  }
  // Pages already open need an explicit inject; registration only affects new loads.
  await injectHotkeysIntoOpenTabs();
}

function rememberPendingOrigins(origins) {
  pendingHotkeyOrigins = mergeOriginLists(pendingHotkeyOrigins, origins);
  chrome.storage.local.set({ hotkeyOriginsGranted: pendingHotkeyOrigins }).catch(() => {});
}

async function refreshConfig() {
  await loadPersistedHotkeyOrigins();
  await pullConfig();
  await setupMenu();
  await setupHotkeys();
  await paintAllTabs();
  await flushOfflineQueue();
}

async function pickLargestUrl(urls) {
  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  const sized = await mapPool(list, 6, async (url) => ({
    url,
    bytes: await fileByteSize(url),
  }));
  const sorted = globalThis.PageMedia
    ? globalThis.PageMedia.sortBySize(sized)
    : sized.slice().sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  return (sorted[0] && sorted[0].url) || list[0];
}

async function sendUrls(urls, pageUrl) {
  await loadConfig();
  let checkUrl = pageUrl || (Array.isArray(urls) && urls[0]) || "";
  if (!ScrapShared.siteFor(sites, checkUrl)) {
    const tab = await activeTab();
    if (tab && tab.url) checkUrl = tab.url;
  }
  if (ScrapShared.siteFor(sites, checkUrl) || urls.some((u) => ScrapShared.scrapableUrl(sites, u))) {
    const gate = await requireSupportedPage(checkUrl);
    if (!gate.ok) return { ok: false, scrapable: false, error: gate.error };
  }
  const cleaned = [];
  const seen = new Set();
  for (const url of urls) {
    const hit = ScrapShared.scrapableUrl(sites, url);
    if (!hit || seen.has(hit)) continue;
    seen.add(hit);
    cleaned.push(hit);
  }
  const page = pageKey(pageUrl || checkUrl);
  // No scrapable post URL — download the largest media file and key dots by the page.
  if (!cleaned.length) {
    const pageId = ScrapShared.pageIdentity(pageUrl || checkUrl);
    const fileCandidates = [];
    for (const url of urls || []) {
      const id = ScrapShared.pageIdentity(url);
      if (!id || (pageId && id === pageId)) continue;
      fileCandidates.push(url);
    }
    if (!fileCandidates.length) return { ok: false, scrapable: false, error: SITE_UNSUPPORTED };
    const best = await pickLargestUrl(fileCandidates);
    return saveRawFile(best, pageUrl || checkUrl);
  }
  const batch = cleaned.slice(0, 500);
  await rememberOffline(batch, page ? Object.fromEntries(batch.map((url) => [url, pageUrl || checkUrl])) : null);
  const res = await api("/extension/enqueue", {
    method: "POST",
    body: JSON.stringify({ urls: batch }),
  });
  if (res.ok && res.data) {
    await dropOffline(batch);
    if (res.data.started || res.data.appended) noteJobStarted(res.data.status);
    const out = { ok: true, scrapable: true, result: res.data };
    markQueued(queuedUrlsFrom(out, batch), pageUrl || checkUrl);
    return out;
  }
  if (heldOffline(res)) {
    markQueued(batch, pageUrl || checkUrl);
    return { ok: true, scrapable: true, offline: true, result: { queued: batch } };
  }
  return { ok: false, scrapable: true, error: detailOf(res), result: { queued: batch } };
}

// Every post or picture URL on the tab that the adapter can scrape.
async function collectPage(tabId) {
  let found = [];
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const urls = [];
        const add = (value) => {
          if (!value || typeof value !== "string") return;
          try {
            const parsed = new URL(value, location.href);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
            urls.push(parsed.href);
          } catch {
            // Ignore junk hrefs.
          }
        };
        add(location.href);
        document.querySelectorAll("a[href], img[src], video[src], video[poster], source[src]").forEach((el) => {
          add(el.href || el.src || el.poster || "");
          const srcset = el.getAttribute && el.getAttribute("srcset");
          if (srcset) {
            srcset.split(",").forEach((part) => add(part.trim().split(/\s+/)[0]));
          }
        });
        return urls;
      },
    });
    found = (injected && injected.result) || [];
  } catch {
    return { ok: false, scrapable: true, error: "Couldn't read this page" };
  }
  let pageUrl = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    pageUrl = (tab && tab.url) || "";
  } catch {
    pageUrl = "";
  }
  return sendUrls(found, pageUrl);
}

const PAGE_MEDIA_CAP = 50;

async function fileByteSize(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    const raw = res.headers.get("content-length");
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index], index);
    }
  }
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

async function listPageMedia(tabId) {
  if (typeof tabId !== "number") return [];
  let raw = [];
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["pageMedia.js"] });
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (globalThis.PageMedia ? globalThis.PageMedia.collectFromDocument() : []),
    });
    raw = (injected && injected[0] && injected[0].result) || [];
  } catch {
    return [];
  }
  const capped = raw.slice(0, PAGE_MEDIA_CAP);
  const sized = await mapPool(capped, 6, async (item) => ({
    url: item.url,
    order: item.order,
    preview: item.preview || "",
    kind: item.kind || "image",
    bytes: await fileByteSize(item.url),
  }));
  return globalThis.PageMedia.sortBySize(sized).map((item) => ({
    url: item.url,
    bytes: item.bytes,
    preview: item.preview || "",
    kind: item.kind || "image",
    label: globalThis.PageMedia.fileLabel(item.url),
    sizeText: globalThis.PageMedia.formatBytes(item.bytes),
  }));
}

async function saveRawFile(url, pageUrl) {
  if (!url) return { ok: false, error: "No picture URL" };
  let page = (pageUrl || "").trim();
  if (!page) {
    const tab = await activeTab();
    page = (tab && tab.url) || "";
  }
  const pageByUrl = page ? { [url]: page } : null;
  await rememberOffline([url], pageByUrl);
  const body = { url };
  if (page) body.page_url = page;
  const res = await api("/extension/save-file", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (res.ok && res.data) {
    await dropOffline([url]);
    if (res.data.started || res.data.appended) noteJobStarted(res.data.status);
    const out = { ok: true, result: res.data };
    markQueued(queuedUrlsFrom(out, [url]), page);
    return out;
  }
  if (heldOffline(res)) {
    markQueued([url], page);
    return { ok: true, offline: true, result: { queued: [url] } };
  }
  return { ok: false, error: detailOf(res), result: { queued: [url] } };
}

async function runScrape(message) {
  const res = await api("/extension/scrape", {
    method: "POST",
    body: JSON.stringify({
      site_id: message.siteId,
      tags: message.tags || [],
      tag_mode: message.tagMode || "and",
      exclude_tags: message.excludeTags || [],
      date_from: message.dateFrom || "",
      date_to: message.dateTo || "",
      media_type: message.mediaType || "",
      sort: message.sort || "date_desc",
      limit: Number.isFinite(message.limit) ? message.limit : 10,
    }),
  });
  if (res.ok && res.data) {
    noteJobStarted(res.data.status);
    return { ok: true, result: res.data };
  }
  return { ok: false, error: detailOf(res) };
}

async function getStatus(pageUrl) {
  const health = await api("/health");
  if (health.ok) {
    await pullConfig();
    await flushOfflineQueue();
  } else {
    await loadConfig();
  }
  await readOfflineQueue();
  const scrape = health.ok ? await api("/scrape/status") : { ok: false };
  const site = pageUrl ? ScrapShared.siteFor(sites, pageUrl) : null;
  // Ask Chrome only for this tab's host — not CDN / wildcard siblings that kept Allow stuck.
  const pageOrigin = ScrapHotkeyPermission.originPatternFromUrl(pageUrl || "");
  const hotkeyOrigins = site && pageOrigin ? [pageOrigin] : [];
  const hotkeys = site ? await hotkeysAllowedForSite(site, pageUrl) : false;
  // Popup status line follows this page's source panel (site id or Unsupported).
  const job =
    scrape.ok && scrape.data
      ? ScrapIconProgress.panelForPage(scrape.data, site ? site.id : "")
      : null;
  return {
    online: health.ok,
    scrapeEnabled,
    sites: sites.map((s) => s.name),
    job,
    queue: offlineQueue.slice(),
    viewerUrl: VIEWER_URL,
    // True only for the active tab's site — hides the Allow button after that site is granted.
    hotkeys,
    hotkeyOrigins,
    hotkeySiteId: site ? site.id : "",
    hotkeySiteName: site ? site.name : "",
  };
}

function describe(url) {
  const site = ScrapShared.siteFor(sites, url);
  const scrapable = ScrapShared.scrapableUrl(sites, url);
  return {
    onSite: !!site,
    siteId: site ? site.id : "",
    siteName: site ? site.name : "",
    scrapable: !!scrapable,
    url: scrapable || ScrapShared.cleanPageUrl(url),
  };
}

chrome.runtime.onInstalled.addListener(() => refreshConfig());
chrome.runtime.onStartup.addListener(() => refreshConfig());

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!(changeInfo.url || changeInfo.status === "complete")) return;
  await paintTab(tabId, tab.url);
  if (changeInfo.status === "complete" && tab.url && /^https?:/i.test(tab.url)) {
    await loadConfig();
    await injectHotkeysIntoTab(tabId);
  }
  const current = await activeTab();
  if (current && current.id === tabId) await setupMenu();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await paintTab(tabId, tab.url);
    await loadConfig();
    if (tab.url && /^https?:/i.test(tab.url)) await injectHotkeysIntoTab(tabId);
  } catch {
    // Tab gone.
  }
  await setupMenu();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) setupMenu();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await loadConfig();
  const page = info.pageUrl || (tab && tab.url) || "";
  if (info.menuItemId === MENU_PAGE) {
    const gate = await requireSupportedPage(page);
    if (!gate.ok) return;
    const tabId = (tab && tab.id) || info.tabId;
    if (typeof tabId === "number") await collectPage(tabId);
    return;
  }
  if (info.menuItemId === MENU_FILE) {
    const gate = await requireSupportedPage(page);
    if (!gate.ok) return;
    const target = ScrapShared.scrapableUrl(sites, info.srcUrl) || ScrapShared.scrapableUrl(sites, info.linkUrl);
    if (target) await sendUrls([target], page);
    return;
  }
  if (info.menuItemId === MENU_RAW) {
    await pullConfig();
    if (ScrapShared.siteFor(sites, page)) return;
    await saveRawFile(info.srcUrl, page);
  }
});

chrome.permissions.onAdded.addListener(async (perm) => {
  await loadConfig();
  const added = [...((perm && perm.origins) || [])];
  rememberPendingOrigins(added);
  const broad = added.includes("*://*/*") || added.includes("<all_urls>");
  const siteIds = sites
    .filter((site) => {
      if (broad) return true;
      return originsForSite(site).some((origin) => added.includes(origin))
        || added.some((origin) => ScrapShared.siteFor(sites, origin.replace(/\*\s*$/, "")) === site);
    })
    .map((site) => site.id);
  // Map https://rule34.xyz/* grants onto the site even when page_matches also lists CDN.
  for (const origin of added) {
    const hostUrl = origin.endsWith("/*") ? origin.slice(0, -1) : origin;
    const site = ScrapShared.siteFor(sites, hostUrl);
    if (site && !siteIds.includes(site.id)) siteIds.push(site.id);
  }
  await rememberHotkeySites(siteIds);
  await setupHotkeys(added);
});
chrome.permissions.onRemoved.addListener(async (perm) => {
  await loadConfig();
  const removed = new Set((perm && perm.origins) || []);
  const broad = removed.has("*://*/*") || removed.has("<all_urls>");
  const hotkeySites = await rememberedHotkeySites();
  for (const site of sites) {
    const origins = originsForSite(site);
    const touched = broad || origins.some((origin) => removed.has(origin));
    if (!touched) continue;
    let still = false;
    for (const origin of origins) {
      try {
        if (await chrome.permissions.contains({ origins: [origin] })) {
          still = true;
          break;
        }
      } catch {
        // Pattern Chrome will not store.
      }
    }
    if (!still) delete hotkeySites[site.id];
  }
  await chrome.storage.local.set({ hotkeySites });
  await setupHotkeys();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    getStatus: () => getStatus(message.url),
    describePage: async () => {
      await ensureSitesForUrl(message.url);
      return describe(message.url);
    },
    downloadFile: async () => {
      let url = message.url;
      if (!url) {
        const tab = await activeTab();
        url = (tab && tab.url) || "";
      }
      const gate = await requireSupportedPage(url);
      if (!gate.ok) return gate;
      return sendUrls([url], url);
    },
    downloadPage: async () => {
      const tab = await activeTab();
      const page = (tab && tab.url) || "";
      const gate = await requireSupportedPage(page);
      if (!gate.ok) return gate;
      return collectPage(message.tabId);
    },
    hotkeyFile: async () => {
      await loadConfig();
      const page = message.pageUrl || (sender.tab && sender.tab.url) || "";
      const tabId = sender.tab && sender.tab.id;
      async function downloadLargestOnPage() {
        if (typeof tabId !== "number") return { ok: false, error: "No tab" };
        const files = await listPageMedia(tabId);
        if (!files.length) return { ok: false, error: "No media files on this page" };
        // listPageMedia is already largest-first; key dots by the page URL.
        return saveRawFile(files[0].url, page);
      }
      if (!ScrapShared.siteFor(sites, page)) {
        await pullConfig();
        if (ScrapShared.siteFor(sites, page)) {
          const gate = await requireSupportedPage(page);
          if (!gate.ok) return gate;
          const target = ScrapShared.chooseFileHotkey(sites, page, message.hint || "");
          if (target) return sendUrls([target], page);
          return downloadLargestOnPage();
        }
        return downloadLargestOnPage();
      }
      const gate = await requireSupportedPage(page);
      if (!gate.ok) return gate;
      const target = ScrapShared.chooseFileHotkey(sites, page, message.hint || "");
      if (target) return sendUrls([target], page);
      // Supported site but no post URL (e.g. id only in the query) — save largest file.
      return downloadLargestOnPage();
    },
    hotkeyPage: async () => {
      await loadConfig();
      const page = (sender.tab && sender.tab.url) || "";
      if (!ScrapShared.siteFor(sites, page)) {
        await pullConfig();
        if (!ScrapShared.siteFor(sites, page)) return { ok: false, ignored: true };
      }
      const gate = await requireSupportedPage(page);
      if (!gate.ok) return gate;
      const one = ScrapShared.scrapableUrl(sites, page);
      if (one) return sendUrls([one], page);
      const tabId = sender.tab && sender.tab.id;
      if (typeof tabId !== "number") return { ok: false, error: "No tab" };
      return collectPage(tabId);
    },
    // Permission is requested in hotkeys.html. Pass the granted origins — getAll can lag.
    setupHotkeys: async () => {
      await loadConfig();
      if (message.siteId) await rememberHotkeySites([message.siteId]);
      const extra = Array.isArray(message.origins)
        ? message.origins
        : message.url
          ? [ScrapHotkeyPermission.originPatternFromUrl(message.url)].filter(Boolean)
          : [];
      rememberPendingOrigins(extra);
      await setupHotkeys(extra);
      // Do not inject into the Allow window — inject every matching gallery tab.
      return getStatus(message.url || "");
    },
    hotkeysGranted: async () => {
      await loadConfig();
      if (message.siteId) await rememberHotkeySites([message.siteId]);
      const extra = Array.isArray(message.origins)
        ? message.origins
        : message.url
          ? [ScrapHotkeyPermission.originPatternFromUrl(message.url)].filter(Boolean)
          : [];
      rememberPendingOrigins(extra);
      await setupHotkeys(extra);
      return {
        ok: true,
        hotkeys: ScrapHotkeyPermission.hotkeysAllowed({
          pageOrigin: ScrapHotkeyPermission.originPatternFromUrl(message.url || ""),
          granted: await grantedHostOrigins(),
          pendingOrigins: pendingHotkeyOrigins,
          rememberedSite: true,
        }),
        siteId: message.siteId || "",
      };
    },
    saveRawFile: async () => {
      let pageUrl = message.pageUrl || "";
      if (!pageUrl) {
        const tab = await activeTab();
        pageUrl = (tab && tab.url) || "";
      }
      return saveRawFile(message.url, pageUrl);
    },
    listPageMedia: async () => {
      const tabId = typeof message.tabId === "number" ? message.tabId : sender.tab && sender.tab.id;
      return { ok: true, files: await listPageMedia(tabId) };
    },
    runScrape: () => runScrape(message),
    refresh: async () => {
      await refreshConfig();
      const tab = await activeTab();
      return getStatus(tab && tab.url);
    },
  };
  const handler = handlers[message && message.type];
  if (!handler) return false;
  Promise.resolve(handler())
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_IDLE) checkIdleForJob().catch(() => {});
  if (alarm.name === ALARM_SITES) {
    pullConfig()
      .then(async (ok) => {
        if (ok) {
          await setupMenu();
          await setupHotkeys();
        }
      })
      .catch(() => {});
  }
});

try {
  chrome.alarms.create(ALARM_IDLE, { periodInMinutes: 1 });
  chrome.alarms.create(ALARM_SITES, { periodInMinutes: 5 });
} catch {
  // alarms permission missing on a stale load.
}

scheduleIdlePoll();
refreshConfig();
checkIdleForJob().catch(() => {});
