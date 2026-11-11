import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  clearRecentScrapedMedia,
  deleteMedia,
  fetchAppSettings,
  fetchRecentScrapedMedia,
  fetchScrapeStatus,
  patchAppSettings,
  type TagMatchMode,
} from '../api/client'
import { useConfirm } from '../context/ConfirmContext'
import { useMediaBulkActions } from '../hooks/useMediaBulkActions'
import MediaBulkBar from './list/MediaBulkBar'
import { DEFAULT_APP_SETTINGS, SCRAPE_DOWNLOAD_PAGE_SIZES } from '../types/appSettings'
import type { MediaItem } from '../types'
import { usePageClamp } from '../hooks/usePageClamp'
import { usePersistedPageSize } from '../hooks/usePersistedPageSize'
import { useMediaMultiSelect } from '../hooks/useMediaMultiSelect'
import { excludeTagsForMediaQuery } from '../utils/contentHide'
import { paginationTotalPages } from '../utils/pagination'
import ContentHideMedia from './ContentHideMedia'
import MediaDetailModal from './MediaDetailModal'
import MediaCollectionView from './list/MediaCollectionView'
import { useContentHide } from '../hooks/useContentHide'

function RecentCard({
  item,
  onOpen,
  onDelete,
  deleting,
  selectMode,
  selected,
  onSelectPointerDown,
}: {
  item: MediaItem
  onOpen: () => void
  onDelete: () => void
  deleting: boolean
  selectMode: boolean
  selected: boolean
  onSelectPointerDown: (e: ReactMouseEvent, id: number) => void
}) {
  const { isLocked, revealForMedia } = useContentHide()
  const locked = isLocked(item)
  const openOrReveal = () => {
    if (locked) {
      void revealForMedia(item)
      return
    }
    onOpen()
  }
  return (
    <div
      className={`media-card recent-scrape-card${selected ? ' recent-scrape-card-selected' : ''}`}
      data-select-id={item.id}
    >
      <div className="recent-scrape-thumb-wrap">
        {selectMode ? (
          <button
            type="button"
            className="recent-scrape-thumb"
            onMouseDown={(e) => onSelectPointerDown(e, item.id)}
            onClick={(e) => e.preventDefault()}
          >
            <ContentHideMedia item={item} revealOnClick={false}>
              {item.media_type === 'video' ? (
                <video src={item.media_url} muted preload="metadata" draggable={false} />
              ) : (
                <img
                  src={item.thumbnail_url}
                  alt={item.source_post_id}
                  loading="lazy"
                  draggable={false}
                />
              )}
            </ContentHideMedia>
          </button>
        ) : (
          <button type="button" className="recent-scrape-thumb" onClick={openOrReveal}>
            <ContentHideMedia item={item}>
              {item.media_type === 'video' ? (
                <video src={item.media_url} muted preload="metadata" />
              ) : (
                <img src={item.thumbnail_url} alt={item.source_post_id} loading="lazy" />
              )}
            </ContentHideMedia>
          </button>
        )}
        {selectMode && (
          <label className="recent-scrape-select">
            <input
              type="checkbox"
              checked={selected}
              readOnly
              tabIndex={-1}
              aria-label={`Select #${item.source_post_id}`}
              onMouseDown={(e) => onSelectPointerDown(e, item.id)}
            />
          </label>
        )}
      </div>
      <div className="media-card-meta recent-scrape-meta">
        <span>
          #{item.source_post_id} · {item.media_type}
          {item.duplicate_of_id != null ? ' · similar' : ''}
        </span>
        {!selectMode && (
          <button
            type="button"
            className="btn btn-small btn-danger recent-scrape-delete"
            disabled={deleting}
            title="Delete"
            aria-label="Delete"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            ×
          </button>
        )}
      </div>
    </div>
  )
}

export default function RecentScrapedMediaPanel() {
  const queryClient = useQueryClient()
  const { confirm } = useConfirm()
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [tagMode, setTagMode] = useState<TagMatchMode>('and')
  const [tagsFilterExpanded, setTagsFilterExpanded] = useState(false)

  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 60_000,
  })
  const showAll =
    appSettings?.scrape_downloads_show_all ?? DEFAULT_APP_SETTINGS.scrape_downloads_show_all
  const resetPage = useCallback(() => setPage(1), [])
  const {
    pageSize,
    ready: pageSizeReady,
    pending: pageSizePending,
    changePageSize,
  } = usePersistedPageSize({
    settings: appSettings,
    settingKey: 'scrape_downloads_page_size',
    fallback: DEFAULT_APP_SETTINGS.scrape_downloads_page_size,
    onResetPage: resetPage,
  })
  const scope = showAll ? 'all' : 'session'
  const prefs = appSettings ?? DEFAULT_APP_SETTINGS
  const mediaExcludeTags = useMemo(
    () =>
      excludeTagsForMediaQuery(
        selectedTags,
        undefined,
        prefs.content_hide_rules,
        prefs.content_hide_revealed_rule_ids,
      ) ?? [],
    [selectedTags, prefs.content_hide_rules, prefs.content_hide_revealed_rule_ids],
  )

  const { data: status } = useQuery({
    queryKey: ['scrape-status'],
    queryFn: fetchScrapeStatus,
    refetchInterval: (query) => (query.state.data?.running ? 1000 : 2000),
  })

  const recentCount = status?.recent_media_ids.length ?? 0
  const sessionEmpty = !showAll && recentCount === 0

  const scopeMutation = useMutation({
    mutationFn: (next: boolean) => patchAppSettings({ scrape_downloads_show_all: next }),
    onSuccess: (next) => {
      queryClient.setQueryData(['app-settings'], next)
      setPage(1)
      setSelectedTags([])
      setSelectedId(null)
      exitSelectMode()
      void queryClient.removeQueries({ queryKey: ['scrape-recent-media'] })
    },
  })

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: [
      'scrape-recent-media',
      scope,
      page,
      pageSize,
      selectedTags,
      tagMode,
      mediaExcludeTags,
    ],
    queryFn: () =>
      fetchRecentScrapedMedia(page, pageSize!, selectedTags, scope, tagMode, mediaExcludeTags),
    enabled: pageSizeReady && (showAll || recentCount > 0),
    // Never keep "all" library results when session is empty / scope flipped.
    placeholderData: (previousData) => (sessionEmpty ? undefined : previousData),
  })

  const items = sessionEmpty ? [] : (data?.items ?? [])
  const pageIds = items.map((item) => item.id)
  const {
    selectMode,
    selectedIds,
    setSelectedIds,
    toggleSelectMode: toggleGridSelect,
    onSelectPointerDown,
    clearSelection,
    exitSelectMode,
  } = useMediaMultiSelect(pageIds)

  // Selection only ever covers what is on screen, so bulk actions never hit hidden items.
  useEffect(() => {
    clearSelection()
  }, [page, pageSize, scope, selectedTags, tagMode, clearSelection])

  useEffect(() => {
    if (recentCount === 0) return
    void queryClient.invalidateQueries({ queryKey: ['scrape-recent-media'] })
  }, [recentCount, queryClient])

  useEffect(() => {
    if (!showAll && recentCount === 0 && selectMode) exitSelectMode()
  }, [showAll, recentCount, selectMode, exitSelectMode])

  const clearMutation = useMutation({
    mutationFn: clearRecentScrapedMedia,
    onSuccess: (next) => {
      queryClient.setQueryData(['scrape-status'], next)
      queryClient.invalidateQueries({ queryKey: ['scrape-recent-media'] })
      setPage(1)
      setSelectedTags([])
      setSelectedId(null)
      exitSelectMode()
    },
  })

  const invalidateAfterMediaChange = () => {
    queryClient.invalidateQueries({ queryKey: ['scrape-recent-media'] })
    queryClient.invalidateQueries({ queryKey: ['scrape-status'] })
    queryClient.invalidateQueries({ queryKey: ['media'] })
    queryClient.invalidateQueries({ queryKey: ['duplicates'] })
  }

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteMedia(id),
    onSuccess: (_void, id) => {
      invalidateAfterMediaChange()
      if (selectedId === id) setSelectedId(null)
      setSelectedIds((prev) => prev.filter((x) => x !== id))
    },
  })

  const {
    bulkBusy: selectionBusy,
    deletePending,
    markError,
    handleBulkDiscard,
    handleBulkDelete,
    handleBulkMark,
    handleBulkAddTags,
  } = useMediaBulkActions({
      selectedIds,
      clearSelectedIds: () => setSelectedIds([]),
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey: ['scrape-recent-media'] })
        queryClient.invalidateQueries({ queryKey: ['scrape-status'] })
      },
      onFinished: (action, ids) => {
        if (action !== 'mark' && selectedId != null && ids.includes(selectedId)) setSelectedId(null)
      },
    })

  const total = sessionEmpty ? 0 : (data?.total ?? 0)
  const totalPages = paginationTotalPages(
    total,
    pageSize ?? DEFAULT_APP_SETTINGS.scrape_downloads_page_size,
  )
  usePageClamp(page, data || sessionEmpty ? totalPages : page, setPage)
  // Whole-session navigation only when nothing is filtered out of the grid.
  const navIds =
    !showAll && selectedTags.length === 0 && status?.recent_media_ids
      ? [...status.recent_media_ids].reverse()
      : pageIds

  const hasContent = showAll ? total > 0 || isLoading || selectedTags.length > 0 : recentCount > 0
  const emptySession = sessionEmpty && !isLoading
  const emptyAll =
    showAll && !isLoading && !isFetching && total === 0 && selectedTags.length === 0

  const toggleTagFilter = (name: string) => {
    setPage(1)
    setSelectedTags((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name],
    )
  }

  const toggleSelectMode = () => {
    if (!selectMode) setSelectedId(null)
    toggleGridSelect()
  }

  const handleDelete = async (item: MediaItem) => {
    const ok = await confirm({
      title: 'Delete media?',
      message: `Permanently delete #${item.source_post_id}? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) deleteMutation.mutate(item.id)
  }

  const handleClear = async () => {
    const ok = await confirm({
      title: 'Clear session list?',
      message: 'Remove all items from this session list? Files stay in the library.',
      confirmLabel: 'Clear list',
    })
    if (ok) clearMutation.mutate()
  }

  const bulkBusy = selectionBusy || deleteMutation.isPending

  return (
    <div className="panel">
      <div className="panel-header-row">
        <h2>Downloaded previously</h2>
        <div className="panel-header-actions">
          <label className="recent-scrape-scope">
            <input
              type="checkbox"
              checked={showAll}
              disabled={scopeMutation.isPending}
              onChange={(e) => scopeMutation.mutate(e.target.checked)}
            />
            Show all downloads
          </label>
          {!showAll && recentCount > 0 && (
            <button
              type="button"
              className="btn btn-small"
              disabled={clearMutation.isPending || bulkBusy}
              onClick={() => void handleClear()}
            >
              Clear list
            </button>
          )}
        </div>
      </div>
      <p className="hint">
        {showAll
          ? 'All media in the library, newest scraped first (by local scrape date).'
          : 'Downloads from this app session (survives multiple scrapes until restart or clear).'}
      </p>
      {emptySession && <div className="empty">Nothing downloaded yet this session.</div>}
      {emptyAll && <div className="empty">No downloaded media in the library yet.</div>}
      {isLoading && hasContent && !data && <div className="empty">Loading...</div>}
      {error && <div className="error">Failed to load downloads</div>}

      <MediaCollectionView
        items={items}
        gridClassName={`media-grid media-grid-compact${
          isFetching ? ' media-grid-refreshing' : ''
        }${selectMode ? ' recent-scrape-selecting' : ''}`}
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
              disabled={clearMutation.isPending || bulkBusy || items.length === 0}
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
          <RecentCard
            item={item}
            onOpen={() => setSelectedId(item.id)}
            onDelete={() => void handleDelete(item)}
            deleting={deleteMutation.isPending}
            selectMode={selectMode}
            selected={selectedIds.includes(item.id)}
            onSelectPointerDown={onSelectPointerDown}
          />
        )}
        empty={
          hasContent && !isLoading && !isFetching && selectedTags.length > 0 ? (
            <div className="empty">No media matches these tags.</div>
          ) : undefined
        }
        pagination={{
          page,
          totalPages,
          total,
          pageSize: pageSize ?? DEFAULT_APP_SETTINGS.scrape_downloads_page_size,
          pageSizeOptions: SCRAPE_DOWNLOAD_PAGE_SIZES,
          onPageChange: setPage,
          onPageSizeChange: changePageSize,
          pageSizeDisabled: !pageSizeReady || pageSizePending,
        }}
      />

      {selectedId !== null && (
        <MediaDetailModal
          mediaId={selectedId}
          mediaIds={navIds}
          onClose={() => {
            setSelectedId(null)
            void queryClient.invalidateQueries({ queryKey: ['scrape-recent-media'] })
            void queryClient.invalidateQueries({ queryKey: ['scrape-status'] })
          }}
          onNavigate={setSelectedId}
        />
      )}
    </div>
  )
}
