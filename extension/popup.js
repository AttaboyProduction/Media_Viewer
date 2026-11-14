const $ = (id) => document.getElementById(id);
let current = null;
let page = null;

function send(message) {
  const payload = typeof message === "string" ? { type: message } : message;
  return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
}

async function activeTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return (tab && tab.url) || "";
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
  if (job && job.running) {
    const total = job.total ? ` / ${job.total}` : "";
    $("jobText").textContent = `Scrape queue: ${job.processed}${total} processed, ${job.downloaded} downloaded, ${job.skipped} skipped.`;
  } else {
    $("jobText").textContent = job && job.message ? `Last scrape: ${job.message}` : "No scrape running.";
  }
  renderPage();
}

function renderPage() {
  const button = $("download");
  const text = $("pageText");
  if (!current || !current.online || !current.scrapeEnabled) {
    button.disabled = true;
    button.textContent = "Download media file";
    text.textContent = current && current.online ? "Scraping is off in the app." : "Start the app to download.";
    return;
  }
  if (!page || !page.scrapable) {
    button.disabled = true;
    button.textContent = "Download media file";
    text.textContent = "This page isn't a URL the app can scrape.";
    return;
  }
  button.disabled = false;
  button.textContent = "Download media file";
  text.textContent = page.url;
}

$("download").addEventListener("click", async () => {
  const url = await activeTabUrl();
  $("download").disabled = true;
  const result = await send({ type: "downloadPage", url });
  if (result && result.ok && result.result) {
    const queued = result.result.queued || [];
    $("pageText").textContent = queued.length
      ? `Added to the scrape queue: ${queued[0]}`
      : "Already in the scrape queue.";
  } else if (result && result.error) {
    $("pageText").textContent = result.error;
  }
  render(await send("getStatus"));
});

$("refresh").addEventListener("click", async () => render(await send("refresh")));
$("viewer").addEventListener("click", () =>
  chrome.tabs.create({ url: (current && current.viewerUrl) || "http://127.0.0.1:8000/" })
);

async function refreshAll() {
  page = await send({ type: "describePage", url: await activeTabUrl() });
  render(await send("getStatus"));
}

refreshAll();
setInterval(refreshAll, 2000);
