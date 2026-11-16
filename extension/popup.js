const $ = (id) => document.getElementById(id);
let current = null;
let page = null;

function send(message) {
  const payload = typeof message === "string" ? { type: message } : message;
  return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
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
  if (!status || !Array.isArray(status.sites)) return;
  current = status;

  $("appDot").className = `dot ${status.online ? (status.scrapeEnabled ? "ok" : "warn") : ""}`;
  $("appText").textContent = !status.online
    ? "App is not running — start MediaViewer."
    : status.scrapeEnabled
      ? "App is running."
      : "Scraping is off (Settings → Hide Scrape page).";

  $("sitesDot").className = `dot ${status.sites.length ? "ok" : ""}`;
  $("sitesText").textContent = status.sites.length
    ? `Sites: ${status.sites.join(", ")}`
    : "No supported sites — install a site adapter with an extension block.";

  renderQueue(status.queue || []);
  const job = status.job;
  if (job && (job.running || job.total > 0)) {
    const fraction = job.total > 0 ? `${job.processed}/${job.total}` : `${job.processed}`;
    const counts = ScrapIconProgress.outcomeCounts(job);
    const cancelled = counts.cancelled > 0 ? ` · cancelled ${counts.cancelled}` : "";
    $("jobText").textContent =
      `Scrape: ${fraction} · downloaded ${job.downloaded} · skipped ${counts.skipped}${cancelled}`;
  } else {
    $("jobText").textContent = job && job.message ? `Last scrape: ${job.message}` : "No scrape running.";
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

function renderPage() {
  const actions = $("actions");
  const filters = $("filters");
  const text = $("pageText");
  const hotkey = $("hotkeyText");
  const ready = current && current.online && current.scrapeEnabled;
  const onSite = !!(page && page.onSite);
  actions.hidden = !onSite;
  filters.hidden = true;
  hotkey.textContent = onSite ? "Shortcut keys: F = one file, P = whole page" : "";
  $("downloadFile").hidden = !(onSite && page.scrapable);
  $("downloadPage").hidden = !(onSite && !page.scrapable);
  if (!onSite) {
    text.textContent =
      "This site isn't supported. Right-click a picture and choose Download this file (site not supported).";
    return;
  }
  if (!ready) {
    const offline = !(current && current.online);
    text.textContent =
      holdNotice ||
      (offline
        ? "The app is not running. Download still adds this page to the queue."
        : "Scraping is off in the app. Download still adds this page to the queue.");
    return;
  }
  if (page.scrapable) {
    text.textContent = holdNotice || page.url;
    return;
  }
  filters.hidden = false;
  text.textContent = holdNotice || (page.siteName ? `${page.siteName} — filters apply to this site.` : "Filters apply to this site.");
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

$("refresh").addEventListener("click", async () => {
  const tab = await activeTab();
  page = await send({ type: "describePage", url: (tab && tab.url) || "" });
  render(await send("refresh"));
});
$("viewer").addEventListener("click", () =>
  chrome.tabs.create({ url: (current && current.viewerUrl) || "http://127.0.0.1:8000/" })
);

async function refreshAll() {
  const tab = await activeTab();
  const url = (tab && tab.url) || "";
  page = await send({ type: "describePage", url });
  render(await send({ type: "getStatus", url }));
}

refreshAll();
setInterval(refreshAll, 2000);
