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

  return (
    <div className="tag-picker-select-panel">
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
        placeholder={searchPlaceholder}
        toolbarActions={toolbarActions}
        disabled={candidates.length === 0}
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
        {(filteredList, filtersActive) => (
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
        )}
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
}

export function SearchableTagSingleSelect({
  tags,
  selectedId,
  onChange,
  excludeIds = [],
  searchPlaceholder = 'Search tags...',
  emptyLabel = 'No matching tags',
  toolbarActions,
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
        onSuggestPick={(name) => {
          const tag = candidates.find((item) => item.name === name)
          if (tag) onChange(tag.id)
        }}
      >
        {(filteredList, filtersActive) => (
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
        )}
      </TagListSearch>
    </div>
  )
}
