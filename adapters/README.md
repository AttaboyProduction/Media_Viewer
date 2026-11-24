# Site adapters

Each package is a folder with `adapter.json`. Core ships **only** the `example/` package in git (marked `"template": true` so it does not appear in the app until you copy and customize it).

1. Copy `example/` to a new folder name and remove `"template": true` (or set it to `false`).
2. Change `id`, site `name` / URLs / `media_cdn_host`, and scraper ids.
3. On the Scrape page: **Install …** or **Load adapters folder…** to copy into `data/adapters/`.
4. Optional: keep or edit the site's `extension` block (`page_matches`, post-id regexes, post URL template, `file_matches` for right-click **Download this file**) so the browser extension in `extension/` works on that site. See the main README → *Browser extension*.

Real site packages (anything except `example/`) are gitignored here. Keep them locally or in a private adapters repo.

A site can set `"profile": "gelbooru"`. Put every site that uses that downloader in one package (gelbooru.com, rule34.xxx, safebooru.org, xbooru.com, tbib.org, hypnohub.net, …), and name the scraper **Gelbooru** with all of those site ids. Each site is still its own selectable Source, listed under Gelbooru, and they share that scraper. The profile lists posts from the Gelbooru DAPI, or the HTML list when the API body is not a post list, and downloads the original `file_url`. Optional `api_base`, `api_user_id`, and `api_key` stay in this local file. The run keeps one browser context and clears the site's checkbox page before the next list page or image. Sites without `profile` keep the rule34.xyz downloader.
