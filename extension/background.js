importScripts("shared.js");

const API = "http://127.0.0.1:8000/api";
const VIEWER_URL = "http://127.0.0.1:8000/";
const MENU_PAGE = "scrap-download-page";
const MENU_FILE = "scrap-download-file";
const MENU_RAW = "scrap-download-raw";
const ICONS = {
  on: { 16: "icons/green16.png", 32: "icons/green32.png", 48: "icons/green48.png" },
  off: { 16: "icons/red16.png", 32: "icons/red32.png", 48: "icons/red48.png" },
};

let sites = [];
let scrapeEnabled = false;
let online = false;
let menuGen = 0;

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

function setOnline(value) {
  if (online === value) return;
  online = value;
  chrome.action.setBadgeBackgroundColor({ color: "#333333" });
  chrome.action.setBadgeText({ text: online ? "" : "off" });
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

async function paintTab(tabId, url) {
  if (typeof tabId !== "number") return;
  try {
    await chrome.action.setIcon({ tabId, path: iconFor(url) });
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
  await Promise.all(tabs.map((tab) => paintTab(tab.id, tab.url)));
  try {
    await chrome.action.setIcon({ path: ICONS.off });
  } catch {
    // No window yet.
  }
}

async function loadConfig() {
  const { config } = await chrome.storage.local.get("config");
  const raw = config?.sites || [];
  sites = ScrapShared.compileSites(raw);
  scrapeEnabled = !!config?.scrape_enabled;
  return config || { sites: [], scrape_enabled: false };
}

function createMenu(item) {
  try {
    chrome.contextMenus.create(item);
  } catch (err) {
    console.warn("Scrap Download: menu", item.id, err);
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

async function refreshConfig() {
  const res = await api("/extension/sites");
  if (res.ok && res.data) {
    await chrome.storage.local.set({ config: res.data });
  }
  await loadConfig();
  await setupMenu();
  await paintAllTabs();
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
  const res = await api("/extension/enqueue", {
    method: "POST",
    body: JSON.stringify({ urls: cleaned.slice(0, 500) }),
  });
  if (res.ok && res.data) return { ok: true, scrapable: true, result: res.data };
  return { ok: false, scrapable: true, error: detailOf(res) };
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
  const res = await api("/extension/save-file", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
  if (res.ok && res.data) return { ok: true, result: res.data };
  return { ok: false, error: detailOf(res) };
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
  if (res.ok && res.data) return { ok: true, result: res.data };
  return { ok: false, error: detailOf(res) };
}

async function getStatus() {
  await loadConfig();
  const health = await api("/health");
  const scrape = health.ok ? await api("/scrape/status") : { ok: false };
  return {
    online: health.ok,
    scrapeEnabled,
    sites: sites.map((site) => site.name),
    job: scrape.ok ? scrape.data : null,
    viewerUrl: VIEWER_URL,
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
  const current = await activeTab();
  if (current && current.id === tabId) await setupMenu();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await paintTab(tabId, tab.url);
  } catch {
    // Tab gone.
  }
  await setupMenu();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) setupMenu();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    getStatus: () => getStatus(),
    describePage: async () => {
      await loadConfig();
      return describe(message.url);
    },
    downloadFile: () => sendUrls([message.url]),
    downloadPage: () => collectPage(message.tabId),
    saveRawFile: () => saveRawFile(message.url),
    runScrape: () => runScrape(message),
    refresh: async () => {
      await refreshConfig();
      return getStatus();
    },
  };
  const handler = handlers[message && message.type];
  if (!handler) return false;
  Promise.resolve(handler())
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err) }));
  return true;
});

refreshConfig();
