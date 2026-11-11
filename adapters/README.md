# Site adapters

Each package is a folder with `adapter.json`. Core ships **only** the `example/` package in git (marked `"template": true` so it does not appear in the app until you copy and customize it).

1. Copy `example/` to a new folder name and remove `"template": true` (or set it to `false`).
2. Change `id`, site `name` / URLs / `media_cdn_host`, and scraper ids.
3. On the Scrape page: **Install …** or **Load adapters folder…** to copy into `data/adapters/`.

Real site packages (anything except `example/`) are gitignored here. Keep them locally or in a private adapters repo.
