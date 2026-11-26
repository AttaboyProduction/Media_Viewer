import re
from collections.abc import Callable
from urllib.parse import urlparse

from playwright.sync_api import Page

from backend.app.config import settings
from backend.scraper.post import goto_post

MAX_LISTING_PAGES = 500


def normalize_post_url(href: str) -> str | None:
    if not re.search(r"/post/\d+", href):
        return None
    if href.startswith("http"):
        return href
    if href.startswith("/"):
        return f"{settings.base_url}{href}"
    return f"{settings.base_url}/{href}"


def extract_post_id(url: str) -> str | None:
    match = re.search(r"/post/(\d+)", url)
    if match:
        return match.group(1)
    return _post_id_from_site_patterns(url)


def _post_id_from_site_patterns(url: str) -> str | None:
    """Query-string post ids from installed adapter patterns (gelbooru ``id=``)."""
    try:
        from backend.scraper.sites import KNOWN_SITES, get_selected_site
    except Exception:
        return None
    ordered: list[dict] = []
    selected = get_selected_site()
    if selected:
        ordered.append(selected)
    for site in KNOWN_SITES.values():
        if not any(site.get("id") == item.get("id") for item in ordered):
            ordered.append(site)
    for site in ordered:
        extension = site.get("extension") or {}
        for pattern in extension.get("post_id_patterns") or []:
            try:
                found = re.search(str(pattern), url)
            except re.error:
                continue
            if found and found.lastindex and str(found.group(1)).isdigit():
                return found.group(1)
    return None


def _same_site(left: str, right: str) -> bool:
    return urlparse(left).netloc == urlparse(right).netloc


def _dismiss_popups(page: Page) -> None:
    """Popunders open the gallery in a second page and navigate this one to an ad."""
    try:
        extras = [extra for extra in page.context.pages if extra is not page]
    except Exception:
        return
    for extra in extras:
        try:
            extra.close()
        except Exception:
            continue


def _restore_if_hijacked(page: Page, url: str) -> None:
    _dismiss_popups(page)
    try:
        current = page.url
    except Exception:
        return
    if current and _same_site(current, url):
        return
    try:
        # Same flaky Obscura TLS handshake as the first listing load.
        goto_post(page, url, attempts=6)
        page.wait_for_timeout(800)
    except Exception:
        return


def _collect_from_page(page: Page) -> list[str]:
    links = None
    last_error: Exception | None = None
    for _ in range(4):
        try:
            links = page.eval_on_selector_all(
                "a[href*='/post/']",
                "elements => elements.map(el => el.href)",
            )
            break
        except Exception as exc:
            # A popunder navigation destroys the document mid-eval.
            last_error = exc
            if "context was destroyed" not in str(exc) and "navigation" not in str(exc):
                raise
            page.wait_for_timeout(400)
    if links is None:
        raise last_error or RuntimeError("Could not read gallery links")
    seen: set[str] = set()
    result: list[str] = []
    for href in links:
        normalized = normalize_post_url(href)
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def _listing_post_ids(page: Page) -> list[int]:
    ids: list[int] = []
    for url in _collect_from_page(page):
        pid = extract_post_id(url)
        if pid and pid.isdigit():
            ids.append(int(pid))
    return ids


def _ids_match_sort(ids: list[int], sort: str) -> bool:
    """Heuristic: post ids track upload order on the configured gallery site."""
    if len(ids) < 3:
        return True
    sample = ids[: min(12, len(ids))]
    pairs = list(zip(sample, sample[1:]))
    if not pairs:
        return True
    if sort == "date_asc":
        ups = sum(1 for a, b in pairs if a < b)
        return ups >= max(1, len(pairs) - 1)
    downs = sum(1 for a, b in pairs if a > b)
    return downs >= max(1, len(pairs) - 1)


def _expand_filters_panel(page: Page) -> None:
    """Sort chips live inside a collapsed Material expansion panel (often ``inert``)."""
    header = page.locator("mat-expansion-panel-header").filter(
        has_text=re.compile(r"Filters And Settings", re.I)
    )
    if header.count() == 0:
        header = page.get_by_role("button", name=re.compile(r"Filters And Settings", re.I))
    if header.count() == 0:
        return
    first = header.first
    here = page.url
    try:
        if first.get_attribute("aria-expanded") == "true":
            return
        first.click(timeout=4000)
        page.wait_for_timeout(500)
    except Exception:
        return
    finally:
        _restore_if_hijacked(page, here)


def _click_sort_chip(page: Page, label: str) -> bool:
    """Click a Sort chip (Oldest / Latest / …). Returns True if a click was attempted."""
    candidates = [
        page.locator("app-provider-buttons-group-filter button.chip-part").filter(
            has_text=re.compile(rf"^{re.escape(label)}$")
        ),
        page.locator("button.chip-part").filter(has_text=re.compile(rf"^{re.escape(label)}$")),
        page.locator(f"h4.label:text-is('{label}')"),
        page.get_by_text(label, exact=True),
    ]
    for locator in candidates:
        try:
            if locator.count() == 0:
                continue
            target = locator.first
            try:
                tag = str(target.evaluate("el => el.tagName") or "")
            except Exception:
                tag = ""
            if tag.upper() == "H4":
                btn = target.locator("xpath=ancestor::button[1]")
                if btn.count() > 0:
                    target = btn.first
            here = page.url
            target.click(timeout=4000, force=True)
            _restore_if_hijacked(page, here)
            return True
        except Exception:
            continue
    return False


def apply_listing_sort(page: Page, sort: str) -> None:
    """Apply gallery Sort chip so listing order matches scrape sort before limiting.

    On the configured gallery site the Sort controls sit in a collapsed
    ``Filters And Settings`` panel. Clicking without expanding leaves the default
    Latest (newest-first) listing — then a download limit takes the newest posts
    even when the user chose oldest-first.
    """
    label = "Oldest" if sort == "date_asc" else "Latest"
    # Latest is the site default; still click when requested so a sticky session state is reset.
    _expand_filters_panel(page)
    before = _listing_post_ids(page)
    clicked = _click_sort_chip(page, label)
    if not clicked and sort == "date_asc":
        raise RuntimeError(
            "Could not select Oldest sort on the gallery (open Filters And Settings → Sort)."
        )
    page.wait_for_timeout(1500)
    # Wait briefly for the grid to refresh after the chip click.
    for _ in range(8):
        after = _listing_post_ids(page)
        if after and (after != before or sort != "date_asc"):
            if _ids_match_sort(after, sort):
                return
            break
        page.wait_for_timeout(400)
    after = _listing_post_ids(page)
    if sort == "date_asc" and after and not _ids_match_sort(after, sort):
        # One more expand+click attempt.
        _expand_filters_panel(page)
        _click_sort_chip(page, label)
        page.wait_for_timeout(2000)
        after = _listing_post_ids(page)
        if after and not _ids_match_sort(after, sort):
            raise RuntimeError(
                "Gallery sort did not switch to oldest-first; aborting so the limit "
                "is not applied to newest posts."
            )


def _page_has_new_posts(page: Page, known: set[str]) -> bool:
    return any(url not in known for url in _collect_from_page(page))


def _load_more(page: Page, known: set[str]) -> bool:
    """Click Show more / Next. True only when new unique post URLs appear."""
    selectors = [
        "button:has-text('Show more')",
        "a:has-text('Show more')",
        "[role='button']:has-text('Show more')",
        "button:has-text('keyboard_arrow_right')",
        "a[aria-label='Next']",
        "button[aria-label='Next']",
        "a:has-text('Next')",
    ]
    for selector in selectors:
        locator = page.locator(selector)
        try:
            if locator.count() == 0:
                continue
            locator.first.click(timeout=2000)
            page.wait_for_timeout(1500)
            if _page_has_new_posts(page, known):
                return True
        except Exception:
            continue
    return False


def iter_post_urls(
    page: Page,
    gallery_url: str,
    *,
    limit: int = 0,
    sort: str = "date_desc",
    should_stop: Callable[[], bool] | None = None,
):
    """Yield post URLs from a gallery listing, loading more pages as needed.

    Listing sort is applied first (Oldest / Latest), then URLs are yielded in that
    order. Stops when ``limit`` unique URLs have been yielded (0 = soft cap 10_000),
    ``should_stop`` returns True, or the gallery has no more unseen posts (even if
    a download quota is still unmet).
    """
    # Obscura stealth TLS to this host fails about half the time (WRONG_VERSION_NUMBER).
    goto_post(page, gallery_url, attempts=6)
    page.wait_for_timeout(1500)
    _restore_if_hijacked(page, gallery_url)

    if "Checking your browser" in page.content():
        raise RuntimeError("Blocked by Cloudflare")

    apply_listing_sort(page, sort)

    known: set[str] = set()
    yielded = 0
    target = limit if limit > 0 else 10_000

    for _ in range(MAX_LISTING_PAGES):
        if should_stop and should_stop():
            return
        _restore_if_hijacked(page, gallery_url)
        for url in _collect_from_page(page):
            if url in known:
                continue
            known.add(url)
            yielded += 1
            yield url
            if yielded >= target:
                return
            if should_stop and should_stop():
                return
        # No more unseen posts available from Show more / Next — stop even if a
        # download limit has not been reached (remaining hits would only be skips).
        if not _load_more(page, known):
            return


def iter_gallery_posts(client, gallery_url: str, *, sort: str = "date_desc", should_stop: Callable[[], bool] | None = None):
    """List post URLs for the selected site (see ``scraper.listing``)."""
    from backend.scraper.listing import iter_gallery_post_urls

    yield from iter_gallery_post_urls(client, gallery_url, sort=sort, should_stop=should_stop)


def collect_post_urls(
    page: Page,
    gallery_url: str,
    *,
    limit: int = 0,
    sort: str = "date_desc",
    should_cancel: Callable[[], bool] | None = None,
) -> list[str]:
    return list(
        iter_post_urls(
            page,
            gallery_url,
            limit=limit,
            sort=sort,
            should_stop=should_cancel,
        )
    )
