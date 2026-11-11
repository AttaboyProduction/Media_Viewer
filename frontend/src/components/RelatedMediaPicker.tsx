import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { fetchAppSettings, fetchMedia, markRelated, type TagMatchMode } from '../api/client'
import { useConfirm } from '../context/ConfirmContext'
import { useMediaMultiSelect } from '../hooks/useMediaMultiSelect'
import { usePageClamp } from '../hooks/usePageClamp'
import type { MediaItem } from '../types'
import { excludeTagsForMediaQuery } from '../utils/contentHide'
import { parseCommaSeparatedTags } from '../utils/tagList'
import { DEFAULT_APP_SETTINGS } from '../types/appSettings'
import { paginationTotalPages } from '../utils/pagination'
import ContentHideMedia from './ContentHideMedia'
import MediaBulkBar from './list/MediaBulkBar'
import MediaCollectionView from './list/MediaCollectionView'

const PAGE_SIZE = 6

function RelatedCard({
  item,
  selectMode,
  selected,
  onSelectPointerDown,
}: {
  item: MediaItem
  selectMode: boolean
  selected: boolean
  onSelectPointerDown: (event: ReactMouseEvent, id: number) => void
}) {
  return (
    <div
      className={`media-card${selected ? ' media-card-selected' : ''}${selectMode ? ' media-card-selecting' : ''}`}
      data-select-id={selectMode ? item.id : undefined}
      onMouseDown={selectMode ? (event) => onSelectPointerDown(event, item.id) : undefined}
    >
      {selectMode && (
        <label className="recent-scrape-select">
          <input
            type="checkbox"
            checked={selected}
            readOnly
            tabIndex={-1}
            aria-label={`Select #${item.id}`}
            onMouseDown={(event) => onSelectPointerDown(event, item.id)}
          />
        </label>
      )}
      <ContentHideMedia item={item} revealOnClick={!selectMode}>
        {item.media_type === 'video' ? (
          <video src={item.media_url} muted preload="metadata" />
        ) : (
          <img src={item.thumbnail_url} alt="" loading="lazy" />
        )}
      </ContentHideMedia>
      <div className="media-card-meta">
        {item.id} · #{item.source_post_id} · {item.media_type}
        {item.is_discarded ? ' · discarded' : ''}
      </div>
    </div>
  )
}

/** Library grid for linking other files to the open one. Tags start as the open file's tags. */
export default function RelatedMediaPicker({
  sourceId,
  initialTags,
}: {
  sourceId: number
  initialTags: string[]
}) {
  const queryClient = useQueryClient()
  const { confirm } = useConfirm()
  const [selectedTags, setSelectedTags] = useState<string[]>(initialTags)
  const [tagMode, setTagMode] = useState<TagMatchMode>('and')
  const [page, setPage] = useState(1)
  const [tagsExpanded, setTagsExpanded] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [localId, setLocalId] = useState('')
  const [kind, setKind] = useState<'identical' | 'similar'>('identical')
  const [hideExcluded, setHideExcluded] = useState<boolean | null>(null)

  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 60_000,
  })
  const hiddenTagNames = useMemo(
    () => parseCommaSeparatedTags(appSettings?.viewer_exclude_tags ?? ''),
    [appSettings?.viewer_exclude_tags],
  )
  const hiddenGroupKeys = useMemo(
    () => parseCommaSeparatedTags(appSettings?.viewer_exclude_tag_groups ?? ''),
    [appSettings?.viewer_exclude_tag_groups],
  )
  const hasHiddenConfig = hiddenTagNames.length > 0 || hiddenGroupKeys.length > 0
  const prefs = appSettings ?? DEFAULT_APP_SETTINGS
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

  useEffect(() => {
    if (!appSettings || hideExcluded !== null) return
    setHideExcluded(appSettings.viewer_hide_excluded_tags)
  }, [appSettings, hideExcluded])

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: [
      'related-pick',
      sourceId,
      page,
      selectedTags,
      tagMode,
      hideExcluded,
      hiddenTagNames,
      hiddenGroupKeys,
      mediaExcludeTags,
    ],
    queryFn: () =>
      fetchMedia({
        page,
        page_size: PAGE_SIZE,
        tags: selectedTags,
        tag_mode: tagMode,
        sort: 'date_desc',
        include_discarded: true,
        exclude_id: sourceId,
        exclude_tags: mediaExcludeTags,
        exclude_tag_groups: hideExcluded ? hiddenGroupKeys : undefined,
      }),
    enabled: pickerOpen && hideExcluded !== null,
  })

  const items = data?.items ?? []
  const pageIds = items.map((item) => item.id)
  const {
    selectMode,
    selectedIds,
    setSelectedIds,
    onSelectPointerDown,
    clearSelection,
    enterSelectMode,
    exitSelectMode,
  } = useMediaMultiSelect(pageIds)

  useEffect(() => {
    clearSelection()
  }, [page, selectedTags, tagMode, hideExcluded, clearSelection])

  const totalPages = data ? paginationTotalPages(data.total, PAGE_SIZE) : 1
  usePageClamp(page, data ? totalPages : page, setPage)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['duplicate-group'] })
    queryClient.invalidateQueries({ queryKey: ['duplicates'] })
    queryClient.invalidateQueries({ queryKey: ['media'] })
    queryClient.invalidateQueries({ queryKey: ['related-pick'] })
  }

  const addMutation = useMutation({
    mutationFn: (ids: number[]) => markRelated(sourceId, ids, kind),
    onSuccess: () => {
      setLocalId('')
      invalidate()
    },
  })

  const markMutation = useMutation({
    mutationFn: ({ ids, markKind }: { ids: number[]; markKind: 'identical' | 'similar' }) =>
      markRelated(sourceId, ids, markKind),
    onSuccess: () => setSelectedIds([]),
    onSettled: invalidate,
  })

  const parsedId = /^\d+$/.test(localId) ? Number(localId) : null
  const markBusy = addMutation.isPending || markMutation.isPending

  const openPicker = () => {
    setPickerOpen(true)
    enterSelectMode()
  }

  const closePicker = () => {
    setPickerOpen(false)
    exitSelectMode()
  }

  const handleMarkSelected = async (markKind: 'identical' | 'similar') => {
    if (selectedIds.length < 1) return
    const ok = await confirm({
      title: markKind === 'identical' ? 'Mark as identical?' : 'Mark as similar?',
      message: `Link ${selectedIds.length} file(s) to this one as ${markKind}. The earliest file stays the primary.`,
      confirmLabel: 'Mark',
    })
    if (ok) markMutation.mutate({ ids: [...selectedIds], markKind })
  }

  const markError =
    markMutation.isError && markMutation.error instanceof Error
      ? markMutation.error.message
      : markMutation.isError
        ? 'Could not add related files'
        : null

  const showLoading = pickerOpen && (hideExcluded === null || isLoading || (isFetching && !data))

  return (
    <div className="related-pick">
      {!pickerOpen && (
        <>
          <form
            className="duplicate-mark"
            onSubmit={(event) => {
              event.preventDefault()
              if (parsedId != null) addMutation.mutate([parsedId])
            }}
          >
            <input
              value={localId}
              onChange={(event) => setLocalId(event.target.value.replace(/\D/g, ''))}
              placeholder="Database id"
              aria-label="Database id"
              inputMode="numeric"
            />
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as 'identical' | 'similar')}
              aria-label="Relation"
            >
              <option value="identical">Identical</option>
              <option value="similar">Similar</option>
            </select>
            <button type="submit" className="btn btn-small" disabled={markBusy || parsedId == null}>
              {addMutation.isPending ? 'Adding…' : 'Add'}
            </button>
            <button type="button" className="btn btn-small" onClick={openPicker}>
              Select a file
            </button>
          </form>
          {addMutation.isError && (
            <p className="error">
              {addMutation.error instanceof Error
                ? addMutation.error.message
                : 'Could not add related file'}
            </p>
          )}
        </>
      )}

      {pickerOpen && (
        <MediaCollectionView
          items={items}
          gridClassName={`media-grid media-grid-related${isFetching && data ? ' media-grid-refreshing' : ''}${
            selectMode ? ' recent-scrape-selecting' : ''
          }`}
          tagFilter={{
            selectedTags,
            onToggle: (name) => {
              setPage(1)
              setSelectedTags((prev) =>
                prev.includes(name) ? prev.filter((tag) => tag !== name) : [...prev, name],
              )
            },
            expanded: tagsExpanded,
            onExpandedChange: setTagsExpanded,
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
              <>
                <button type="button" className="btn btn-small btn-primary" onClick={closePicker}>
                  Done selecting
                </button>
                <button
                  type="button"
                  className={`btn btn-small${hideExcluded && hasHiddenConfig ? ' btn-primary' : ''}`}
                  disabled={hideExcluded === null || !hasHiddenConfig}
                  title={
                    hasHiddenConfig
                      ? undefined
                      : 'Choose hidden tags or groups in Settings → Hidden tags'
                  }
                  onClick={() => {
                    setHideExcluded((on) => !on)
                    setPage(1)
                  }}
                >
                  {hideExcluded === null
                    ? 'Hidden tags'
                    : hideExcluded
                      ? 'Show hidden tags'
                      : 'Hide hidden tags'}
                </button>
              </>
            ),
          }}
          beforeGrid={
            <MediaBulkBar
              selectedCount={selectedIds.length}
              busy={markBusy}
              markError={markError}
              markMin={1}
              onMark={(markKind) => void handleMarkSelected(markKind)}
            />
          }
          empty={
            showLoading ? (
              <div className="empty">Loading...</div>
            ) : error ? (
              <div className="error">Failed to load media</div>
            ) : data && items.length === 0 && !isFetching ? (
              <div className="empty">No other files match these tags.</div>
            ) : null
          }
          renderItem={(item) => (
            <RelatedCard
              item={item}
              selectMode={selectMode}
              selected={selectedIds.includes(item.id)}
              onSelectPointerDown={onSelectPointerDown}
            />
          )}
          pagination={{
            page,
            totalPages,
            total: data?.total ?? 0,
            onPageChange: setPage,
          }}
        />
      )}
    </div>
  )
}
