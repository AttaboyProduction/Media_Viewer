import { useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchAppSettings, fetchTags } from '../api/client'
import type { MediaItem, MediaTag } from '../types'
import { DEFAULT_APP_SETTINGS, type TagsSortMode } from '../types/appSettings'
import { mediaForPageTagList } from '../utils/contentHide'
import { arrangeBySelectDisplayMode } from '../utils/tagSelectDisplay'
import { sortTags, tagToMediaTag } from '../utils/tagSort'
import CollapsibleTagChipList from './CollapsibleTagChipList'
import TagListSearch from './TagListSearch'

function collectPageTags(
  items: MediaItem[],
  selectedTags: string[],
  mode: TagsSortMode,
  catalogByName: Map<string, MediaTag>,
): MediaTag[] {
  const map = new Map<string, MediaTag>()
  for (const item of items) {
    for (const tag of item.tags) {
      map.set(tag.name, {
        ...tag,
        groups: tag.groups ?? (tag.group ? [tag.group] : []),
        display_names: tag.display_names?.length ? tag.display_names : [tag.name],
        sort_order: tag.sort_order ?? 0,
      })
    }
  }
  for (const name of selectedTags) {
    if (!map.has(name)) {
      const known = catalogByName.get(name)
      map.set(
        name,
        known ?? {
          id: -1,
          name,
          group: null,
          groups: [],
          display_names: [name],
          color: '#bdc3c7',
          is_manual: false,
          sort_order: 0,
        },
      )
    }
  }
  return sortTags([...map.values()], mode)
}

function withSelected(matches: MediaTag[], selected: MediaTag[]): MediaTag[] {
  const names = new Set(matches.map((tag) => tag.name))
  const extra = selected.filter((tag) => !names.has(tag.name))
  return extra.length ? [...matches, ...extra] : matches
}

interface Props {
  items: MediaItem[]
  selectedTags: string[]
  onToggle: (name: string) => void
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  toolbarActions?: ReactNode
  onClearSelected?: () => void
  tagMode: 'and' | 'or'
  onTagModeChange: (mode: 'and' | 'or') => void
}

export default function TagFilterPanel({
  items,
  selectedTags,
  onToggle,
  expanded,
  onExpandedChange,
  toolbarActions,
  onClearSelected,
  tagMode,
  onTagModeChange,
}: Props) {
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 60_000,
  })
  const { data: libraryTags, isSuccess: catalogReady } = useQuery({
    queryKey: ['tags'],
    queryFn: fetchTags,
    staleTime: 60_000,
  })
  const prefs = appSettings ?? DEFAULT_APP_SETTINGS
  const sortMode = prefs.tags_sort_mode
  const displayMode = prefs.tags_select_display_mode
  const hideRules = prefs.content_hide_rules
  const revealedRuleIds = prefs.content_hide_revealed_rule_ids

  const catalog = useMemo(
    () =>
      sortTags(
        (libraryTags ?? []).filter((tag) => !tag.is_deleted).map((tag) => tagToMediaTag(tag)),
        sortMode,
      ),
    [libraryTags, sortMode],
  )
  const catalogByName = useMemo(() => {
    const map = new Map<string, MediaTag>()
    for (const tag of catalog) map.set(tag.name, tag)
    return map
  }, [catalog])

  const tags = useMemo(() => {
    const visible = mediaForPageTagList(items, hideRules, revealedRuleIds)
    return collectPageTags(visible, selectedTags, sortMode, catalogByName)
  }, [items, hideRules, revealedRuleIds, selectedTags, sortMode, catalogByName])

  const { list, panel } = useMemo(
    () => arrangeBySelectDisplayMode(tags, selectedTags, (t) => t.name, displayMode),
    [tags, selectedTags, displayMode],
  )

  const hasTags = tags.length > 0 || catalog.length > 0
  if (!hasTags && !toolbarActions) return null
  const selectedOnPage = tags.filter((tag) => selectedTags.includes(tag.name))

  return (
    <div className="viewer-tag-filter">
      <TagListSearch
        items={list}
        searchCatalog={catalogReady ? catalog : undefined}
        placeholder="Search all tags..."
        toolbarActions={toolbarActions}
        disabled={!hasTags}
        separateGroupSearch
        tagMode={tagMode}
        onTagModeChange={onTagModeChange}
        onClearSelected={selectedTags.length > 0 ? onClearSelected : undefined}
        onSuggestPick={onToggle}
      >
        {(filteredList, filtersActive) => {
          const shown = filtersActive
            ? arrangeBySelectDisplayMode(
                withSelected(filteredList, selectedOnPage),
                selectedTags,
                (tag) => tag.name,
                displayMode,
              )
            : { list: filteredList, panel }
          if (shown.list.length === 0 && shown.panel.length === 0 && !filtersActive) return null
          return (
            <CollapsibleTagChipList
              tags={shown.list}
              selectedPanelTags={shown.panel}
              onTagClick={onToggle}
              activeNames={selectedTags}
              expanded={expanded}
              onExpandedChange={onExpandedChange}
              emptyMessage={filtersActive ? 'No tags match this search' : 'No tags match'}
            />
          )
        }}
      </TagListSearch>
    </div>
  )
}
