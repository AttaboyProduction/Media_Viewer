import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchTagGroups } from '../api/client'
import { useTagSearch, type SearchableTag } from '../hooks/useTagSearch'
import { registerEscapeHandler } from '../utils/escapeStack'
import { matchesTagSearch, tagBelongsToGroups } from '../utils/tagSort'
import TagSearchFilters, { GroupFilterPanel } from './TagSearchFilters'
import TagSearchSuggest from './TagSearchSuggest'

interface Props<T extends SearchableTag> {
  items: T[]
  children: (filteredItems: T[], filtersActive: boolean) => ReactNode
  placeholder?: string
  toolbarActions?: ReactNode
  disabled?: boolean
  /** Shown only when the parent passes it (callers pass it while any tags are selected). */
  onClearSelected?: () => void
  /**
   * Media grids keep group filtering in its own panel.
   * Tag pickers leave this off and keep groups inside Search tags.
   */
  separateGroupSearch?: boolean
  /**
   * Full library tag list. Text search uses it immediately.
   * A group filter stays on `items` until Include all tags is turned on.
   */
  searchCatalog?: T[]
  /** When set, the toolbar shows AND / OR for how selected tags combine. */
  tagMode?: 'and' | 'or'
  onTagModeChange?: (mode: 'and' | 'or') => void
  /** Short labels for the viewer sidebar. */
  compact?: boolean
  onSuggestPick?: (name: string) => void
}

/** Shared collapsible search + group-filter toolbar for tag lists and pickers. */
export default function TagListSearch<T extends SearchableTag>({
  items,
  children,
  placeholder = 'Search tags...',
  toolbarActions,
  disabled = false,
  onClearSelected,
  separateGroupSearch = false,
  searchCatalog,
  tagMode = 'and',
  onTagModeChange,
  compact = false,
  onSuggestPick,
}: Props<T>) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [groupSearchOpen, setGroupSearchOpen] = useState(false)
  const [includeAllGroupTags, setIncludeAllGroupTags] = useState(false)
  const { search, matchMode, groupFilterIds, matches, active, filterProps } = useTagSearch()
  const { data: groups = [] } = useQuery({
    queryKey: ['tag-groups'],
    queryFn: fetchTagGroups,
    staleTime: 60_000,
  })

  const textActive = searchOpen && search.trim().length > 0
  const groupActive = groupFilterIds.size > 0
  const filtersActive = separateGroupSearch ? textActive || groupActive : searchOpen && active
  // Text search always uses the library. A group filter uses the current page until Include all tags.
  const useCatalog =
    Boolean(searchCatalog) &&
    (separateGroupSearch
      ? textActive || (includeAllGroupTags && groupActive)
      : filtersActive)
  const source = useCatalog && searchCatalog ? searchCatalog : items
  const filteredItems = useMemo(() => {
    if (!filtersActive) return items
    if (!separateGroupSearch) return source.filter(matches)
    return source.filter((tag) => {
      if (groupActive && !tagBelongsToGroups(tag, groupFilterIds)) return false
      if (textActive && !matchesTagSearch(tag.name, search, matchMode)) return false
      return true
    })
  }, [
    items,
    source,
    filtersActive,
    separateGroupSearch,
    matches,
    groupActive,
    groupFilterIds,
    textActive,
    search,
    matchMode,
  ])

  useEffect(() => {
    if (!groupActive && includeAllGroupTags) setIncludeAllGroupTags(false)
  }, [groupActive, includeAllGroupTags])

  useEffect(() => {
    if (!searchOpen) return
    return registerEscapeHandler(() => setSearchOpen(false))
  }, [searchOpen])

  useEffect(() => {
    if (!groupSearchOpen) return
    return registerEscapeHandler(() => setGroupSearchOpen(false))
  }, [groupSearchOpen])

  const showGroupSearch = separateGroupSearch && groups.length > 0

  return (
    <>
      <div className="tag-filter-toolbar">
        <button
          type="button"
          className={`btn btn-small${searchOpen ? ' btn-primary' : ''}`}
          disabled={disabled}
          onClick={() => setSearchOpen((open) => !open)}
          aria-expanded={searchOpen}
          aria-label={searchOpen ? 'Hide tag search' : 'Search tags'}
        >
          {compact ? (searchOpen ? 'Hide' : 'Tags') : searchOpen ? 'Hide search' : 'Search tags'}
        </button>
        {onTagModeChange && (
          <div className="search-match-toggle" role="group" aria-label="How selected tags combine">
            <button
              type="button"
              className={`search-match-btn${tagMode === 'and' ? ' active' : ''}`}
              onClick={() => onTagModeChange('and')}
              title="Media must include every selected tag"
            >
              AND
            </button>
            <button
              type="button"
              className={`search-match-btn${tagMode === 'or' ? ' active' : ''}`}
              onClick={() => onTagModeChange('or')}
              title="Media may include any selected tag"
            >
              OR
            </button>
          </div>
        )}
        {showGroupSearch && (
          <button
            type="button"
            className={`btn btn-small${groupSearchOpen ? ' btn-primary' : ''}`}
            onClick={() => setGroupSearchOpen((open) => !open)}
            aria-expanded={groupSearchOpen}
            aria-label={groupSearchOpen ? 'Hide group search' : 'Search groups'}
          >
            {compact
              ? groupSearchOpen
                ? 'Hide'
                : 'Groups'
              : groupSearchOpen
                ? 'Hide groups'
                : 'Search groups'}
          </button>
        )}
        {toolbarActions && (
          <div className="tag-filter-toolbar-actions">{toolbarActions}</div>
        )}
        {filtersActive && (
          <span className="tag-filter-toolbar-hint">
            {filteredItems.length} of {source.length}
          </span>
        )}
        {onClearSelected && (
          <button
            type="button"
            className={`btn btn-small${compact ? ' tag-filter-clear-end' : ''}`}
            onClick={onClearSelected}
            title="Clear selected"
            aria-label="Clear selected"
          >
            {compact ? 'X' : 'Clear selected'}
          </button>
        )}
      </div>

      {showGroupSearch && groupSearchOpen && (
        <div className="tag-add-panel tag-filter-search-panel">
          <GroupFilterPanel
            groups={groups}
            groupFilterIds={filterProps.groupFilterIds}
            onToggleGroup={filterProps.onToggleGroup}
            onClearGroups={filterProps.onClearGroups}
            stackedSearch={compact}
            includeAllTags={includeAllGroupTags}
            onIncludeAllTags={
              searchCatalog && !textActive && groupActive
                ? () => setIncludeAllGroupTags((on) => !on)
                : undefined
            }
          />
        </div>
      )}

      {searchOpen && !disabled && (
        <div className="tag-add-panel tag-filter-search-panel">
          <TagSearchFilters
            groups={groups}
            placeholder={placeholder}
            showGroups={!separateGroupSearch}
            stackedSearch={compact}
            {...filterProps}
          />
          {textActive && onSuggestPick && (
            <TagSearchSuggest
              query={search}
              items={filteredItems.map((tag, index) => {
                const extra = tag as T & { id?: number; color?: string; usage_count?: number }
                return {
                  id: extra.id ?? `${tag.name}-${index}`,
                  name: tag.name,
                  color: extra.color,
                  usage_count: extra.usage_count,
                }
              })}
              onPick={onSuggestPick}
            />
          )}
        </div>
      )}

      {children(filteredItems, filtersActive)}
    </>
  )
}
