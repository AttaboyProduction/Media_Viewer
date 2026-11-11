import type { MediaTag, Tag, TagGroup } from '../types'
import type { TagsSortMode } from '../types/appSettings'

export const TWO_LINE_MAX_HEIGHT = 'calc(2 * 1.25rem + 0.15rem)'

/** Collapsed lists only show two lines, so rendering thousands of hidden chips is wasted work. */
export const COLLAPSED_CHIP_RENDER_LIMIT = 120

export function tagSortKey(
  tag: { group: TagGroup | null; name: string; sort_order?: number },
  mode: TagsSortMode = 'order',
): [number, number, number | string] {
  const groupOrder = tag.group ? (tag.group.sort_order ?? 0) : 9999
  const groupBucket = tag.group ? 0 : 1
  if (mode === 'order') {
    return [groupBucket, groupOrder, tag.sort_order ?? 0]
  }
  return [groupBucket, groupOrder, tag.name]
}

export function sortTags<T extends { group: TagGroup | null; name: string; sort_order?: number }>(
  tags: T[],
  mode: TagsSortMode = 'order',
): T[] {
  return [...tags].sort((a, b) => {
    const ka = tagSortKey(a, mode)
    const kb = tagSortKey(b, mode)
    const groupCmp = (ka[0] as number) - (kb[0] as number) || (ka[1] as number) - (kb[1] as number)
    if (groupCmp !== 0) return groupCmp
    if (mode === 'order') {
      return (ka[2] as number) - (kb[2] as number) || a.name.localeCompare(b.name)
    }
    return (ka[2] as string).localeCompare(kb[2] as string)
  })
}

export type SearchMatchMode = 'contains' | 'exact'

export function normalizeTagQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, '_')
}

export function matchesTagSearch(
  name: string,
  query: string,
  mode: SearchMatchMode = 'contains',
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const asToken = normalizeTagQuery(query)
  const n = name.toLowerCase()
  const nSpaced = n.replace(/_/g, ' ')
  const qSpaced = q.replace(/_/g, ' ')
  if (mode === 'exact') {
    return n === asToken || n === q || nSpaced === qSpaced
  }
  return n.includes(asToken) || n.includes(q) || nSpaced.includes(qSpaced)
}

export function tagBelongsToGroups(
  tag: { group: { id: number } | null; groups?: { id: number }[] | null },
  groupIds: ReadonlySet<number>,
): boolean {
  if (groupIds.size === 0) return true
  if (tag.group && groupIds.has(tag.group.id)) return true
  return tag.groups?.some((g) => groupIds.has(g.id)) ?? false
}

export function tagToMediaTag(tag: Tag, options?: { useAliasDisplay?: boolean }): MediaTag {
  const useAliasDisplay = options?.useAliasDisplay ?? false
  const display_names =
    useAliasDisplay && tag.aliases?.length ? tag.aliases : [tag.name]
  return {
    id: tag.id,
    name: tag.name,
    group: tag.group,
    groups: tag.groups ?? (tag.group ? [tag.group] : []),
    display_names,
    color: tag.color,
    is_manual: false,
    sort_order: tag.sort_order ?? 0,
  }
}
