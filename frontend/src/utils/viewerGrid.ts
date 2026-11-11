/** Approximate media-card-meta block (padding + one text line). */
export const VIEWER_CARD_META_HEIGHT = 32

/** Do not shrink tiles below this when fitting a full page into the viewport. */
const MIN_TILE_FLOOR = 96

export function maxColumnsForWidth(width: number, minTile: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (minTile + gap)))
}

/** Height of a square-thumb grid with the given column count. */
export function viewerGridContentHeight(
  width: number,
  cols: number,
  gap: number,
  itemCount: number,
  metaHeight = VIEWER_CARD_META_HEIGHT,
): number {
  if (cols < 1 || itemCount < 1 || width <= 0) return 0
  const colW = (width - (cols - 1) * gap) / cols
  const cardH = colW + metaHeight
  const rows = Math.ceil(itemCount / cols)
  return rows * cardH + (rows - 1) * gap
}

/**
 * Column count for the viewer media grid.
 *
 * Always packs as a full page (`pageSize`) so a short last page keeps the same
 * card size; missing items leave empty cells at the end of the grid.
 * When availableHeight is set, may add columns (slightly smaller cards) so a
 * full page fits the viewport without a leftover scroll.
 */
export function columnCountForViewerGrid(options: {
  width: number
  minTile: number
  gap: number
  pageSize: number
  availableHeight?: number | null
  metaHeight?: number
}): number {
  const {
    width,
    minTile,
    gap,
    pageSize,
    availableHeight = null,
    metaHeight = VIEWER_CARD_META_HEIGHT,
  } = options
  if (pageSize <= 0 || width <= 0) return 1

  const pickCols = (maxCols: number): number => {
    const cap = Math.min(Math.max(1, maxCols), pageSize)
    for (let cols = cap; cols >= 1; cols -= 1) {
      if (pageSize % cols === 0) return cols
    }
    return cap
  }

  const preferred = pickCols(maxColumnsForWidth(width, minTile, gap))
  if (availableHeight == null || availableHeight <= 0) return preferred

  const fits = (cols: number) =>
    viewerGridContentHeight(width, cols, gap, pageSize, metaHeight) <= availableHeight + 0.5

  if (fits(preferred)) return preferred

  const hardMax = Math.min(
    pageSize,
    maxColumnsForWidth(width, Math.max(MIN_TILE_FLOOR, Math.floor(minTile * 0.75)), gap),
  )
  let bestFit: number | null = null
  for (let cols = preferred + 1; cols <= hardMax; cols += 1) {
    if (!fits(cols)) continue
    if (pageSize % cols === 0) return cols
    if (bestFit == null) bestFit = cols
  }
  return bestFit ?? hardMax
}
