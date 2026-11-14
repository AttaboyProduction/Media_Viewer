importScripts("shared.js");

const API = "http://127.0.0.1:8000/api";
const VIEWER_URL = "http://127.0.0.1:8000/";
const MENU_ID = "scrap-download-send";
const ICONS = {
  on: { 16: "icons/green16.png", 32: "icons/green32.png", 48: "icons/green48.png" },
  off: { 16: "icons/red16.png", 32: "icons/red32.png", 48: "icons/red48.png" },
};

let rules = [];
let siteNames = [];
let scrapeEnabled = false;
let online = false;

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

function iconFor(url) {
  return ScrapShared.scrapableUrl(rules, url) ? ICONS.on : ICONS.off;
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
  const sites = config?.sites || [];
  rules = ScrapShared.compileSites(sites);
  siteNames = sites.map((site) => site.name);
  scrapeEnabled = !!config?.scrape_enabled;
  return config || { sites: [], scrape_enabled: false };
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

async function setupMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Download this page",
    contexts: ["page", "link", "image", "video"],
    documentUrlPatterns: ["http://*/*", "https://*/*"],
  });
}

async function sendPage(url) {
  await loadConfig();
  const cleaned = ScrapShared.scrapableUrl(rules, url);
  if (!cleaned) return { ok: false, scrapable: false };
  const res = await api("/extension/enqueue", {
    method: "POST",
    body: JSON.stringify({ urls: [cleaned] }),
  });
  if (res.ok && res.data) return { ok: true, scrapable: true, url: cleaned, result: res.data };
  const detail = (res.data && res.data.detail) || (res.status === 0 ? "App is not running" : `HTTP ${res.status}`);
  return { ok: false, scrapable: true, url: cleaned, error: detail };
}

async function getStatus() {
  await loadConfig();
  const health = await api("/health");
  const scrape = health.ok ? await api("/scrape/status") : { ok: false };
  return {
    online: health.ok,
    scrapeEnabled,
    sites: siteNames,
    job: scrape.ok ? scrape.data : null,
    viewerUrl: VIEWER_URL,
  };
}

chrome.runtime.onInstalled.addListener(() => refreshConfig());
chrome.runtime.onStartup.addListener(() => refreshConfig());

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") paintTab(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    paintTab(tabId, tab.url);
  } catch {
    // Tab gone.
  }
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  await sendPage(info.pageUrl);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    getStatus: () => getStatus(),
    describePage: async () => {
      await loadConfig();
      const cleaned = ScrapShared.scrapableUrl(rules, message.url);
      return { scrapable: !!cleaned, url: cleaned || ScrapShared.cleanPageUrl(message.url) };
    },
    downloadPage: () => sendPage(message.url),
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
