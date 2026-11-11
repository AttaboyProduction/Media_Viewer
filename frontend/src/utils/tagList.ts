export function parseCommaSeparatedTags(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function joinCommaSeparatedTags(names: string[]): string {
  return names.join(', ')
}

export function tagBelongsToGroupKeys(
  tag: { group: { key: string } | null; groups?: { key: string }[] | null },
  groupKeys: string[],
): boolean {
  if (groupKeys.length === 0) return false
  const keys = new Set(groupKeys)
  if (tag.group && keys.has(tag.group.key)) return true
  return tag.groups?.some((g) => keys.has(g.key)) ?? false
}

export function expandHiddenTags(
  tagNames: string[],
  groupKeys: string[],
  allTags: { name: string; group: { key: string } | null; groups?: { key: string }[] | null }[],
): string[] {
  const fromGroups = allTags
    .filter((t) => tagBelongsToGroupKeys(t, groupKeys))
    .map((t) => t.name)
  return [...new Set([...tagNames, ...fromGroups])]
}
