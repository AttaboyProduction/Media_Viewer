import type { TagsSelectDisplayMode } from '../types/appSettings'

/**
 * Split/reorder items for tag/group multi-select display modes.
 * - highlight: leave order, selected stay in list
 * - front: selected first (selection order), then the rest
 * - panel: selected only in panel; list is unselected only
 */
export function arrangeBySelectDisplayMode<T>(
  items: T[],
  selectedKeys: Iterable<string | number>,
  getKey: (item: T) => string | number,
  mode: TagsSelectDisplayMode,
): { list: T[]; panel: T[] } {
  const selected = [...selectedKeys]
  const selectedSet = new Set(selected)
  const byKey = new Map(items.map((item) => [getKey(item), item]))
  const panel = selected
    .map((key) => byKey.get(key))
    .filter((item): item is T => item != null)

  if (mode === 'panel') {
    return {
      panel,
      list: items.filter((item) => !selectedSet.has(getKey(item))),
    }
  }

  if (mode === 'front') {
    const rest = items.filter((item) => !selectedSet.has(getKey(item)))
    return { panel: [], list: [...panel, ...rest] }
  }

  return { panel: [], list: items }
}
