const $ = (id) => document.getElementById(id);
let current = null;
let page = null;
let listedUrl = "";
let hotkeys = ScrapHotkeySettings.normalizeHotkeys(null);

const FLOPPY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
  '<path fill="currentColor" d="M4 4a2 2 0 0 1 2-2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4zm2 0v16h12V8h-4V4H6zm2 10h8v4H8v-4z"/>' +
  "</svg>";

function hotkeyLabels() {
  return {
    file: ScrapHotkeySettings.labelForAction(hotkeys.file),
    page: ScrapHotkeySettings.labelForAction(hotkeys.page),
  };
}

ScrapHotkeySettings.loadHotkeys().then((loaded) => {
  hotkeys = loaded;
  if (current) renderPage();
});
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.hotkeys) return;
    hotkeys = ScrapHotkeySettings.normalizeHotkeys(changes.hotkeys.newValue);
    if (current) renderPage();
  });
} catch {
  // Ignore.
}

function send(message) {
  const payload = typeof message === "string" ? { type: message } : message;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 5000);
    try {
      chrome.runtime.sendMessage(payload, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

// date/time inputs show the OS locale; the value is still yyyy-MM-dd / HH:mm.
function localDateTime(dateId, timeId) {
  const date = $(dateId).value;
  if (!date) return "";
  const time = $(timeId).value;
  return time ? `${date}T${time}` : date;
}

let holdNotice = "";
let holdTimer = 0;

function setHold(text) {
  holdNotice = text;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    holdNotice = "";
  }, 8000);
}

function render(status) {
  if (!status || !Array.isArray(status.sites)) {
    // Keep the last good snapshot. The placeholder must not stay up forever.
    if (!current) {
      $("appText").textContent = "Couldn't reach the app. Is MediaViewer running?";
    }
    return;
  }
  current = status;

  $("appDot").className = `dot ${status.online ? (status.scrapeEnabled ? "ok" : "warn") : ""}`;
  $("appText").textContent = !status.online
    ? "App is not running — start MediaViewer."
    : status.scrapeEnabled
      ? "App is running."
      : "Scraping is off (Settings → Hide Scrape page).";

  const onSite = !!(page && page.onSite);
  $("sitesDot").className = `dot ${onSite ? "ok" : "warn"}`;
  $("sitesText").textContent = onSite ? "Site supported" : "Site not supported";

  renderQueue(status.queue || []);
  const job = status.job;
  const label = job && job.label ? String(job.label) : "";
  const prefix = label ? `${label}: ` : "Scrape: ";
  if (job && (job.running || job.total > 0 || (job.queue_urls && job.queue_urls.length))) {
    const fraction = job.total > 0 ? `${job.processed}/${job.total}` : `${job.processed || 0}`;
    const counts = ScrapIconProgress.outcomeCounts(job);
    const errors = counts.errors > 0 ? ` · errors ${counts.errors}` : "";
    const cancelled = counts.cancelled > 0 ? ` · cancelled ${counts.cancelled}` : "";
    const queued =
      job.queue_urls && job.queue_urls.length ? ` · queue ${job.queue_urls.length}` : "";
    $("jobText").textContent =
      `${prefix}${fraction} · downloaded ${job.downloaded || 0} · skipped ${counts.skipped}${errors}${cancelled}${queued}`;
  } else if (job && job.message) {
    $("jobText").textContent = `${prefix}${job.message}`;
  } else {
    $("jobText").textContent = "No scrape running.";
  }
  renderPage();
}

function renderQueue(urls) {
  const box = $("queueBox");
  const list = $("queueList");
  if (!urls.length) {
    box.hidden = true;
    list.replaceChildren();
    return;
  }
  box.hidden = false;
  $("queueSummary").textContent = `Queue (${urls.length})`;
  list.replaceChildren();
  for (const url of urls) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = url;
    li.append(link);
    list.append(li);
  }
}

function renderMediaStatus() {
  const el = $("mediaStatus");
  const ms = current && current.mediaStatus;
  const show = !!(page && page.onSite && page.scrapable && ms && ms.text);
  el.hidden = !show;
  el.textContent = show ? ms.text : "";
}

function renderPage() {
  const actions = $("actions");
  const filters = $("filters");
  const text = $("pageText");
  const hotkey = $("hotkeyText");
  const ready = current && current.online && current.scrapeEnabled;
  const onSite = !!(page && page.onSite);
  actions.hidden = !onSite;
  filters.hidden = true;
  document.body.classList.remove("gallery-filters");
  const keys = hotkeyLabels();
  hotkey.textContent = onSite
    ? `Shortcut keys: ${keys.file} = one file, ${keys.page} = whole page`
    : "";
  $("downloadFile").hidden = !(onSite && page.scrapable);
  $("downloadPage").hidden = !(onSite && !page.scrapable);
  if (!onSite) {
    text.textContent = holdNotice || `This site isn't supported. ${keys.file} saves the largest file.`;
    hotkey.textContent = `Shortcut key: ${keys.file} = largest file`;
    $("pageFiles").hidden = false;
    renderMediaStatus();
    return;
  }
  $("pageFiles").hidden = true;
  if (!ready) {
    const offline = !(current && current.online);
    text.textContent =
      holdNotice ||
      (offline
        ? "The app is not running. Download still adds this page to the queue."
        : "Scraping is off in the app. Download still adds this page to the queue.");
    renderMediaStatus();
    return;
  }
  if (page.scrapable) {
    text.textContent = holdNotice || page.url;
    renderMediaStatus();
    return;
  }
  filters.hidden = false;
  document.body.classList.add("gallery-filters");
  text.textContent = holdNotice || (page.siteName ? `${page.siteName} — filters apply to this site.` : "Filters apply to this site.");
  renderMediaStatus();
}

async function note(result) {
  if (result && result.ok && result.offline) {
    const n = (result.result && result.result.queued && result.result.queued.length) || 0;
    setHold(
      n
        ? `Queued ${n}. They will download when MediaViewer is running.`
        : "Queued. It will download when MediaViewer is running."
    );
  } else if (result && result.ok && result.result) {
    const queued = result.result.queued || [];
    const saved = result.result.already_saved || [];
    setHold(
      !queued.length && saved.length
        ? "Already in your library."
        : queued.length
          ? `Added ${queued.length} to the scrape queue.`
          : result.result.appended
            ? "Already in the scrape queue."
            : "Scrape started."
    );
  } else if (result && result.error) {
    setHold(result.error);
  } else if (!result) {
    setHold("Extension didn't answer. Reload it from the extensions page.");
  }
  const tab = await activeTab();
  render(await send({ type: "getStatus", url: (tab && tab.url) || "" }));
  if (holdNotice) $("pageText").textContent = holdNotice;
}

$("downloadFile").addEventListener("click", async () => {
  const tab = await activeTab();
  $("downloadFile").disabled = true;
  await note(await send({ type: "downloadFile", url: (tab && tab.url) || "" }));
  $("downloadFile").disabled = false;
});

$("downloadPage").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab) return;
  $("downloadPage").disabled = true;
  await note(await send({ type: "downloadPage", tabId: tab.id }));
  $("downloadPage").disabled = false;
});

$("runFilters").addEventListener("click", async () => {
  if (!page || !page.siteId) return;
  $("runFilters").disabled = true;
  const limit = Number($("limit").value);
  await note(
    await send({
      type: "runScrape",
      siteId: page.siteId,
      tags: splitList($("tags").value),
      tagMode: $("tagMode").value,
      excludeTags: splitList($("exclude").value),
      dateFrom: localDateTime("dateFrom", "timeFrom"),
      dateTo: localDateTime("dateTo", "timeTo"),
      mediaType: $("mediaType").value,
      sort: $("sort").value,
      limit: Number.isFinite(limit) && limit >= 0 ? limit : 10,
    })
  );
  $("runFilters").disabled = false;
});

$("syncSites").addEventListener("click", async () => {
  $("syncSites").disabled = true;
  listedUrl = "";
  await send("refresh");
  await refreshAll();
  $("syncSites").disabled = false;
});
$("extensionSettings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
$("viewer").addEventListener("click", () =>
  chrome.tabs.create({ url: (current && current.viewerUrl) || "http://127.0.0.1:8000/" })
);

function renderPageFiles(files) {
  const list = $("pageFilesList");
  const rows = Array.isArray(files) ? files : [];
  $("pageFilesSummary").textContent = `Files on this page (${rows.length})`;
  list.replaceChildren();
  for (const item of rows) {
    const li = document.createElement("li");
    const thumb = document.createElement("span");
    thumb.className = "file-thumb";
    if (item.preview) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = item.preview;
      thumb.append(img);
    } else if (item.kind === "video") {
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "metadata";
      video.playsInline = true;
      video.src = `${item.url}#t=0.1`;
      thumb.append(video);
    }
    const label = document.createElement("span");
    label.className = "file-label";
    label.title = item.url;
    label.textContent = item.sizeText ? `${item.label} · ${item.sizeText}` : item.label;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "save-file";
    button.title = "Download";
    button.setAttribute("aria-label", `Download ${item.label}`);
    button.innerHTML = FLOPPY_SVG;
    button.addEventListener("click", async () => {
      button.disabled = true;
      const tab = await activeTab();
      await note(
        await send({
          type: "saveRawFile",
          url: item.url,
          pageUrl: (tab && tab.url) || "",
        })
      );
      button.disabled = false;
    });
    li.append(thumb, label, button);
    list.append(li);
  }
}

async function loadPageFiles(tab) {
  if (!tab || typeof tab.id !== "number") return;
  $("pageFilesSummary").textContent = "Files on this page";
  const result = await send({ type: "listPageMedia", tabId: tab.id });
  if (!result || result.error) {
    $("pageFilesSummary").textContent = "Files on this page (0)";
    $("pageFilesList").replaceChildren();
    return;
  }
  renderPageFiles(result.files || []);
}

let refreshing = false;

async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  try {
    const tab = await activeTab();
    const url = (tab && tab.url) || "";
    page = await send({ type: "describePage", url });
    render(await send({ type: "getStatus", url }));
    if (!(page && page.onSite) && tab && url && url !== listedUrl) {
      listedUrl = url;
      await loadPageFiles(tab);
    }
    if (page && page.onSite) listedUrl = "";
  } finally {
    refreshing = false;
  }
}

refreshAll();
setInterval(refreshAll, 2000);
