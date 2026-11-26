import { useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchAppSettings } from '../api/client'
import type { Tag } from '../types'
import { DEFAULT_APP_SETTINGS } from '../types/appSettings'
import { arrangeBySelectDisplayMode } from '../utils/tagSelectDisplay'
import CollapsibleTagChipSelectList from './CollapsibleTagChipSelectList'
import TagListSearch from './TagListSearch'
import TagChip, { type TagChipData } from './TagChip'

function tagToChip(tag: Tag): TagChipData {
  return {
    name: tag.name,
    color: tag.color,
    group: tag.group,
    is_manual: false,
  }
}

interface MultiProps {
  tags: Tag[]
  selectedIds: number[]
  onChange: (ids: number[]) => void
  excludeIds?: number[]
  searchPlaceholder?: string
  emptyLabel?: string
  toolbarActions?: ReactNode
  /**
   * When false, never render the selected panel (parent already shows selection).
   * List arrangement still follows tags_select_display_mode.
   */
  showSelectedPanel?: boolean
  /** Hide the chip cloud until Search tags is open and the query is non-empty. */
  chipsOnlyWhileSearching?: boolean
  /** When false, only the Search tags toolbar (and optional actions) — no chip list. */
  showChipList?: boolean
  /** Group filter in its own Search groups panel (media grid style). */
  separateGroupSearch?: boolean
  /** Full tag catalog for search while the chip list stays page-scoped. */
  searchCatalog?: Tag[]
  pinnedSearch?: boolean
  /** Suggest list floats under the search field (scrape filters). */
  suggestOverlay?: boolean
  panelClassName?: string
}

export function SearchableTagMultiSelect({
  tags,
  selectedIds,
  onChange,
  excludeIds = [],
  searchPlaceholder = 'Search tags...',
  emptyLabel = 'No matching tags',
  toolbarActions,
  showSelectedPanel = true,
  chipsOnlyWhileSearching = false,
  showChipList = true,
  separateGroupSearch = false,
  searchCatalog,
  pinnedSearch = false,
  suggestOverlay = false,
  panelClassName,
}: MultiProps) {
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 60_000,
  })
  const displayMode =
    appSettings?.tags_select_display_mode ?? DEFAULT_APP_SETTINGS.tags_select_display_mode
  const excluded = useMemo(() => new Set(excludeIds), [excludeIds])

  const candidates = useMemo(
    () => tags.filter((t) => !excluded.has(t.id)),
    [tags, excluded],
  )

  const { list, panel } = useMemo(
    () => arrangeBySelectDisplayMode(candidates, selectedIds, (t) => t.id, displayMode),
    [candidates, selectedIds, displayMode],
  )

  const showPanel = showSelectedPanel && displayMode === 'panel' && panel.length > 0

  const suggestSelectedNames = useMemo(
    () =>
      selectedIds
        .map((id) => tags.find((t) => t.id === id)?.name)
        .filter((name): name is string => Boolean(name)),
    [selectedIds, tags],
  )

  return (
    <div
      className={`tag-picker-select-panel${panelClassName ? ` ${panelClassName}` : ''}`}
    >
      {showPanel && (
        <div className="tag-picker-selected" aria-label="Selected tags">
          {panel.map((tag) => (
            <TagChip
              key={tag.id}
              tag={tagToChip(tag)}
              active
              onClick={() => onChange(selectedIds.filter((x) => x !== tag.id))}
            />
          ))}
        </div>
      )}
      <TagListSearch
        items={list}
        searchCatalog={searchCatalog ?? tags}
        separateGroupSearch={separateGroupSearch}
        pinnedSearch={pinnedSearch}
        suggestOverlay={suggestOverlay}
        placeholder={searchPlaceholder}
        toolbarActions={toolbarActions}
        disabled={candidates.length === 0}
        onClearSelected={selectedIds.length > 0 ? () => onChange([]) : undefined}
        suggestSelectedNames={suggestSelectedNames}
        onSuggestPick={(name) => {
          const tag = candidates.find((item) => item.name === name)
          if (!tag) return
          if (selectedIds.includes(tag.id)) {
            onChange(selectedIds.filter((id) => id !== tag.id))
          } else {
            onChange([...selectedIds, tag.id])
          }
        }}
      >
        {(filteredList, filtersActive, textActive) => {
          if (!showChipList) return null
          if (chipsOnlyWhileSearching && !textActive) return null
          return (
            <CollapsibleTagChipSelectList
              mode="multi"
              tags={filteredList}
              selectedIds={selectedIds}
              onChange={onChange}
              emptyMessage={
                panel.length > 0 && list.length === 0 && !filtersActive
                  ? 'All matching tags are selected'
                  : emptyLabel
              }
            />
          )
        }}
      </TagListSearch>
    </div>
  )
}

interface SingleProps {
  tags: Tag[]
  selectedId: number | ''
  onChange: (id: number | '') => void
  excludeIds?: number[]
  searchPlaceholder?: string
  emptyLabel?: string
  toolbarActions?: ReactNode
  /** Hide the chip cloud until Search tags is open and the query is non-empty. */
  chipsOnlyWhileSearching?: boolean
}

export function SearchableTagSingleSelect({
  tags,
  selectedId,
  onChange,
  excludeIds = [],
  searchPlaceholder = 'Search tags...',
  emptyLabel = 'No matching tags',
  toolbarActions,
  chipsOnlyWhileSearching = false,
}: SingleProps) {
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 60_000,
  })
  const displayMode =
    appSettings?.tags_select_display_mode ?? DEFAULT_APP_SETTINGS.tags_select_display_mode
  const excluded = useMemo(() => new Set(excludeIds), [excludeIds])

  const selectedIds = selectedId === '' ? [] : [selectedId]

  const candidates = useMemo(
    () => tags.filter((t) => !excluded.has(t.id)),
    [tags, excluded],
  )

  const { list, panel } = useMemo(
    () => arrangeBySelectDisplayMode(candidates, selectedIds, (t) => t.id, displayMode),
    [candidates, selectedIds, displayMode],
  )

  const showPanel = displayMode === 'panel' && panel.length > 0

  const suggestSelectedNames = useMemo(() => {
    if (selectedId === '') return []
    const name = tags.find((t) => t.id === selectedId)?.name
    return name ? [name] : []
  }, [selectedId, tags])

  return (
    <div className="tag-picker-select-panel">
      {showPanel && (
        <div className="tag-picker-selected" aria-label="Selected tag">
          {panel.map((tag) => (
            <TagChip
              key={tag.id}
              tag={tagToChip(tag)}
              active
              onClick={() => onChange('')}
            />
          ))}
        </div>
      )}
      <TagListSearch
        items={list}
        placeholder={searchPlaceholder}
        toolbarActions={toolbarActions}
        disabled={candidates.length === 0}
        suggestSelectedNames={suggestSelectedNames}
        onSuggestPick={(name) => {
          const tag = candidates.find((item) => item.name === name)
          if (tag) onChange(tag.id)
        }}
      >
        {(filteredList, filtersActive, textActive) => {
          if (chipsOnlyWhileSearching && !textActive) return null
          return (
            <CollapsibleTagChipSelectList
              mode="single"
              tags={filteredList}
              selectedId={selectedId}
              onChange={onChange}
              emptyMessage={
                panel.length > 0 && list.length === 0 && !filtersActive
                  ? 'All matching tags are selected'
                  : emptyLabel
              }
            />
          )
        }}
      </TagListSearch>
    </div>
  )
}
