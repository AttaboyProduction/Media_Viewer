import { useCallback, useMemo, useState } from 'react'
import {
  matchesTagSearch,
  tagBelongsToGroups,
  type SearchMatchMode,
} from '../utils/tagSort'

export interface SearchableTag {
  name: string
  group: { id: number } | null
  groups?: { id: number }[] | null
}

/** Search text + match mode + group filter state shared by every tag search surface. */
export function useTagSearch() {
  const [search, setSearch] = useState('')
  const [matchMode, setMatchMode] = useState<SearchMatchMode>('contains')
  const [groupFilterIds, setGroupFilterIds] = useState<Set<number>>(() => new Set())

  const toggleGroup = useCallback((groupId: number) => {
    setGroupFilterIds((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])
  const clearGroups = useCallback(() => setGroupFilterIds(new Set()), [])

  const matches = useCallback(
    (tag: SearchableTag) =>
      tagBelongsToGroups(tag, groupFilterIds) && matchesTagSearch(tag.name, search, matchMode),
    [groupFilterIds, search, matchMode],
  )

  const active = search.trim().length > 0 || groupFilterIds.size > 0

  /** Spread into `<TagSearchFilters groups={...} {...filterProps} />`. */
  const filterProps = useMemo(
    () => ({
      search,
      onSearchChange: setSearch,
      matchMode,
      onMatchModeChange: setMatchMode,
      groupFilterIds,
      onToggleGroup: toggleGroup,
      onClearGroups: clearGroups,
    }),
    [search, matchMode, groupFilterIds, toggleGroup, clearGroups],
  )

  return { search, setSearch, matchMode, groupFilterIds, matches, active, filterProps }
}
