from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time
from urllib.parse import quote

from backend.app.config import settings
from backend.app.schemas import ScrapeRunRequest
from backend.scraper.post import normalize_tag_name


@dataclass
class ScrapeJob:
    seed_urls: list[str]
    tags: list[str]
    tag_mode: str  # "and" | "or" — legacy flat mode when one constraint only
    date_from: datetime | None
    date_to: datetime | None
    media_type: str | None
    sort: str
    limit: int
    exclude_tags: list[str] = field(default_factory=list)
    # True when the run was seeded from URL filter rows (post or gallery links).
    ignore_download_limit: bool = False
    # Each row is (mode, tag names). Every row must match (rows AND together).
    tag_constraints: list[tuple[str, list[str]]] = field(default_factory=list)

    @property
    def gallery_url(self) -> str:
        return self.seed_urls[0] if self.seed_urls else settings.default_gallery_url


def _parse_filter_datetime(raw: str, *, is_end: bool) -> datetime | None:
    """Parse one side of a date_range filter.

    Accepts ``YYYY-MM-DD`` or ``YYYY-MM-DD[T ]HH:MM[:SS[.fff]]`` (naive, same as
    ``posted_at``). Date-only: from → start of day, to → end of day (inclusive).
    """
    text = raw.strip()
    if not text:
        return None
    normalized = text.replace(" ", "T", 1)
    if "T" in normalized:
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is not None:
            dt = dt.replace(tzinfo=None)
        return dt
    day = date.fromisoformat(normalized)
    if is_end:
        return datetime.combine(day, time(23, 59, 59, 999999))
    return datetime.combine(day, time.min)


def parse_date_range(value: str) -> tuple[datetime | None, datetime | None]:
    text = value.strip()
    if not text:
        return None, None
    if ".." not in text:
        raise ValueError("Date range must use from..to")
    start_raw, end_raw = text.split("..", 1)
    return (
        _parse_filter_datetime(start_raw, is_end=False),
        _parse_filter_datetime(end_raw, is_end=True),
    )


def split_tag_filter_values(raw: str) -> list[str]:
    """Newline- or comma-separated tag names in one filter row."""
    parts: list[str] = []
    for chunk in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        for part in chunk.split(","):
            text = part.strip()
            if text:
                parts.append(normalize_tag_name(text))
    return list(dict.fromkeys(parts))


def split_url_filter_values(raw: str) -> list[str]:
    """Split one URL filter value into seeds (newline or comma separated)."""
    parts: list[str] = []
    for chunk in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        for part in chunk.split(","):
            text = part.strip()
            if text:
                parts.append(text)
    return parts


def compile_scrape_job(payload: ScrapeRunRequest) -> ScrapeJob:
    from backend.scraper.sites import require_selected_scraper, require_selected_site

    site = require_selected_site()
    require_selected_scraper()

    tag_constraints: list[tuple[str, list[str]]] = []
    legacy_tags: list[str] = []
    date_from: datetime | None = None
    date_to: datetime | None = None
    urls: list[str] = []
    media_type: str | None = None
    date_rows = 0
    type_rows = 0
    tag_mode = payload.tag_mode if payload.tag_mode in ("and", "or") else "and"

    for item in payload.filters:
        value = item.value.strip()
        if item.type == "tag_or":
            names = split_tag_filter_values(item.value)
            if names:
                tag_constraints.append(("or", names))
        elif item.type == "tag_and":
            names = split_tag_filter_values(item.value)
            if names:
                tag_constraints.append(("and", names))
        elif item.type == "tag":
            names = split_tag_filter_values(item.value)
            if names:
                legacy_tags.extend(names)
        elif item.type == "date_range":
            date_rows += 1
            if date_rows > 1:
                raise ValueError("Only one date range filter is allowed")
            date_from, date_to = parse_date_range(value)
        elif item.type == "url":
            urls.extend(split_url_filter_values(item.value))
        elif item.type == "media_type":
            type_rows += 1
            if type_rows > 1:
                raise ValueError("Only one media type filter is allowed")
            if value and value != "all":
                media_type = value

    if not tag_constraints and legacy_tags:
        tag_constraints = [(tag_mode, list(dict.fromkeys(legacy_tags)))]
    tags: list[str] = []
    if len(tag_constraints) == 1:
        tag_mode, tags = tag_constraints[0]
    elif tag_constraints:
        tags = list(dict.fromkeys(tag for _, names in tag_constraints for tag in names))
        # tag_mode = how multiple tag rows combine (payload AND/OR toggle).
    else:
        tags = []

    exclude = [normalize_tag_name(tag) for tag in payload.exclude_tags if tag.strip()]
    seed_urls: list[str] = []
    base = str(site.get("base_url") or settings.base_url).rstrip("/")
    default_gallery = str(site.get("default_gallery_url") or settings.default_gallery_url)
    from backend.scraper.gelbooru import is_gelbooru_site, list_page_url

    if is_gelbooru_site(site):
        if urls:
            seed_urls = list(dict.fromkeys(urls))
        elif payload.gallery_url:
            seed_urls = [payload.gallery_url]
        elif tag_constraints:
            if len(tag_constraints) == 1:
                mode, row_tags = tag_constraints[0]
                if mode == "or":
                    seed_urls = [list_page_url(site, [tag], exclude) for tag in row_tags]
                else:
                    seed_urls = [list_page_url(site, row_tags, exclude)]
            elif all(mode == "and" for mode, _ in tag_constraints):
                merged = list(dict.fromkeys(tag for _, names in tag_constraints for tag in names))
                seed_urls = [list_page_url(site, merged, exclude)]
            else:
                seed_urls = [default_gallery]
        elif exclude:
            seed_urls = [list_page_url(site, [], exclude)]
        else:
            seed_urls = [default_gallery]
    elif urls:
        seed_urls = list(dict.fromkeys(urls))
    elif payload.gallery_url:
        seed_urls = [payload.gallery_url]
    elif tag_constraints:
        if len(tag_constraints) == 1:
            mode, row_tags = tag_constraints[0]
            if mode == "or":
                seed_urls = [f"{base}/{quote(tag)}" for tag in row_tags]
            else:
                seed_urls = [f"{base}/{quote(' '.join(row_tags))}"]
        elif all(mode == "and" for mode, _ in tag_constraints):
            merged = list(dict.fromkeys(tag for _, names in tag_constraints for tag in names))
            seed_urls = [f"{base}/{quote(' '.join(merged))}"]
        else:
            seed_urls = [default_gallery]
    else:
        seed_urls = [default_gallery]
    # limit = max successful downloads for tag/gallery scrapes (skips do not count).
    # URL-filter scrapes ignore the quota and try every seed / listing result.

    return ScrapeJob(
        seed_urls=seed_urls,
        tags=tags,
        tag_mode=tag_mode,
        tag_constraints=tag_constraints,
        date_from=date_from,
        date_to=date_to,
        media_type=media_type,
        sort=payload.sort,
        limit=payload.limit,
        exclude_tags=exclude,
        ignore_download_limit=bool(urls),
    )


def _naive_posted(posted_at: datetime) -> datetime:
    """Match filter bounds: posted_at is stored naive (tz stripped on scrape)."""
    if posted_at.tzinfo is not None:
        return posted_at.replace(tzinfo=None)
    return posted_at


def date_in_range(posted_at: datetime | None, job: ScrapeJob) -> bool:
    if posted_at is None:
        return True
    posted = _naive_posted(posted_at)
    if job.date_from and posted < job.date_from:
        return False
    if job.date_to and posted > job.date_to:
        return False
    return True


def should_stop_for_date(posted_at: datetime | None, job: ScrapeJob) -> bool:
    if posted_at is None or (job.date_from is None and job.date_to is None):
        return False
    posted = _naive_posted(posted_at)
    if job.sort == "date_asc":
        return bool(job.date_to and posted > job.date_to)
    return bool(job.date_from and posted < job.date_from)
