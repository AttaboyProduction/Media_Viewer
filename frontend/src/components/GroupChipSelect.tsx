import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchAppSettings } from '../api/client'
import type { TagGroup } from '../types'
import { DEFAULT_APP_SETTINGS } from '../types/appSettings'
import { arrangeBySelectDisplayMode } from '../utils/tagSelectDisplay'
import { matchesTagSearch, type SearchMatchMode } from '../utils/tagSort'
import GroupChip from './GroupChip'
import SearchBar from './SearchBar'

interface MultiProps {
  groups: TagGroup[]
  selectedIds: number[]
  onChange: (ids: number[]) => void
  excludeIds?: number[]
  searchPlaceholder?: string
  emptyLabel?: string
  showSelectedPanel?: boolean
}

export function SearchableGroupMultiSelect({
  groups,
  selectedIds,
  onChange,
  excludeIds = [],
  searchPlaceholder = 'Search groups...',
  emptyLabel = 'No matching groups',
  showSelectedPanel = true,
}: MultiProps) {
  const [search, setSearch] = useState('')
  const [matchMode, setMatchMode] = useState<SearchMatchMode>('contains')
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 60_000,
  })
  const displayMode =
    appSettings?.tags_select_display_mode ?? DEFAULT_APP_SETTINGS.tags_select_display_mode
  const excluded = useMemo(() => new Set(excludeIds), [excludeIds])
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])

  const candidates = useMemo(
    () =>
      [...groups]
        .filter((g) => !excluded.has(g.id))
        .filter(
          (g) =>
            matchesTagSearch(g.label, search, matchMode) ||
            matchesTagSearch(g.key, search, matchMode),
        )
        .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label)),
    [groups, excluded, search, matchMode],
  )

  const { list, panel } = useMemo(
    () => arrangeBySelectDisplayMode(candidates, selectedIds, (g) => g.id, displayMode),
    [candidates, selectedIds, displayMode],
  )

  const showPanel = showSelectedPanel && displayMode === 'panel' && panel.length > 0

  const toggle = (id: number) => {
    if (selected.has(id)) onChange(selectedIds.filter((x) => x !== id))
    else onChange([...selectedIds, id])
  }

  return (
    <div className="tag-picker-select-panel">
      {showPanel && (
        <div className="tag-picker-selected" aria-label="Selected groups">
          {panel.map((group) => (
            <button
              key={group.id}
              type="button"
              className="group-chip-select-btn active"
              onClick={() => toggle(group.id)}
            >
              <GroupChip group={group} small />
            </button>
          ))}
        </div>
      )}
      <SearchBar
        value={search}
        onChange={setSearch}
        mode={matchMode}
        onModeChange={setMatchMode}
        placeholder={searchPlaceholder}
        inputClassName="tag-add-search"
      />
      {list.length === 0 ? (
        <p className="tag-picker-empty">
          {panel.length > 0 && !search.trim() ? 'All matching groups are selected' : emptyLabel}
        </p>
      ) : (
        <div className="group-chip-select-grid">
          {list.map((group) => (
            <button
              key={group.id}
              type="button"
              className={`group-chip-select-btn${selected.has(group.id) ? ' active' : ''}`}
              onClick={() => toggle(group.id)}
            >
              <GroupChip group={group} small />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface SingleProps {
  groups: TagGroup[]
  selectedId: number | ''
  onChange: (id: number | '') => void
  excludeIds?: number[]
  searchPlaceholder?: string
  emptyLabel?: string
}

export function SearchableGroupSingleSelect({
  groups,
  selectedId,
  onChange,
  excludeIds = [],
  searchPlaceholder = 'Search groups...',
  emptyLabel = 'No matching groups',
}: SingleProps) {
  const [search, setSearch] = useState('')
  const [matchMode, setMatchMode] = useState<SearchMatchMode>('contains')
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
    () =>
      [...groups]
        .filter((g) => !excluded.has(g.id))
        .filter(
          (g) =>
            matchesTagSearch(g.label, search, matchMode) ||
            matchesTagSearch(g.key, search, matchMode),
        )
        .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label)),
    [groups, excluded, search, matchMode],
  )

  const { list, panel } = useMemo(
    () => arrangeBySelectDisplayMode(candidates, selectedIds, (g) => g.id, displayMode),
    [candidates, selectedIds, displayMode],
  )

  const showPanel = displayMode === 'panel' && panel.length > 0

  return (
    <div className="tag-picker-select-panel">
      {showPanel && (
        <div className="tag-picker-selected" aria-label="Selected group">
          {panel.map((group) => (
            <button
              key={group.id}
              type="button"
              className="group-chip-select-btn active"
              onClick={() => onChange('')}
            >
              <GroupChip group={group} small />
            </button>
          ))}
        </div>
      )}
      <SearchBar
        value={search}
        onChange={setSearch}
        mode={matchMode}
        onModeChange={setMatchMode}
        placeholder={searchPlaceholder}
        inputClassName="tag-add-search"
      />
      {list.length === 0 ? (
        <p className="tag-picker-empty">
          {panel.length > 0 && !search.trim() ? 'All matching groups are selected' : emptyLabel}
        </p>
      ) : (
        <div className="group-chip-select-grid">
          {list.map((group) => (
            <button
              key={group.id}
              type="button"
              className={`group-chip-select-btn${selectedId === group.id ? ' active' : ''}`}
              onClick={() => onChange(selectedId === group.id ? '' : group.id)}
            >
              <GroupChip group={group} small />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
