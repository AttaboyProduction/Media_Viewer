from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload

from backend.app.db.models import Tag, TagAlias, TagGroup, TagGroupLink
from backend.app.db.session import get_db
from backend.app.schemas import (
    TagAliasBatchRequest,
    TagAliasRequest,
    TagCreateRequest,
    TagGroupCreateRequest,
    TagGroupMergeRequest,
    TagGroupOut,
    TagGroupPatchRequest,
    TagMergeRequest,
    TagOut,
    TagPatchRequest,
    TagRenameRequest,
)
from backend.app.services.tag_service import (
    add_tag_groups,
    create_tag,
    create_tag_group,
    delete_tag_group,
    get_tag_color,
    list_groups_for_tag,
    merge_tag_groups,
    merge_tags,
    recalculate_usage_counts,
    reindex_tag_groups_by_name,
    reindex_tags_by_name,
    remove_tag_groups,
    rename_tag,
    replace_tag_group,
    resolve_canonical_tag,
    resolve_canonical_tags,
    set_tag_alias,
    set_tag_group_sort_order,
    set_tag_primary_group,
    set_tag_sort_order,
    soft_delete_tag,
)

router = APIRouter(prefix="/tags", tags=["tags"])


def _group_outs(groups: list[TagGroup]) -> list[TagGroupOut]:
    return [TagGroupOut.model_validate(group) for group in groups]


def build_tag_out(db: Session, tag: Tag) -> TagOut:
    canonical = resolve_canonical_tag(db, tag)
    alias_of = None
    if canonical.id != tag.id:
        alias_of = canonical.name

    usage_count = int(canonical.usage_count or 0)

    alias_names = [
        row.name
        for row in (
            db.query(Tag.name)
            .join(TagAlias, TagAlias.alias_tag_id == Tag.id)
            .filter(TagAlias.canonical_tag_id == canonical.id, Tag.is_deleted.is_(False))
            .order_by(Tag.name)
            .all()
        )
    ]

    groups = _group_outs(list_groups_for_tag(db, canonical))
    group_out = next((g for g in groups if g.id == canonical.group_id), None)
    if group_out is None and groups:
        group_out = groups[0]
    elif group_out is None and canonical.group:
        group_out = TagGroupOut.model_validate(canonical.group)
    return TagOut(
        id=canonical.id,
        name=canonical.name,
        group=group_out,
        groups=groups,
        aliases=alias_names,
        color=get_tag_color(canonical),
        alias_of=alias_of,
        usage_count=usage_count,
        is_deleted=canonical.is_deleted,
        sort_order=canonical.sort_order,
    )


@router.get("", response_model=list[TagOut])
def list_tags(include_deleted: bool = False, db: Session = Depends(get_db)) -> list[TagOut]:
    """Batched list: one query each for aliases, usage counts, alias names, and group links."""
    query = db.query(Tag).options(joinedload(Tag.group))
    if not include_deleted:
        query = query.filter(Tag.is_deleted.is_(False))

    tags = query.order_by(Tag.name).all()
    canonical_map = resolve_canonical_tags(db, tags)

    usage_counts = {tag.id: int(tag.usage_count or 0) for tag in tags}

    alias_names: dict[int, list[str]] = defaultdict(list)
    for canonical_id, name in (
        db.query(TagAlias.canonical_tag_id, Tag.name)
        .join(Tag, TagAlias.alias_tag_id == Tag.id)
        .filter(Tag.is_deleted.is_(False))
        .order_by(Tag.name)
        .all()
    ):
        alias_names[canonical_id].append(name)

    groups_by_tag: dict[int, list[TagGroup]] = defaultdict(list)
    for tag_id, group in (
        db.query(TagGroupLink.tag_id, TagGroup)
        .join(TagGroup, TagGroup.id == TagGroupLink.group_id)
        .order_by(TagGroup.sort_order, TagGroup.label, TagGroup.id)
        .all()
    ):
        groups_by_tag[tag_id].append(group)

    seen_canonical: set[int] = set()
    result: list[TagOut] = []
    for tag in tags:
        canonical = canonical_map.get(tag.id, tag)
        if canonical.id in seen_canonical:
            continue
        seen_canonical.add(canonical.id)
        groups = groups_by_tag.get(canonical.id) or (
            [canonical.group] if canonical.group else []
        )
        group_outs = _group_outs(groups)
        group_out = next((g for g in group_outs if g.id == canonical.group_id), None)
        if group_out is None and group_outs:
            group_out = group_outs[0]
        result.append(
            TagOut(
                id=canonical.id,
                name=canonical.name,
                group=group_out,
                groups=group_outs,
                aliases=alias_names.get(canonical.id, []),
                color=get_tag_color(canonical),
                alias_of=canonical.name if canonical.id != tag.id else None,
                usage_count=int(usage_counts.get(canonical.id, 0)),
                is_deleted=canonical.is_deleted,
                sort_order=canonical.sort_order,
            )
        )

    return sorted(result, key=lambda t: t.name)


@router.post("/recalculate-usage")
def post_recalculate_usage(db: Session = Depends(get_db)) -> dict[str, int]:
    updated = recalculate_usage_counts(db)
    db.commit()
    return {"updated": updated}


@router.post("", response_model=TagOut)
def post_create_tag(payload: TagCreateRequest, db: Session = Depends(get_db)) -> TagOut:
    try:
        tag = create_tag(db, payload.name, payload.group_ids, payload.sort_order)
        db.commit()
        return build_tag_out(db, tag)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/merge", response_model=TagOut)
def post_merge(payload: TagMergeRequest, db: Session = Depends(get_db)) -> TagOut:
    try:
        target = merge_tags(db, payload.source_ids, payload.target_id, payload.new_name)
        db.commit()
        return build_tag_out(db, target)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/rename", response_model=TagOut)
def post_rename(payload: TagRenameRequest, db: Session = Depends(get_db)) -> TagOut:
    try:
        tag = rename_tag(db, payload.tag_id, payload.new_name)
        db.commit()
        return build_tag_out(db, tag)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/alias", response_model=TagOut)
def post_alias(payload: TagAliasRequest, db: Session = Depends(get_db)) -> TagOut:
    try:
        set_tag_alias(db, payload.alias_id, payload.canonical_id)
        db.commit()
        alias_tag = db.query(Tag).filter(Tag.id == payload.alias_id).first()
        return build_tag_out(db, alias_tag)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/alias-batch", response_model=TagOut)
def post_alias_batch(payload: TagAliasBatchRequest, db: Session = Depends(get_db)) -> TagOut:
    if not payload.alias_ids:
        raise HTTPException(status_code=400, detail="No alias tags provided")
    try:
        for alias_id in payload.alias_ids:
            set_tag_alias(db, alias_id, payload.canonical_id)
        db.commit()
        canonical = db.query(Tag).filter(Tag.id == payload.canonical_id).first()
        if not canonical:
            raise ValueError("Canonical tag not found")
        return build_tag_out(db, canonical)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/{tag_id}", response_model=TagOut)
def patch_tag(tag_id: int, payload: TagPatchRequest, db: Session = Depends(get_db)) -> TagOut:
    from backend.app.services.tag_service import (
        insert_tag_sort_order,
        next_tag_sort_order,
    )

    tag = db.query(Tag).filter(Tag.id == tag_id, Tag.is_deleted.is_(False)).first()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")

    old_group_id = tag.group_id

    try:
        if payload.group_id is not None:
            set_tag_primary_group(db, tag, payload.group_id)

        if payload.replace_group is not None:
            replace_tag_group(
                db, tag, payload.replace_group.from_id, payload.replace_group.to_id
            )

        if payload.add_group_ids:
            add_tag_groups(db, tag, payload.add_group_ids)

        if payload.remove_group_ids:
            remove_tag_groups(db, tag, payload.remove_group_ids)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if payload.color_override is not None:
        tag.color_override = payload.color_override or None

    group_changed = tag.group_id != old_group_id
    if payload.sort_order is not None:
        if group_changed:
            insert_tag_sort_order(db, tag, payload.sort_order)
        else:
            set_tag_sort_order(db, tag, payload.sort_order)
    elif group_changed:
        tag.sort_order = next_tag_sort_order(db, tag.group_id)
        db.flush()

    db.commit()
    return build_tag_out(db, tag)


@router.delete("/{tag_id}")
def delete_tag(tag_id: int, db: Session = Depends(get_db)) -> dict:
    try:
        soft_delete_tag(db, tag_id)
        db.commit()
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/reindex-order")
def post_reindex_tag_order(
    group_id: int | None = None,
    db: Session = Depends(get_db),
) -> dict:
    updated = reindex_tags_by_name(db, group_id=group_id)
    db.commit()
    return {"ok": True, "updated": updated}


tag_groups_router = APIRouter(prefix="/tag-groups", tags=["tag-groups"])


@tag_groups_router.get("", response_model=list[TagGroupOut])
def list_tag_groups(db: Session = Depends(get_db)) -> list[TagGroupOut]:
    groups = db.query(TagGroup).order_by(TagGroup.sort_order, TagGroup.label).all()
    return [TagGroupOut.model_validate(g) for g in groups]


@tag_groups_router.post("/reindex-order")
def post_reindex_tag_group_order(db: Session = Depends(get_db)) -> dict:
    updated = reindex_tag_groups_by_name(db)
    db.commit()
    return {"ok": True, "updated": updated}


@tag_groups_router.post("/merge", response_model=TagGroupOut)
def post_merge_tag_groups(
    payload: TagGroupMergeRequest,
    db: Session = Depends(get_db),
) -> TagGroupOut:
    try:
        group = merge_tag_groups(db, payload.source_ids, payload.target_id)
        db.commit()
        return TagGroupOut.model_validate(group)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@tag_groups_router.post("", response_model=TagGroupOut)
def post_tag_group(payload: TagGroupCreateRequest, db: Session = Depends(get_db)) -> TagGroupOut:
    try:
        group = create_tag_group(
            db,
            key=payload.key,
            label=payload.label or payload.key,
            default_color=payload.default_color,
            sort_order=payload.sort_order,
            is_default=payload.is_default,
        )
        db.commit()
        return TagGroupOut.model_validate(group)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@tag_groups_router.patch("/{group_id}", response_model=TagGroupOut)
def patch_tag_group(
    group_id: int,
    payload: TagGroupPatchRequest,
    db: Session = Depends(get_db),
) -> TagGroupOut:
    group = db.query(TagGroup).filter(TagGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Tag group not found")

    if payload.label is not None:
        group.label = payload.label
    if payload.default_color is not None:
        group.default_color = payload.default_color
    if payload.sort_order is not None:
        set_tag_group_sort_order(db, group, payload.sort_order)
    if payload.is_default is True:
        db.query(TagGroup).filter(TagGroup.is_default.is_(True), TagGroup.id != group_id).update(
            {"is_default": False}
        )
        group.is_default = True
    elif payload.is_default is False:
        group.is_default = False

    db.commit()
    return TagGroupOut.model_validate(group)


@tag_groups_router.delete("/{group_id}")
def delete_tag_group_endpoint(group_id: int, db: Session = Depends(get_db)) -> dict:
    try:
        delete_tag_group(db, group_id)
        db.commit()
        return {"ok": True}
    except ValueError as exc:
        detail = str(exc)
        status = 404 if "not found" in detail.lower() else 400
        raise HTTPException(status_code=status, detail=detail) from exc
