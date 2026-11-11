import { useMemo, useState, type KeyboardEventHandler } from 'react'
import type { TagGroup } from '../types'
import { matchesTagSearch, type SearchMatchMode } from '../utils/tagSort'
import GroupChip from './GroupChip'
import SearchBar from './SearchBar'
import TagSearchSuggest from './TagSearchSuggest'

interface Props {
  search: string
  onSearchChange: (value: string) => void
  matchMode: SearchMatchMode
  onMatchModeChange: (mode: SearchMatchMode) => void
  groups: TagGroup[]
  groupFilterIds: ReadonlySet<number>
  onToggleGroup: (groupId: number) => void
  onClearGroups: () => void
  placeholder?: string
  onSearchKeyDown?: KeyboardEventHandler<HTMLInputElement>
  /** Group chips live in a separate Search groups panel on media grids. */
  showGroups?: boolean
  /** Full-width search with Contains/Exact under the input. */
  stackedSearch?: boolean
}

/** Search bar + tag-group chips — same controls as Tags page / media TagEditor. */
export default function TagSearchFilters({
  search,
  onSearchChange,
  matchMode,
  onMatchModeChange,
  groups,
  groupFilterIds,
  onToggleGroup,
  onClearGroups,
  placeholder = 'Search tags...',
  onSearchKeyDown,
  showGroups = true,
  stackedSearch = false,
}: Props) {
  const allGroupsActive = groupFilterIds.size === 0

  return (
    <>
      <SearchBar
        value={search}
        onChange={onSearchChange}
        mode={matchMode}
        onModeChange={onMatchModeChange}
        placeholder={placeholder}
        inputClassName="tag-add-search"
        onKeyDown={onSearchKeyDown}
        stacked={stackedSearch}
      />
      {showGroups && (
        <div className="tag-add-group-filters">
          <button
            type="button"
            className={`tag-group-filter-btn text-filter${allGroupsActive ? ' active' : ''}`}
            onClick={onClearGroups}
          >
            All groups
          </button>
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className={`tag-group-filter-btn${groupFilterIds.has(group.id) ? ' active' : ''}`}
              onClick={() => onToggleGroup(group.id)}
            >
              <GroupChip group={group} small />
            </button>
          ))}
        </div>
      )}
    </>
  )
}

/** Group-name search plus chips. Selected groups stay listed when the search hides them. */
export function GroupFilterPanel({
  groups,
  groupFilterIds,
  onToggleGroup,
  onClearGroups,
  includeAllTags = false,
  onIncludeAllTags,
  stackedSearch = false,
}: {
  groups: TagGroup[]
  groupFilterIds: ReadonlySet<number>
  onToggleGroup: (groupId: number) => void
  onClearGroups: () => void
  /** When set, the panel can widen a page-tag list to every tag in the selected groups. */
  includeAllTags?: boolean
  onIncludeAllTags?: () => void
  stackedSearch?: boolean
}) {
  const [search, setSearch] = useState('')
  const [matchMode, setMatchMode] = useState<SearchMatchMode>('contains')
  const visible = useMemo(() => {
    const matched = groups.filter(
      (group) =>
        matchesTagSearch(group.label, search, matchMode) ||
        matchesTagSearch(group.key, search, matchMode),
    )
    const matchedIds = new Set(matched.map((group) => group.id))
    const selected = groups.filter((group) => groupFilterIds.has(group.id) && !matchedIds.has(group.id))
    return [...selected, ...matched]
  }, [groups, search, matchMode, groupFilterIds])

  return (
    <>
      <SearchBar
        value={search}
        onChange={setSearch}
        mode={matchMode}
        onModeChange={setMatchMode}
        placeholder="Search groups..."
        inputClassName="tag-add-search"
        stacked={stackedSearch}
      />
      {search.trim() && (
        <TagSearchSuggest
          query={search}
          items={visible.map((group) => ({
            id: group.id,
            name: group.label,
            color: group.default_color,
          }))}
          onPick={(name) => {
            const group = groups.find((item) => item.label === name || item.key === name)
            if (group) onToggleGroup(group.id)
          }}
        />
      )}
      <div className="tag-add-group-filters">
        <button
          type="button"
          className={`tag-group-filter-btn text-filter${groupFilterIds.size === 0 ? ' active' : ''}`}
          onClick={onClearGroups}
        >
          All groups
        </button>
        {visible.map((group) => (
          <button
            key={group.id}
            type="button"
            className={`tag-group-filter-btn${groupFilterIds.has(group.id) ? ' active' : ''}`}
            onClick={() => onToggleGroup(group.id)}
          >
            <GroupChip group={group} small />
          </button>
        ))}
        {onIncludeAllTags && (
          <button
            type="button"
            className={`btn btn-small tag-group-include-all${includeAllTags ? ' btn-primary' : ''}`}
            onClick={onIncludeAllTags}
            aria-pressed={includeAllTags}
            title="Show every tag in the selected groups, not only tags on this page"
          >
            Include all tags
          </button>
        )}
      </div>
    </>
  )
}
