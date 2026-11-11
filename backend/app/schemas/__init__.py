from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class TagGroupOut(BaseModel):
    id: int
    key: str
    label: str
    default_color: str
    sort_order: int = 0
    is_default: bool = False

    model_config = {"from_attributes": True}


class TagOut(BaseModel):
    id: int
    name: str
    group: TagGroupOut | None
    groups: list[TagGroupOut] = Field(default_factory=list)
    aliases: list[str] = Field(default_factory=list)
    color: str
    alias_of: str | None = None
    usage_count: int = 0
    is_deleted: bool = False
    sort_order: int = 0

    model_config = {"from_attributes": True}


class MediaTagOut(BaseModel):
    id: int
    name: str
    group: TagGroupOut | None
    groups: list[TagGroupOut] = Field(default_factory=list)
    display_names: list[str] = Field(default_factory=list)
    color: str
    is_manual: bool
    sort_order: int = 0

    model_config = {"from_attributes": True}


class RatingOut(BaseModel):
    my_rating: float | None = None
    avg_rating: float | None = None
    rating_count: int = 0


class MediaSummary(BaseModel):
    id: int
    source_post_id: str
    source_url: str
    source_urls: list[str] = Field(default_factory=list)
    media_type: str
    storage_kind: str = "managed"
    is_discarded: bool
    scraped_at: datetime
    media_url: str
    thumbnail_url: str
    tags: list[MediaTagOut]
    rating: RatingOut
    duplicate_of_id: int | None = None
    duplicate_kind: str | None = None
    file_size: int | None = None
    source_posted_at: datetime | None = None

    model_config = {"from_attributes": True}


class MediaListOut(BaseModel):
    items: list[MediaSummary]
    total: int
    page: int
    page_size: int


class MediaTagsUpdate(BaseModel):
    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)


class MediaUrlsUpdate(BaseModel):
    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)


class DiscardUpdate(BaseModel):
    is_discarded: bool


class MediaBulkActionRequest(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=500)
    action: Literal["discard", "delete"]


class MediaBulkActionOut(BaseModel):
    processed: list[int]
    missing: list[int]


class MediaBulkTagsRequest(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=500)
    add: list[str] = Field(min_length=1, max_length=100)


class MediaBulkTagsOut(BaseModel):
    processed: list[int]
    missing: list[int]
    added_tag_names: list[str]


class RatingUpdate(BaseModel):
    """Half-star scores: 0.5, 1, 1.5, …, 5."""

    score: float = Field(ge=0.5, le=5)

    @field_validator("score")
    @classmethod
    def half_steps(cls, value: float) -> float:
        stepped = round(float(value) * 2) / 2
        if abs(stepped - float(value)) > 1e-9:
            raise ValueError("Rating must be in half-star steps (0.5 … 5)")
        if stepped < 0.5 or stepped > 5:
            raise ValueError("Rating must be between 0.5 and 5")
        return stepped


class TagCreateRequest(BaseModel):
    name: str
    group_ids: list[int] = Field(default_factory=list)
    sort_order: int | None = None


class TagRenameRequest(BaseModel):
    tag_id: int
    new_name: str


class TagMergeRequest(BaseModel):
    source_ids: list[int]
    target_id: int | None = None
    new_name: str | None = None


class TagAliasRequest(BaseModel):
    alias_id: int
    canonical_id: int


class TagAliasBatchRequest(BaseModel):
    alias_ids: list[int]
    canonical_id: int


class TagGroupReplaceRequest(BaseModel):
    from_id: int
    to_id: int


class TagPatchRequest(BaseModel):
    group_id: int | None = None
    add_group_ids: list[int] = Field(default_factory=list)
    remove_group_ids: list[int] = Field(default_factory=list)
    replace_group: TagGroupReplaceRequest | None = None
    color_override: str | None = None
    sort_order: int | None = None


class TagGroupPatchRequest(BaseModel):
    label: str | None = None
    default_color: str | None = None
    sort_order: int | None = None
    is_default: bool | None = None


class TagGroupCreateRequest(BaseModel):
    key: str
    label: str = ""
    default_color: str | None = None
    sort_order: int | None = None
    is_default: bool = False


class TagGroupMergeRequest(BaseModel):
    source_ids: list[int]
    target_id: int


class ScrapeFilterIn(BaseModel):
    type: Literal["tag", "date_range", "url", "media_type"]
    value: str = ""


class ScrapeRunRequest(BaseModel):
    filters: list[ScrapeFilterIn] = Field(default_factory=list)
    sort: Literal["date_desc", "date_asc"] = "date_desc"
    limit: int = 10
    exclude_tags: list[str] = Field(default_factory=list)
    gallery_url: str | None = None
    tag_mode: Literal["and", "or"] = "and"


class LocalImportRunRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=500)
    recursive: bool = True


class LocalPathsOut(BaseModel):
    paths: list[str] = Field(default_factory=list)


class ScrapeSkippedItemOut(BaseModel):
    url: str
    reason: str


class ScrapeStatusOut(BaseModel):
    running: bool
    total: int
    processed: int
    downloaded: int
    skipped: int
    similar: int = 0
    errors: list[str]
    last_gallery_url: str | None
    message: str = ""
    current_url: str | None = None
    skipped_items: list[ScrapeSkippedItemOut] = Field(default_factory=list)
    hash_backfill_running: bool = False
    hash_backfill_total: int = 0
    hash_backfill_done: int = 0
    recent_media_ids: list[int] = Field(default_factory=list)
    ran_this_session: bool = False


class DuplicateActionRequest(BaseModel):
    action: Literal["keep_both", "discard", "discard_new", "discard_old"]


class DuplicateGroupOut(BaseModel):
    primary_id: int
    items: list[MediaSummary]


class DuplicateReviewOut(BaseModel):
    identical: list[DuplicateGroupOut]
    similar: list[DuplicateGroupOut]


class DuplicateMergeRequest(BaseModel):
    keep_id: int
    merge_ids: list[int] = Field(min_length=1, max_length=50)
    rating_from_id: int | None = None


class DuplicateKeepRequest(BaseModel):
    keep_ids: list[int] = Field(min_length=1, max_length=50)
    scope_ids: list[int] | None = Field(default=None, max_length=50)


class DuplicateMarkRequest(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=500)
    kind: Literal["identical", "similar"]


class DuplicateBulkMarkRequest(BaseModel):
    ids: list[int] = Field(min_length=2, max_length=500)
    kind: Literal["identical", "similar"]


class SortOption(str):
    DATE_DESC = "date_desc"
    DATE_ASC = "date_asc"
    RATING_DESC = "rating_desc"
    RATING_ASC = "rating_asc"
    RANDOM = "random"
