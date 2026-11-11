import random

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.app.db.models import MediaItem, Rating
from backend.app.api.guards import require_scrape_page
from backend.app.db.session import get_db
from backend.app.schemas import (
    DiscardUpdate,
    DuplicateActionRequest,
    DuplicateGroupOut,
    DuplicateBulkMarkRequest,
    DuplicateKeepRequest,
    DuplicateMarkRequest,
    DuplicateMergeRequest,
    DuplicateReviewOut,
    MediaBulkActionOut,
    MediaBulkActionRequest,
    MediaBulkTagsOut,
    MediaBulkTagsRequest,
    MediaListOut,
    MediaSummary,
    MediaTagsUpdate,
    MediaUrlsUpdate,
    RatingOut,
    RatingUpdate,
)
from backend.app.services.duplicate_service import (
    group_for_media,
    keep_group_members,
    list_duplicate_groups,
    mark_related_many,
    mark_related_to,
    merge_identical,
    resolve_duplicate,
)
from backend.app.services.media_service import (
    absolute_path_for_media,
    build_media_summaries,
    build_media_summary,
    bulk_add_media_tags,
    bulk_media_action,
    media_ids_for_tags,
    media_ids_with_excluded_tags,
    delete_linked_media_file,
    delete_media,
    unlink_media_files,
    refresh_media_tags,
    rescrape_media,
    set_rating,
    update_media_tags,
    update_media_urls,
)

router = APIRouter(prefix="/media", tags=["media"])


def _split_csv(raw: str | None) -> list[str]:
    return [part.strip() for part in (raw or "").split(",") if part.strip()]


@router.get("", response_model=MediaListOut)
def list_media(
    page: int = Query(1, ge=1),
    page_size: int = Query(36, ge=1, le=200),
    tags: str | None = Query(None, description="Comma-separated tag names"),
    exclude_tags: str | None = Query(None, description="Comma-separated tag names to exclude"),
    exclude_tag_groups: str | None = Query(
        None, description="Comma-separated tag group keys to exclude"
    ),
    media_type: str | None = None,
    min_rating: int | None = Query(None, ge=1, le=5),
    include_discarded: bool = False,
    exclude_id: int | None = None,
    sort: str = "date_desc",
    tag_mode: str = "and",
    db: Session = Depends(get_db),
) -> MediaListOut:
    query = db.query(MediaItem)

    if not include_discarded:
        query = query.filter(MediaItem.is_discarded.is_(False))

    if exclude_id is not None:
        query = query.filter(MediaItem.id != exclude_id)

    if media_type:
        query = query.filter(MediaItem.media_type == media_type)

    matched_ids = media_ids_for_tags(db, _split_csv(tags), tag_mode)
    if matched_ids is not None:
        query = query.filter(MediaItem.id.in_(matched_ids))

    excluded_ids = media_ids_with_excluded_tags(
        db, _split_csv(exclude_tags), _split_csv(exclude_tag_groups)
    )
    if excluded_ids is not None:
        query = query.filter(~MediaItem.id.in_(excluded_ids))

    if min_rating:
        query = query.filter(
            MediaItem.id.in_(
                db.query(Rating.media_id)
                .group_by(Rating.media_id)
                .having(func.avg(Rating.score) >= min_rating)
            )
        )

    total = query.count()
    start = (page - 1) * page_size

    if sort == "random":
        # Shuffling needs the whole id set; rows for the page are fetched afterwards.
        ids = [row[0] for row in query.with_entities(MediaItem.id).all()]
        random.shuffle(ids)
        page_items = _fetch_media_in_id_order(db, ids[start : start + page_size])
    else:
        if sort in ("rating_desc", "rating_asc"):
            avg_ratings = (
                db.query(
                    Rating.media_id.label("media_id"),
                    func.avg(Rating.score).label("avg_score"),
                )
                .group_by(Rating.media_id)
                .subquery()
            )
            score = func.coalesce(avg_ratings.c.avg_score, 0)
            query = query.outerjoin(avg_ratings, avg_ratings.c.media_id == MediaItem.id)
            order_by = [score.asc() if sort == "rating_asc" else score.desc(), MediaItem.id.desc()]
        elif sort == "date_asc":
            order_by = [MediaItem.scraped_at.asc(), MediaItem.id.asc()]
        else:
            order_by = [MediaItem.scraped_at.desc(), MediaItem.id.desc()]
        page_items = query.order_by(*order_by).offset(start).limit(page_size).all()

    return MediaListOut(
        items=build_media_summaries(db, page_items),
        total=total,
        page=page,
        page_size=page_size,
    )


def _fetch_media_in_id_order(db: Session, ids: list[int]) -> list[MediaItem]:
    if not ids:
        return []
    by_id = {item.id: item for item in db.query(MediaItem).filter(MediaItem.id.in_(ids)).all()}
    return [by_id[media_id] for media_id in ids if media_id in by_id]


@router.get("/duplicates", response_model=DuplicateReviewOut)
def list_duplicates(db: Session = Depends(get_db)) -> DuplicateReviewOut:
    identical, similar = list_duplicate_groups(db)
    return DuplicateReviewOut(identical=identical, similar=similar)


@router.post("/duplicates/merge", response_model=MediaSummary)
def post_duplicate_merge(
    payload: DuplicateMergeRequest, db: Session = Depends(get_db)
) -> MediaSummary:
    try:
        media = merge_identical(db, payload.keep_id, payload.merge_ids, payload.rating_from_id)
        db.commit()
        return build_media_summary(db, media)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/duplicates/keep", response_model=DuplicateReviewOut)
def post_duplicate_keep(
    payload: DuplicateKeepRequest, db: Session = Depends(get_db)
) -> DuplicateReviewOut:
    try:
        keep_group_members(db, payload.keep_ids, payload.scope_ids)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    identical, similar = list_duplicate_groups(db)
    return DuplicateReviewOut(identical=identical, similar=similar)


@router.post("/duplicates/mark", response_model=DuplicateReviewOut)
def post_duplicate_mark_many(
    payload: DuplicateBulkMarkRequest, db: Session = Depends(get_db)
) -> DuplicateReviewOut:
    try:
        mark_related_many(db, payload.ids, payload.kind)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    identical, similar = list_duplicate_groups(db)
    return DuplicateReviewOut(identical=identical, similar=similar)


@router.post("/bulk", response_model=MediaBulkActionOut)
def post_bulk_action(
    payload: MediaBulkActionRequest,
    db: Session = Depends(get_db),
) -> MediaBulkActionOut:
    processed, missing, paths = bulk_media_action(db, payload.ids, payload.action)
    db.commit()
    unlink_media_files(paths)
    return MediaBulkActionOut(processed=processed, missing=missing)


@router.post("/bulk-tags", response_model=MediaBulkTagsOut)
def post_bulk_tags(
    payload: MediaBulkTagsRequest,
    db: Session = Depends(get_db),
) -> MediaBulkTagsOut:
    try:
        processed, missing, added = bulk_add_media_tags(db, payload.ids, payload.add)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return MediaBulkTagsOut(processed=processed, missing=missing, added_tag_names=added)


@router.get("/{media_id}/duplicate-group", response_model=DuplicateGroupOut)
def get_duplicate_group(media_id: int, db: Session = Depends(get_db)) -> DuplicateGroupOut:
    group = group_for_media(db, media_id)
    if group is None:
        raise HTTPException(status_code=404, detail="No related files")
    return group


@router.post("/{media_id}/related", response_model=DuplicateGroupOut)
def post_mark_related(
    media_id: int,
    payload: DuplicateMarkRequest,
    db: Session = Depends(get_db),
) -> DuplicateGroupOut:
    try:
        mark_related_to(db, media_id, payload.ids, payload.kind)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    group = group_for_media(db, media_id)
    if group is None:
        raise HTTPException(status_code=400, detail="Link did not create a group")
    return group


@router.post("/{media_id}/duplicate", response_model=MediaSummary)
def post_resolve_duplicate(
    media_id: int,
    payload: DuplicateActionRequest,
    db: Session = Depends(get_db),
) -> MediaSummary:
    try:
        media = resolve_duplicate(db, media_id, payload.action)
        db.commit()
        return build_media_summary(db, media)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{media_id}", response_model=MediaSummary)
def get_media(media_id: int, db: Session = Depends(get_db)) -> MediaSummary:
    media = db.query(MediaItem).filter(MediaItem.id == media_id).first()
    if not media:
        raise HTTPException(status_code=404, detail="Media not found")
    return build_media_summary(db, media)


@router.get("/{media_id}/file")
def get_media_file(media_id: int, db: Session = Depends(get_db)):
    """Serve media bytes by id (required for linked local files outside media/)."""
    media = db.query(MediaItem).filter(MediaItem.id == media_id).first()
    if not media:
        raise HTTPException(status_code=404, detail="Media not found")
    path = absolute_path_for_media(media)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Media file missing on disk")
    return FileResponse(path)


@router.patch("/{media_id}/tags", response_model=MediaSummary)
def patch_media_tags(
    media_id: int,
    payload: MediaTagsUpdate,
    db: Session = Depends(get_db),
) -> MediaSummary:
    try:
        media = update_media_tags(
            db, media_id, payload.add, payload.remove, payload.group_ids
        )
        db.commit()
        return build_media_summary(db, media)
    except ValueError as exc:
        detail = str(exc)
        status = 404 if detail == "Media not found" else 400
        raise HTTPException(status_code=status, detail=detail) from exc


@router.post(
    "/{media_id}/refresh-tags",
    response_model=MediaSummary,
    dependencies=[Depends(require_scrape_page)],
)
def post_refresh_tags(media_id: int, db: Session = Depends(get_db)) -> MediaSummary:
    """Fetch tags from linked URLs (JSON API then HTML); does not re-download media."""
    try:
        media = refresh_media_tags(db, media_id)
        db.commit()
        return build_media_summary(db, media)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.patch("/{media_id}/urls", response_model=MediaSummary)
def patch_media_urls(
    media_id: int,
    payload: MediaUrlsUpdate,
    db: Session = Depends(get_db),
) -> MediaSummary:
    try:
        media = update_media_urls(db, media_id, payload.add, payload.remove)
        db.commit()
        return build_media_summary(db, media)
    except ValueError as exc:
        status = 404 if "not found" in str(exc).lower() else 400
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@router.post(
    "/{media_id}/rescrape",
    response_model=MediaSummary,
    dependencies=[Depends(require_scrape_page)],
)
def post_rescrape(media_id: int, db: Session = Depends(get_db)) -> MediaSummary:
    try:
        media = rescrape_media(db, media_id)
        db.commit()
        return build_media_summary(db, media)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.delete("/{media_id}", status_code=204)
def delete_media_endpoint(media_id: int, db: Session = Depends(get_db)) -> None:
    try:
        delete_media(db, media_id)
        db.commit()
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{media_id}/local-file", status_code=204)
def delete_media_local_file(media_id: int, db: Session = Depends(get_db)) -> None:
    """Delete a linked PC file from disk and remove its library row."""
    try:
        delete_linked_media_file(db, media_id)
        db.commit()
    except ValueError as exc:
        detail = str(exc)
        status = 404 if "not found" in detail.lower() else 400
        raise HTTPException(status_code=status, detail=detail) from exc


@router.patch("/{media_id}/discard", response_model=MediaSummary)
def patch_discard(
    media_id: int,
    payload: DiscardUpdate,
    db: Session = Depends(get_db),
) -> MediaSummary:
    media = db.query(MediaItem).filter(MediaItem.id == media_id).first()
    if not media:
        raise HTTPException(status_code=404, detail="Media not found")
    media.is_discarded = payload.is_discarded
    db.commit()
    return build_media_summary(db, media)


@router.put("/{media_id}/rating", response_model=RatingOut)
def put_rating(
    media_id: int,
    payload: RatingUpdate,
    db: Session = Depends(get_db),
) -> RatingOut:
    try:
        result = set_rating(db, media_id, payload.score)
        db.commit()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
