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

function render(status) {
  if (!status) return;
  current = status;

  $("appDot").className = `dot ${status.online ? (status.scrapeEnabled ? "ok" : "warn") : ""}`;
  $("appText").textContent = !status.online
    ? "App is not running — start Scrap Download."
    : status.scrapeEnabled
      ? "App is running."
      : "Scraping is off (Settings → Hide Scrape page).";

  $("sitesDot").className = `dot ${status.sites.length ? "ok" : ""}`;
  $("sitesText").textContent = status.sites.length
    ? `Sites: ${status.sites.join(", ")}`
    : "No supported sites — install a site adapter with an extension block.";

  const job = status.job;
  if (job && (job.running || job.total > 0)) {
    const fraction = job.total > 0 ? `${job.processed}/${job.total}` : `${job.processed}`;
    $("jobText").textContent = `Scrape: ${fraction} · downloaded ${job.downloaded} · skipped ${job.skipped}`;
  } else {
    $("jobText").textContent = job && job.message ? `Last scrape: ${job.message}` : "No scrape running.";
  }
  renderPage();
}

function renderPage() {
  const actions = $("actions");
  const filters = $("filters");
  const text = $("pageText");
  const ready = current && current.online && current.scrapeEnabled;
  actions.hidden = true;
  filters.hidden = true;
  $("downloadFile").hidden = true;
  $("downloadPage").hidden = true;
  if (!ready) {
    text.textContent = current && current.online ? "Scraping is off in the app." : "Start the app to download.";
    return;
  }
  if (!page || !page.onSite) {
    text.textContent = "This site isn't supported. Right-click a picture and choose Download this file (site not supported).";
    return;
  }
  actions.hidden = false;
  if (page.scrapable) {
    $("downloadFile").hidden = false;
    text.textContent = page.url;
    return;
  }
  $("downloadPage").hidden = false;
  filters.hidden = false;
  text.textContent = page.siteName ? `${page.siteName} — filters apply to this site.` : "Filters apply to this site.";
}

async function note(result) {
  if (result && result.ok && result.result) {
    const queued = result.result.queued || [];
    $("pageText").textContent = queued.length
      ? `Added ${queued.length} to the scrape queue.`
      : result.result.appended
        ? "Already in the scrape queue."
        : "Scrape started.";
  } else if (result && result.error) {
    $("pageText").textContent = result.error;
  }
  render(await send("getStatus"));
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
      dateFrom: $("dateFrom").value,
      dateTo: $("dateTo").value,
      mediaType: $("mediaType").value,
      sort: $("sort").value,
      limit: Number.isFinite(limit) && limit >= 0 ? limit : 10,
    })
  );
  $("runFilters").disabled = false;
});

$("refresh").addEventListener("click", async () => render(await send("refresh")));
$("viewer").addEventListener("click", () =>
  chrome.tabs.create({ url: (current && current.viewerUrl) || "http://127.0.0.1:8000/" })
);

async function refreshAll() {
  const tab = await activeTab();
  page = await send({ type: "describePage", url: (tab && tab.url) || "" });
  render(await send("getStatus"));
}

refreshAll();
setInterval(refreshAll, 2000);
