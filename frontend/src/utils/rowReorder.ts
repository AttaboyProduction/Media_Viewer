import type { DragEvent } from 'react'

export type DropPlacement = 'before' | 'after'

/** Live list preview: place fromId before/after toId. */
export function reorderIdsWithPlacement(
  ids: number[],
  fromId: number,
  toId: number,
  placement: DropPlacement,
): number[] {
  const from = ids.indexOf(fromId)
  let to = ids.indexOf(toId)
  if (from < 0 || to < 0 || fromId === toId) return ids
  const next = [...ids]
  const [item] = next.splice(from, 1)
  if (from < to) to -= 1
  const insertAt = placement === 'after' ? to + 1 : to
  next.splice(insertAt, 0, item)
  return next
}

/** @deprecated Use reorderIdsWithPlacement */
export function reorderIds(ids: number[], fromId: number, toId: number): number[] {
  return reorderIdsWithPlacement(ids, fromId, toId, 'before')
}

export function dropPlacementFromPointer(clientY: number, row: DOMRect): DropPlacement {
  return clientY < row.top + row.height / 2 ? 'before' : 'after'
}

/** Insert-at order for drop: before target uses its order; after uses order+1. */
export function sortOrderForDrop(targetSortOrder: number, placement: DropPlacement): number {
  const order = Math.trunc(targetSortOrder)
  return placement === 'after' ? order + 1 : order
}

/**
 * Whether to show a before/after guide line (cross-island or not a trivial adjacent swap).
 * Always true while hovering a different row — keeps after-unknown unambiguous.
 */
export function shouldShowDropGuide(
  items: Array<{ id: number; sort_order: number }>,
  fromId: number,
  toId: number,
): boolean {
  if (fromId === toId) return false
  const from = items.find((item) => item.id === fromId)
  const to = items.find((item) => item.id === toId)
  if (!from || !to) return false
  const islands = orderIslands(items.map((item) => item.sort_order))
  const fromIsland = islandContaining(islands, from.sort_order)
  const toIsland = islandContaining(islands, to.sort_order)
  if (!fromIsland || !toIsland) return true
  return fromIsland[0] !== toIsland[0] || fromIsland[1] !== toIsland[1]
}

type OrderItem = { id: number; sort_order: number }

function orderIslands(orders: number[]): Array<[number, number]> {
  const uniq = [...new Set(orders.map((o) => Math.trunc(o)))].sort((a, b) => a - b)
  if (uniq.length === 0) return []
  const islands: Array<[number, number]> = []
  let start = uniq[0]
  let prev = uniq[0]
  for (let i = 1; i < uniq.length; i++) {
    const value = uniq[i]
    if (value === prev + 1) {
      prev = value
      continue
    }
    islands.push([start, prev])
    start = prev = value
  }
  islands.push([start, prev])
  return islands
}

function islandContaining(islands: Array<[number, number]>, value: number): [number, number] | null {
  for (const island of islands) {
    if (island[0] <= value && value <= island[1]) return island
  }
  return null
}

function densifyIsland<T extends OrderItem>(items: T[], island: [number, number]): void {
  const [start, end] = island
  const members = items
    .filter((item) => item.sort_order >= start && item.sort_order <= end)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
  members.forEach((item, offset) => {
    item.sort_order = start + offset
  })
}

const ISLAND_GAP_BUMP = 10

/** Amount to move nextStart up so an island ending at neededEnd keeps a 1-slot gap. */
function shiftToClear(neededEnd: number, nextStart: number): number {
  const deficit = neededEnd - (nextStart - 2)
  if (deficit <= 0) return 0
  return Math.ceil(deficit / ISLAND_GAP_BUMP) * ISLAND_GAP_BUMP
}

function pushFrom<T extends OrderItem>(items: T[], fromOrder: number, bump: number): void {
  for (const item of [...items].sort((a, b) => b.sort_order - a.sort_order)) {
    if (item.sort_order >= fromOrder) item.sort_order += bump
  }
}

function densifyAfterRemoval<T extends OrderItem>(
  items: T[],
  removedOrder: number,
  options?: { preserveWhenRemovingStart?: boolean },
): void {
  const preserveWhenRemovingStart = options?.preserveWhenRemovingStart ?? false
  const islands = orderIslands([...items.map((item) => item.sort_order), removedOrder])
  const island = islandContaining(islands, removedOrder)
  if (!island) return
  if (preserveWhenRemovingStart && removedOrder === island[0]) return
  // Removal only shrinks an island, so no later island can be overrun.
  densifyIsland(items, island)
}

function nextIsland(islands: Array<[number, number]>, island: [number, number]): [number, number] | null {
  const idx = islands.findIndex((i) => i[0] === island[0] && i[1] === island[1])
  if (idx < 0 || idx + 1 >= islands.length) return null
  return islands[idx + 1]
}

/** Swap-shift inside an island (keeps it dense; no split). DnD after-last → last slot. */
function moveWithinIsland<T extends OrderItem>(items: T[], item: T, target: number): void {
  const islands = orderIslands(items.map((peer) => peer.sort_order))
  const old = item.sort_order
  const island = islandContaining(islands, old)
  if (!island) {
    item.sort_order = target
    return
  }
  const [start, end] = island
  let dest = target
  if (dest === end + 1) dest = end
  dest = Math.max(start, Math.min(dest, end))
  if (dest === old) return
  for (const other of items) {
    if (other.id === item.id) continue
    const value = other.sort_order
    if (value < start || value > end) continue
    if (dest < old && dest <= value && value < old) other.sort_order = value + 1
    else if (dest > old && old < value && value <= dest) other.sort_order = value - 1
  }
  item.sort_order = dest
  densifyIsland(items, island)
}

function insertIntoIsland<T extends OrderItem>(items: T[], newItem: T, target: number): void {
  const others = items.filter((item) => item.id !== newItem.id)
  const islands = orderIslands(others.map((item) => item.sort_order))

  // Drop-before (target == start) or explicit start-1: join at start-1 without shifting.
  // start-1 is free by definition — an occupied slot there would be part of the island.
  for (const [start] of islands) {
    if (target === start || target === start - 1) {
      newItem.sort_order = start - 1
      return
    }
  }

  let island = islandContaining(islands, target)
  if (!island) {
    for (const candidate of islands) {
      // Join on end+1 (after last) — extend that island.
      if (target === candidate[1] + 1) {
        island = candidate
        break
      }
    }
  }
  if (!island) {
    newItem.sort_order = target
    return
  }
  const [start, end] = island
  const following = nextIsland(islands, island)
  const rows = [...others, newItem]
  for (const item of others) {
    if (item.sort_order >= start && item.sort_order <= end && item.sort_order >= target) {
      item.sort_order += 1
    }
  }
  newItem.sort_order = target
  const grown = rows.filter((i) => i.sort_order >= start && i.sort_order <= end + 1).length
  densifyIsland(rows, [start, end + 1])
  if (following) {
    const shift = shiftToClear(start + grown - 1, following[0])
    if (shift) pushFrom(rows, following[0], shift)
  }
}

/**
 * Optimistic move matching backend: within-island swap, or lift+insert across islands.
 * Before an island with room → start-1 (joins into one island).
 */
export function applyIslandAwareMoveSortOrder<T extends OrderItem>(
  items: T[],
  id: number,
  targetOrder: number,
  inScope: (item: T, moved: T) => boolean = () => true,
): T[] {
  const moved = items.find((item) => item.id === id)
  if (!moved) return items
  const target = Math.trunc(targetOrder)
  const old = moved.sort_order

  const scoped = items
    .filter((item) => item.id === id || inScope(item, moved))
    .map((item) => ({ ...item }))
  const moving = scoped.find((item) => item.id === id)!
  const others = scoped.filter((item) => item.id !== id)

  if (old === target) {
    densifyAfterRemoval(scoped, old)
  } else {
    const islands = orderIslands(scoped.map((item) => item.sort_order))
    const oldIsland = islandContaining(islands, old)
    if (oldIsland && target >= oldIsland[0] && target <= oldIsland[1]) {
      moveWithinIsland(scoped, moving, target)
    } else if (oldIsland && target === oldIsland[1] + 1) {
      const following = nextIsland(islands, oldIsland)
      // After-last DnD stays within-island unless filling a 1-slot gap to the next island.
      if (following == null || following[0] > oldIsland[1] + 2) {
        moveWithinIsland(scoped, moving, target)
      } else {
        densifyAfterRemoval(others, old, { preserveWhenRemovingStart: true })
        insertIntoIsland([...others, moving], moving, target)
      }
    } else {
      densifyAfterRemoval(others, old, { preserveWhenRemovingStart: true })
      insertIntoIsland([...others, moving], moving, target)
    }
  }

  const byId = new Map(scoped.map((item) => [item.id, item]))
  return items.map((item) => {
    const next = byId.get(item.id)
    return next ? { ...item, sort_order: next.sort_order } : item
  })
}

/** @deprecated Prefer applyIslandAwareMoveSortOrder */
export function applyDenseMoveSortOrder<T extends OrderItem>(
  items: T[],
  id: number,
  targetOrder: number,
  inScope: (item: T, moved: T) => boolean,
): T[] {
  return applyIslandAwareMoveSortOrder(items, id, targetOrder, inScope)
}

/** @deprecated Prefer applyIslandAwareMoveSortOrder */
export function applySparseMoveSortOrder<T extends OrderItem>(
  items: T[],
  id: number,
  targetOrder: number,
): T[] {
  return applyIslandAwareMoveSortOrder(items, id, targetOrder)
}

export function setRowDragImage(event: DragEvent, row: HTMLTableRowElement | null) {
  if (!row) return
  const clone = row.cloneNode(true) as HTMLTableRowElement
  clone.classList.add('row-drag-ghost')
  clone.style.position = 'absolute'
  clone.style.top = '-1000px'
  clone.style.left = '-1000px'
  clone.style.width = `${row.getBoundingClientRect().width}px`
  clone.style.pointerEvents = 'none'
  document.body.appendChild(clone)
  event.dataTransfer.setDragImage(clone, 28, 18)
  requestAnimationFrame(() => clone.remove())
}
