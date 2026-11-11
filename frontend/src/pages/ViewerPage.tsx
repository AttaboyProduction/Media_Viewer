import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchAppSettings, fetchMedia, patchAppSettings, type TagMatchMode } from '../api/client'
import { useApplyAppDefaults } from '../hooks/useAppDefaults'
import { useMediaBulkActions } from '../hooks/useMediaBulkActions'
import { useMediaMultiSelect } from '../hooks/useMediaMultiSelect'
import { usePageClamp } from '../hooks/usePageClamp'
import { usePersistedPageSize } from '../hooks/usePersistedPageSize'
import ContentHideMedia from '../components/ContentHideMedia'
import MediaDetailModal from '../components/MediaDetailModal'
import MediaBulkBar from '../components/list/MediaBulkBar'
import { StarsDisplay } from '../components/StarRating'
import MediaCollectionView from '../components/list/MediaCollectionView'
import ViewerTagSidebar from '../components/ViewerTagSidebar'
import { useContentHide } from '../hooks/useContentHide'
import {
  DEFAULT_APP_SETTINGS,
  type GridThumbnailSize,
  type ViewerSort,
} from '../types/appSettings'
import type { MediaItem } from '../types'
import { excludeTagsForMediaQuery } from '../utils/contentHide'
import { parseCommaSeparatedTags } from '../utils/tagList'
import { paginationTotalPages } from '../utils/pagination'
import { columnCountForViewerGrid } from '../utils/viewerGrid'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'

const TILE_MIN: Record<GridThumbnailSize, number> = {
  compact: 120,
  normal: 180,
  large: 240,
}

function MediaCard({
  item,
  onOpen,
  videoAutoplay,
  openOnDoubleClick,
  selectMode = false,
  selected = false,
  onSelectPointerDown,
}: {
  item: MediaItem
  onOpen: () => void
  videoAutoplay: boolean
  openOnDoubleClick: boolean
  selectMode?: boolean
  selected?: boolean
  onSelectPointerDown?: (e: ReactMouseEvent, id: number) => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const { isLocked, revealForMedia } = useContentHide()
  const locked = isLocked(item)

  const open = () => {
    if (locked) {
      void revealForMedia(item)
      return
    }
    onOpen()
  }

  const playPreview = () => {
    if (locked || videoAutoplay || selectMode) return
    const video = videoRef.current
    if (!video) return
    void video.play().catch(() => {
      /* autoplay policies / aborted play */
    })
  }

  const stopPreview = () => {
    if (videoAutoplay || selectMode) return
    const video = videoRef.current
    if (!video) return
    video.pause()
    video.currentTime = 0
  }

  return (
    <div
      className={`media-card${selected ? ' media-card-selected' : ''}${selectMode ? ' media-card-selecting' : ''}`}
      data-select-id={selectMode ? item.id : undefined}
      onClick={selectMode || openOnDoubleClick ? undefined : open}
      onDoubleClick={selectMode || !openOnDoubleClick ? undefined : open}
      onMouseDown={selectMode ? (e) => onSelectPointerDown?.(e, item.id) : undefined}
      onMouseEnter={item.media_type === 'video' ? playPreview : undefined}
      onMouseLeave={item.media_type === 'video' ? stopPreview : undefined}
    >
      {selectMode && (
        <label className="recent-scrape-select">
          <input
            type="checkbox"
            checked={selected}
            readOnly
            tabIndex={-1}
            aria-label={`Select #${item.source_post_id}`}
            onMouseDown={(e) => onSelectPointerDown?.(e, item.id)}
          />
        </label>
      )}
      <ContentHideMedia item={item} revealOnClick={!selectMode}>
        {item.media_type === 'video' ? (
          <video
            ref={videoRef}
            src={item.media_url}
            muted
            loop
            playsInline
            autoPlay={videoAutoplay && !selectMode && !locked}
            preload={videoAutoplay && !selectMode && !locked ? 'auto' : 'metadata'}
          />
        ) : (
          <img src={item.thumbnail_url} alt={item.source_post_id} loading="lazy" />
        )}
      </ContentHideMedia>
      <div className="media-card-meta">
        {item.rating.my_rating ? <StarsDisplay score={item.rating.my_rating} size="sm" /> : 'Unrated'}
        {' · '}
        {item.media_type}
        {/* Only later/related items — not the primary (lowest-id) file in a similar set */}
        {item.duplicate_of_id != null && item.id > item.duplicate_of_id ? ' · similar' : ''}
      </div>
    </div>
  )
}

export default function ViewerPage() {
  const queryClient = useQueryClient()
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 30_000,
  })
  const { hasPendingReveals, revealAllPending, revealing } = useContentHide()
  const prefs = appSettings ?? DEFAULT_APP_SETTINGS

  const [page, setPage] = useState(1)
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [tagMode, setTagMode] = useState<TagMatchMode>('and')
  const [tagsFilterExpanded, setTagsFilterExpanded] = useState(false)
  const [mediaType, setMediaType] = useState('')
  const [minRating, setMinRating] = useState<number | undefined>()
  // null until settings load — avoids first fetch with wrong hide/discarded defaults
  const [includeDiscarded, setIncludeDiscarded] = useState<boolean | null>(null)
  const [sort, setSort] = useState<ViewerSort | null>(null)
  const [hideExcluded, setHideExcluded] = useState<boolean | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const applyDefaults = useCallback((s: typeof prefs) => {
    setSort(s.viewer_sort)
    setIncludeDiscarded(s.viewer_include_discarded)
    setHideExcluded(s.viewer_hide_excluded_tags)
  }, [])
  useApplyAppDefaults(appSettings, applyDefaults)
  const resetPage = useCallback(() => setPage(1), [])
  const viewerPageSizeOptions =
    prefs.viewer_page_sizes?.length > 0
      ? prefs.viewer_page_sizes
      : DEFAULT_APP_SETTINGS.viewer_page_sizes
  const {
    pageSize,
    ready: pageSizeReady,
    pending: pageSizePending,
    changePageSize,
  } = usePersistedPageSize({
    settings: appSettings,
    settingKey: 'viewer_page_size',
    fallback: DEFAULT_APP_SETTINGS.viewer_page_size,
    onResetPage: resetPage,
    allowedSizes: viewerPageSizeOptions,
  })

  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null)
  const [gridWidth, setGridWidth] = useState(0)
  const [gridGap, setGridGap] = useState(12)
  const [gridAvailHeight, setGridAvailHeight] = useState<number | null>(null)

  const hideExcludedMutation = useMutation({
    mutationFn: (hide: boolean) => patchAppSettings({ viewer_hide_excluded_tags: hide }),
    onSuccess: (result) => {
      queryClient.setQueryData(['app-settings'], result)
    },
  })

  const includeDiscardedMutation = useMutation({
    mutationFn: (include: boolean) => patchAppSettings({ viewer_include_discarded: include }),
    onSuccess: (result) => {
      queryClient.setQueryData(['app-settings'], result)
    },
  })

  useEffect(() => {
    if (!gridEl) return
    const scrollParent = gridEl.closest('.media-collection-scroll')
    const measure = () => {
      setGridWidth(gridEl.clientWidth)
      const gap = parseFloat(getComputedStyle(gridEl).columnGap)
      if (!Number.isNaN(gap)) setGridGap(gap)
      setGridAvailHeight(scrollParent ? scrollParent.clientHeight : null)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(gridEl)
    if (scrollParent) ro.observe(scrollParent)
    measure()
    return () => ro.disconnect()
  }, [gridEl])

  const hiddenTagNames = useMemo(
    () => parseCommaSeparatedTags(prefs.viewer_exclude_tags),
    [prefs.viewer_exclude_tags],
  )
  const hiddenGroupKeys = useMemo(
    () => parseCommaSeparatedTags(prefs.viewer_exclude_tag_groups),
    [prefs.viewer_exclude_tag_groups],
  )
  const hasHiddenConfig = hiddenTagNames.length > 0 || hiddenGroupKeys.length > 0

  const mediaExcludeTags = useMemo(
    () =>
      excludeTagsForMediaQuery(
        selectedTags,
        hideExcluded ? hiddenTagNames : undefined,
        prefs.content_hide_rules,
        prefs.content_hide_revealed_rule_ids,
      ),
    [
      selectedTags,
      hideExcluded,
      hiddenTagNames,
      prefs.content_hide_rules,
      prefs.content_hide_revealed_rule_ids,
    ],
  )

  // Groups are expanded server-side, so the first fetch only waits for settings.
  const mediaQueryEnabled =
    hideExcluded !== null && includeDiscarded !== null && sort !== null && pageSizeReady

  const toggleHideExcluded = () => {
    if (!hasHiddenConfig || hideExcluded === null) return
    const next = !hideExcluded
    setHideExcluded(next)
    setPage(1)
    hideExcludedMutation.mutate(next)
  }

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: [
      'media',
      page,
      pageSize,
      selectedTags,
      tagMode,
      mediaType,
      minRating,
      includeDiscarded,
      hideExcluded,
      hiddenTagNames,
      hiddenGroupKeys,
      mediaExcludeTags,
      sort,
    ],
    queryFn: () =>
      fetchMedia({
        page,
        page_size: pageSize!,
        tags: selectedTags,
        tag_mode: tagMode,
        media_type: mediaType || undefined,
        min_rating: minRating,
        include_discarded: includeDiscarded!,
        exclude_tags: mediaExcludeTags,
        exclude_tag_groups: hideExcluded ? hiddenGroupKeys : undefined,
        sort: sort!,
      }),
    enabled: mediaQueryEnabled,
    // Keep the visible page while refetching (no "Loading..." blank on tag clicks or paging),
    // but drop it as soon as hide / discarded change so excluded media never shows.
    placeholderData: (previousData, previousQuery) => {
      if (!previousData || !previousQuery) return undefined
      const prev = previousQuery.queryKey
      const sameHideFilters =
        prev[0] === 'media' &&
        prev[7] === includeDiscarded &&
        prev[8] === hideExcluded &&
        JSON.stringify(prev[9]) === JSON.stringify(hiddenTagNames) &&
        JSON.stringify(prev[10]) === JSON.stringify(hiddenGroupKeys) &&
        JSON.stringify(prev[11]) === JSON.stringify(mediaExcludeTags)
      return sameHideFilters ? previousData : undefined
    },
  })

  const pageIds = data?.items.map((item) => item.id) ?? []
  const {
    selectMode,
    selectedIds,
    setSelectedIds,
    toggleSelectMode: toggleGridSelect,
    onSelectPointerDown,
    clearSelection,
  } = useMediaMultiSelect(pageIds)

  useEffect(() => {
    clearSelection()
  }, [
    page,
    pageSize,
    selectedTags,
    tagMode,
    mediaType,
    minRating,
    includeDiscarded,
    hideExcluded,
    sort,
    clearSelection,
  ])

  const toggleSelectMode = () => {
    if (!selectMode) setSelectedId(null)
    toggleGridSelect()
  }

  const {
    bulkBusy,
    deletePending,
    markError,
    handleBulkDiscard,
    handleBulkDelete,
    handleBulkMark,
    handleBulkAddTags,
  } = useMediaBulkActions({
    selectedIds,
    clearSelectedIds: () => setSelectedIds([]),
  })

  const toggleTagFilter = (name: string) => {
    setPage(1)
    setSelectedTags((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name],
    )
  }

  const sidebarLayout = (prefs.viewer_tag_layout ?? 'chips') === 'sidebar'
  const showLoading = !mediaQueryEnabled || isLoading || (isFetching && !data)
  const totalPages = data ? paginationTotalPages(data.total, data.page_size) : 1
  usePageClamp(page, data ? totalPages : page, setPage)
  const gridClass = `media-grid media-grid-${prefs.grid_thumbnail_size}${
    isFetching && data ? ' media-grid-refreshing' : ''
  }${selectMode ? ' recent-scrape-selecting' : ''}`
  const itemCount = data?.items.length ?? 0
  const gridColumns =
    gridWidth > 0 && pageSize !== null && itemCount > 0
      ? columnCountForViewerGrid({
          width: gridWidth,
          minTile: TILE_MIN[prefs.grid_thumbnail_size],
          gap: gridGap,
          pageSize,
          availableHeight: gridAvailHeight,
        })
      : null

  return (
    <div className="page viewer-page-fill">
      <div className="filters">
        <select value={mediaType} onChange={(e) => { setMediaType(e.target.value); setPage(1) }}>
          <option value="">All types</option>
          <option value="image">Images</option>
          <option value="gif">GIFs</option>
          <option value="video">Videos</option>
        </select>
        <select
          value={minRating ?? ''}
          onChange={(e) => {
            setMinRating(e.target.value ? Number(e.target.value) : undefined)
            setPage(1)
          }}
        >
          <option value="">Any rating</option>
          {[5, 4, 3, 2, 1].map((r) => (
            <option key={r} value={r}>{r}+ stars</option>
          ))}
        </select>
        <select
          value={sort ?? prefs.viewer_sort}
          onChange={(e) => setSort(e.target.value as ViewerSort)}
          disabled={sort === null}
        >
          <option value="date_desc">Newest</option>
          <option value="date_asc">Oldest</option>
          <option value="rating_desc">Highest rated</option>
          <option value="rating_asc">Lowest rated</option>
          <option value="random">Random</option>
        </select>
        <button
          type="button"
          className={`btn${hideExcluded && hasHiddenConfig ? ' btn-primary' : ''}`}
          disabled={
            hideExcluded === null || !hasHiddenConfig || hideExcludedMutation.isPending
          }
          title={
            hasHiddenConfig
              ? undefined
              : 'Choose hidden tags or groups in Settings → Hidden tags'
          }
          onClick={toggleHideExcluded}
        >
          {/* No label guess before settings arrive — it would flip once loaded. */}
          {hideExcluded === null
            ? 'Hidden tags'
            : hideExcluded
              ? 'Show hidden tags'
              : 'Hide hidden tags'}
        </button>
        {hasPendingReveals && (
          <button
            type="button"
            className="btn"
            disabled={revealing}
            onClick={() => void revealAllPending()}
          >
            Show hidden content
          </button>
        )}
        <label>
          <input
            type="checkbox"
            checked={includeDiscarded ?? false}
            disabled={includeDiscarded === null || includeDiscardedMutation.isPending}
            onChange={(e) => {
              const next = e.target.checked
              setIncludeDiscarded(next)
              setPage(1)
              includeDiscardedMutation.mutate(next)
            }}
          />{' '}
          Show discarded
        </label>
        {sidebarLayout && data && (
          <button
            type="button"
            className={`btn btn-small${selectMode ? ' btn-primary' : ''}`}
            disabled={bulkBusy || data.items.length === 0}
            onClick={toggleSelectMode}
          >
            {selectMode ? 'Clear selection' : 'Select'}
          </button>
        )}
      </div>

      {showLoading && <div className="empty">Loading...</div>}
      {error && <div className="error">Failed to load media</div>}
      {mediaQueryEnabled &&
        data &&
        data.items.length === 0 &&
        !isFetching &&
        selectedTags.length === 0 && <div className="empty">No media yet.</div>}

      {data && sidebarLayout && (
        <div className="viewer-with-sidebar">
          <ViewerTagSidebar
            items={data.items}
            selectedTags={selectedTags}
            onToggle={toggleTagFilter}
            onClear={() => {
              setPage(1)
              setSelectedTags([])
            }}
            tagMode={tagMode}
            onTagModeChange={(mode) => {
              setTagMode(mode)
              setPage(1)
            }}
          />
          <div className="viewer-sidebar-main">
            {selectMode && (
              <MediaBulkBar
                selectedCount={selectedIds.length}
                busy={bulkBusy}
                deletePending={deletePending}
                markError={markError}
                onDiscard={() => void handleBulkDiscard()}
                onDelete={() => void handleBulkDelete()}
                onMark={(kind) => void handleBulkMark(kind)}
                onAddTags={(names) => handleBulkAddTags(names)}
              />
            )}
            <MediaCollectionView
              fillHeight
              items={data.items}
              gridRef={setGridEl}
              gridClassName={gridClass}
              gridStyle={
                gridColumns
                  ? { gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))` }
                  : undefined
              }
              renderItem={(item) => (
                <MediaCard
                  item={item}
                  onOpen={() => setSelectedId(item.id)}
                  videoAutoplay={prefs.grid_video_autoplay}
                  openOnDoubleClick={prefs.media_open_on_double_click}
                  selectMode={selectMode}
                  selected={selectedIds.includes(item.id)}
                  onSelectPointerDown={onSelectPointerDown}
                />
              )}
              empty={
                !isFetching && selectedTags.length > 0 ? (
                  <div className="empty">No media matches these tags.</div>
                ) : undefined
              }
              pagination={{
                page,
                totalPages,
                total: data.total,
                pageSize: pageSize ?? prefs.viewer_page_size,
                pageSizeOptions: viewerPageSizeOptions,
                onPageChange: setPage,
                onPageSizeChange: changePageSize,
                pageSizeDisabled: !pageSizeReady || pageSizePending,
              }}
            />
          </div>
        </div>
      )}

      {data && !sidebarLayout && (
        <MediaCollectionView
          fillHeight
          items={data.items}
          gridRef={setGridEl}
          gridClassName={gridClass}
          gridStyle={
            gridColumns
              ? { gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))` }
              : undefined
          }
          tagFilter={{
            selectedTags,
            onToggle: toggleTagFilter,
            expanded: tagsFilterExpanded,
            onExpandedChange: setTagsFilterExpanded,
            onClearSelected: () => {
              setPage(1)
              setSelectedTags([])
            },
            tagMode,
            onTagModeChange: (mode) => {
              setTagMode(mode)
              setPage(1)
            },
            toolbarActions: (
              <button
                type="button"
                className={`btn btn-small${selectMode ? ' btn-primary' : ''}`}
                disabled={bulkBusy || data.items.length === 0}
                onClick={toggleSelectMode}
              >
                {selectMode ? 'Clear selection' : 'Select'}
              </button>
            ),
          }}
          beforeGrid={
            selectMode ? (
              <MediaBulkBar
                selectedCount={selectedIds.length}
                busy={bulkBusy}
                deletePending={deletePending}
                markError={markError}
                onDiscard={() => void handleBulkDiscard()}
                onDelete={() => void handleBulkDelete()}
                onMark={(kind) => void handleBulkMark(kind)}
                onAddTags={(names) => handleBulkAddTags(names)}
              />
            ) : undefined
          }
          renderItem={(item) => (
            <MediaCard
              item={item}
              onOpen={() => setSelectedId(item.id)}
              videoAutoplay={prefs.grid_video_autoplay}
              openOnDoubleClick={prefs.media_open_on_double_click}
              selectMode={selectMode}
              selected={selectedIds.includes(item.id)}
              onSelectPointerDown={onSelectPointerDown}
            />
          )}
          empty={
            !isFetching && selectedTags.length > 0 ? (
              <div className="empty">No media matches these tags.</div>
            ) : undefined
          }
          pagination={{
            page,
            totalPages,
            total: data.total,
            pageSize: pageSize ?? prefs.viewer_page_size,
            pageSizeOptions: viewerPageSizeOptions,
            onPageChange: setPage,
            onPageSizeChange: changePageSize,
            pageSizeDisabled: !pageSizeReady || pageSizePending,
          }}
        />
      )}

      {selectedId !== null && (
        <MediaDetailModal
          mediaId={selectedId}
          mediaIds={data?.items.map((item) => item.id) ?? []}
          onClose={() => setSelectedId(null)}
          onNavigate={setSelectedId}
        />
      )}
    </div>
  )
}
