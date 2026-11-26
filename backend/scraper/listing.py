"""Discover post URLs from a gallery listing (tag search, whole site, etc.).

Site profile picks the strategy: Gelbooru DAPI + HTML fallback, or browser paging
for path-style galleries (rule34.xyz, …).

Gallery runs must enqueue each discovered URL for download as it is found
(see ``run_gallery_discovery``); do not collect the full list first.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator


def run_gallery_discovery(
    client,
    gallery_url: str,
    *,
    sort: str = "date_desc",
    should_stop: Callable[[], bool] | None = None,
    should_abort: Callable[[], bool] | None = None,
    on_discovered: Callable[[str], None],
    after_discovered: Callable[[], None] | None = None,
    site_id: str | None = None,
) -> None:
    """Walk a gallery and call ``on_discovered`` / ``after_discovered`` per new post URL."""
    for post_url in iter_gallery_post_urls(
        client,
        gallery_url,
        sort=sort,
        should_stop=should_stop,
        site_id=site_id,
    ):
        if should_abort and should_abort():
            break
        on_discovered(post_url)
        if after_discovered:
            after_discovered()
        if should_abort and should_abort():
            break


def iter_gallery_post_urls(
    client,
    gallery_url: str,
    *,
    sort: str = "date_desc",
    should_stop: Callable[[], bool] | None = None,
    site_id: str | None = None,
) -> Iterator[str]:
    from backend.scraper.gelbooru import is_gelbooru_site, iter_posts
    from backend.scraper.gallery import iter_post_urls
    from backend.scraper.sites import resolve_listing_site

    site = resolve_listing_site(gallery_url=gallery_url, site_id=site_id)
    if is_gelbooru_site(site):
        yield from iter_posts(client, site, gallery_url, sort=sort, should_stop=should_stop)
        return
    page = client.new_page()
    try:
        yield from iter_post_urls(
            page,
            gallery_url,
            limit=0,
            sort=sort,
            should_stop=should_stop,
        )
    finally:
        page.close()