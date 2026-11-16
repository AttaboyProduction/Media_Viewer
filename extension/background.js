importScripts("shared.js", "hotkeyPermission.js", "iconProgress.js");

const API = "http://127.0.0.1:8000/api";
const VIEWER_URL = "http://127.0.0.1:8000/";
const MENU_PAGE = "scrap-download-page";
const MENU_FILE = "scrap-download-file";
const MENU_RAW = "scrap-download-raw";
const ALARM_IDLE = "scrap-idle-watch";
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
    setOnline(true);
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
    return;
  }
  online = value;
  applyChromeBadge();
}

async function loadBitmap(path) {
  if (bitmapCache.has(path)) return bitmapCache.get(path);
  const response = await fetch(chrome.runtime.getURL(path));
  const bitmap = await createImageBitmap(await response.blob());
  bitmapCache.set(path, bitmap);
  return bitmap;
}

function libraryKey(url) {
  return ScrapShared.scrapableUrl(sites, url);
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

function drawIconOverlays(bitmap, { ratio, busy, saved }) {
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
  if (saved) fillDot(ctx, ScrapIconProgress.savedDotGeometry(size), "#6aa8ff", size);
  if (busy) fillDot(ctx, ScrapIconProgress.busyDotGeometry(size), "#c62828", size);
  return ctx.getImageData(0, 0, size, size);
}

async function refreshSavedPosts(urls) {
  const unique = [...new Set(urls.filter(Boolean))];
  if (!unique.length) return;
  const res = await api("/extension/saved", {
    method: "POST",
    body: JSON.stringify({ urls: unique.slice(0, 500) }),
  });
  if (!res.ok || !res.data || !Array.isArray(res.data.saved)) return;
  const saved = new Set(res.data.saved);
  for (const url of unique) {
    if (saved.has(url)) savedPostUrls.add(url);
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

function markQueued(urls) {
  let changed = false;
  for (const url of urls) {
    const key = libraryKey(url) || url;
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

async function settleQueuedPosts() {
  await loadQueuedPosts();
  if (queuedPostUrls.size) await refreshSavedPosts([...queuedPostUrls]);
  await readOfflineQueue();
  const waiting = new Set(offlineQueue.map((url) => libraryKey(url) || url));
  let changed = false;
  for (const url of [...queuedPostUrls]) {
    if (savedPostUrls.has(url) || !waiting.has(url)) {
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
  const key = libraryKey(url);
  const saved = !!(key && (savedPostUrls.has(key) || queuedPostUrls.has(key)));
  if (!busy && ratio == null && !saved) return null;
  const paths = iconFor(url);
  const imageData = {};
  for (const size of [16, 32, 48]) {
    const path = paths[size] || ICONS.off[size];
    imageData[size] = drawIconOverlays(await loadBitmap(path), { ratio, busy, saved });
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

function rememberOffline(urls) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ offlineQueue: [] }, (stored) => {
      const current = Array.isArray(stored.offlineQueue) ? stored.offlineQueue : [];
      const seen = new Set(current.map((url) => queueIdentity(url)));
      const next = current.slice();
      for (const url of urls) {
        const key = queueIdentity(url);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        next.push(url);
      }
      offlineQueue = next;
      chrome.storage.local.set({ offlineQueue: next }, () => resolve(next));
    });
  });
}

function dropOffline(urls) {
  const drop = new Set(urls.map((url) => queueIdentity(url)).filter(Boolean));
  return new Promise((resolve) => {
    chrome.storage.local.get({ offlineQueue: [] }, (stored) => {
      const current = Array.isArray(stored.offlineQueue) ? stored.offlineQueue : [];
      const next = current.filter((url) => !drop.has(queueIdentity(url)));
      offlineQueue = next;
      chrome.storage.local.set({ offlineQueue: next }, () => resolve(next));
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
    const batch = offlineQueue.slice(0, 500);
    const res = await api("/extension/enqueue", {
      method: "POST",
      body: JSON.stringify({ urls: batch }),
    });
    if (res.ok) {
      await dropOffline(batch);
      if (res.data && res.data.status) noteJobStarted(res.data.status);
    }
  } finally {
    flushingQueue = false;
  }
}

async function checkIdleForJob() {
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
}

function scheduleIdlePoll() {
  if (idleTimer) clearTimeout(idleTimer);
  const wait = online || offlineQueue.length ? ScrapIconProgress.BUSY_POLL_MS : ScrapIconProgress.IDLE_POLL_MS;
  idleTimer = setTimeout(async () => {
    try {
      await checkIdleForJob();
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

async function paintTab(tabId, url, options = {}) {
  if (typeof tabId !== "number") return;
  try {
    if (options.refresh !== false) {
      const key = libraryKey(url);
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
  await refreshSavedPosts(tabs.map((tab) => libraryKey(tab.url)));
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
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch {
    return false;
  }
}

async function injectHotkeysIntoOpenTabs(matches) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  const rules = matches.map((pattern) => ScrapShared.matchPatternToRegExp(pattern)).filter(Boolean);
  await Promise.all(
    tabs.map(async (tab) => {
      if (typeof tab.id !== "number" || !tab.url) return;
      const cleaned = ScrapShared.cleanPageUrl(tab.url) || tab.url;
      const byPattern = rules.some((re) => re.test(cleaned) || re.test(tab.url));
      if (!byPattern && !ScrapShared.siteFor(sites, tab.url)) return;
      await injectHotkeysIntoTab(tab.id);
    })
  );
}

async function setupHotkeys() {
  const matches = pageMatchOrigins();
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ["scrap-hotkeys", "scrap-hotkeys-main"] });
  } catch {
    // Not registered yet.
  }
  if (!matches.length) return;
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: "scrap-hotkeys-main",
        matches,
        js: ["content-main.js"],
        runAt: "document_start",
        allFrames: true,
        persistAcrossSessions: true,
        world: "MAIN",
      },
      {
        id: "scrap-hotkeys",
        matches,
        js: ["content.js"],
        runAt: "document_start",
        allFrames: true,
        persistAcrossSessions: true,
      },
    ]);
  } catch (err) {
    console.warn("MediaViewer: hotkey script", err);
  }
  // Pages already open need an explicit inject; registration only affects new loads.
  await injectHotkeysIntoOpenTabs(matches);
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

async function sendUrls(urls) {
  await loadConfig();
  const cleaned = [];
  const seen = new Set();
  for (const url of urls) {
    const hit = ScrapShared.scrapableUrl(sites, url);
    if (!hit || seen.has(hit)) continue;
    seen.add(hit);
    cleaned.push(hit);
  }
  if (!cleaned.length) return { ok: false, scrapable: false, error: "No supported posts there" };
  const batch = cleaned.slice(0, 500);
  await rememberOffline(batch);
  const res = await api("/extension/enqueue", {
    method: "POST",
    body: JSON.stringify({ urls: batch }),
  });
  if (res.ok && res.data) {
    await dropOffline(batch);
    noteJobStarted(res.data.status);
    const out = { ok: true, scrapable: true, result: res.data };
    markQueued(queuedUrlsFrom(out, batch));
    return out;
  }
  if (heldOffline(res)) {
    markQueued(batch);
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
  return sendUrls(found);
}

async function saveRawFile(url) {
  if (!url) return { ok: false, error: "No picture URL" };
  await rememberOffline([url]);
  const res = await api("/extension/save-file", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
  if (res.ok && res.data) {
    await dropOffline([url]);
    noteJobStarted(res.data.status);
    const out = { ok: true, result: res.data };
    markQueued(queuedUrlsFrom(out, [url]));
    return out;
  }
  if (heldOffline(res)) {
    markQueued([url]);
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
  return {
    online: health.ok,
    scrapeEnabled,
    sites: sites.map((s) => s.name),
    job: scrape.ok ? scrape.data : null,
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
  if (changeInfo.status === "complete" && tab.url) {
    await loadConfig();
    const site = ScrapShared.siteFor(sites, tab.url);
    if (site) await injectHotkeysIntoTab(tabId);
  }
  const current = await activeTab();
  if (current && current.id === tabId) await setupMenu();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await paintTab(tabId, tab.url);
    await loadConfig();
    const site = tab.url ? ScrapShared.siteFor(sites, tab.url) : null;
    if (site) await injectHotkeysIntoTab(tabId);
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
  if (info.menuItemId === MENU_PAGE) {
    const tabId = (tab && tab.id) || info.tabId;
    if (typeof tabId === "number") await collectPage(tabId);
    return;
  }
  if (info.menuItemId === MENU_FILE) {
    const target = ScrapShared.scrapableUrl(sites, info.srcUrl) || ScrapShared.scrapableUrl(sites, info.linkUrl);
    if (target) await sendUrls([target]);
    return;
  }
  if (info.menuItemId === MENU_RAW) {
    const page = info.pageUrl || (tab && tab.url) || "";
    if (ScrapShared.siteFor(sites, page)) return;
    await saveRawFile(info.srcUrl);
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
      await pullConfig();
      return describe(message.url);
    },
    downloadFile: async () => {
      let url = message.url;
      if (!url) {
        const tab = await activeTab();
        url = (tab && tab.url) || "";
      }
      return sendUrls([url]);
    },
    downloadPage: () => collectPage(message.tabId),
    hotkeyFile: async () => {
      await loadConfig();
      const page = message.pageUrl || (sender.tab && sender.tab.url) || "";
      const target = ScrapShared.chooseFileHotkey(sites, page, message.hint || "");
      return sendUrls(target ? [target] : []);
    },
    hotkeyPage: async () => {
      await loadConfig();
      const page = (sender.tab && sender.tab.url) || "";
      const one = ScrapShared.scrapableUrl(sites, page);
      if (one) return sendUrls([one]);
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
    saveRawFile: () => saveRawFile(message.url),
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
});

try {
  chrome.alarms.create(ALARM_IDLE, { periodInMinutes: 1 });
} catch {
  // alarms permission missing on a stale load.
}

scheduleIdlePoll();
refreshConfig();
checkIdleForJob().catch(() => {});
