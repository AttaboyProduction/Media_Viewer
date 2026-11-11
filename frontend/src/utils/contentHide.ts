import type { ContentHideRule } from '../types/appSettings'

export type ContentHideTagged = {
  tags: Array<{ name: string }>
}

/** Rules that match the item and are not yet revealed. */
export function lockedRulesForMedia(
  rules: ContentHideRule[],
  revealedIds: Iterable<string>,
  item: ContentHideTagged,
): ContentHideRule[] {
  const revealed = new Set(revealedIds)
  const tagNames = new Set(item.tags.map((t) => t.name))
  return rules.filter((rule) => {
    if (revealed.has(rule.id) || rule.tag_names.length === 0) return false
    return rule.tag_names.some((name) => tagNames.has(name))
  })
}

export function isMediaContentHidden(
  rules: ContentHideRule[],
  revealedIds: Iterable<string>,
  item: ContentHideTagged,
): boolean {
  return lockedRulesForMedia(rules, revealedIds, item).length > 0
}

/** Page tag chips/sidebar: only tags from media that is not content-hide locked. */
export function mediaForPageTagList<T extends ContentHideTagged>(
  items: T[],
  rules: ContentHideRule[],
  revealedIds: Iterable<string>,
): T[] {
  return items.filter((item) => !isMediaContentHidden(rules, revealedIds, item))
}

/** Tag names from locked (unrevealed) hide-content rules — for exclude_tags while filtering. */
export function lockedContentHideTagNames(
  rules: ContentHideRule[],
  revealedIds: Iterable<string>,
): string[] {
  const revealed = new Set(revealedIds)
  const names = new Set<string>()
  for (const rule of rules) {
    if (revealed.has(rule.id) || rule.tag_names.length === 0) continue
    for (const name of rule.tag_names) {
      const trimmed = name.trim()
      if (trimmed) names.add(trimmed)
    }
  }
  return [...names]
}

/** When a tag filter is active, merge hide-content tags into exclude_tags so locked files stay out of results. */
export function excludeTagsForMediaQuery(
  selectedTags: string[],
  baseExcludeTags: string[] | undefined,
  rules: ContentHideRule[],
  revealedIds: Iterable<string>,
): string[] | undefined {
  const base = baseExcludeTags ?? []
  const hideTags =
    selectedTags.length > 0 ? lockedContentHideTagNames(rules, revealedIds) : []
  const merged = [...new Set([...base, ...hideTags])]
  return merged.length > 0 ? merged : undefined
}

/** Pending rules for the toolbar (all not-yet-revealed configured rules). */
export function pendingRevealRules(
  rules: ContentHideRule[],
  revealedIds: Iterable<string>,
): ContentHideRule[] {
  const revealed = new Set(revealedIds)
  return rules.filter((rule) => !revealed.has(rule.id) && rule.tag_names.length > 0)
}

export function mergeRevealedRuleIds(
  current: Iterable<string>,
  toAdd: Iterable<string>,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of [...current, ...toAdd]) {
    const rid = String(id).trim()
    if (!rid || seen.has(rid)) continue
    seen.add(rid)
    out.push(rid)
  }
  return out
}

export function newContentHideRuleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `chr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 1-based default label for a new or untitled rule. */
export function defaultContentHideRuleLabel(index: number): string {
  return `Rule #${Math.max(1, Math.floor(index))}`
}
