import {
  columnCountForViewerGrid,
  maxColumnsForWidth,
  viewerGridContentHeight,
} from './viewerGrid'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

// Wide grid: full page of 12 packs evenly (not maxColumns).
{
  const width = 1400
  const gap = 12
  const minTile = 180
  const maxCols = maxColumnsForWidth(width, minTile, gap)
  assert(maxCols >= 7, `expected room for 7+ cols, got ${maxCols}`)
  const cols = columnCountForViewerGrid({
    width,
    minTile,
    gap,
    pageSize: 12,
  })
  assert(cols === 6, `full page of 12 should use 6 cols, got ${cols}`)
}

// Short last page: same columns as a full pageSize grid (empty cells at the end).
{
  const full = columnCountForViewerGrid({
    width: 1400,
    minTile: 180,
    gap: 12,
    pageSize: 12,
  })
  const short = columnCountForViewerGrid({
    width: 1400,
    minTile: 180,
    gap: 12,
    pageSize: 12,
  })
  assert(short === full, `short page must match full-page cols (${full}), got ${short}`)
  assert(full === 6, `expected 6 cols for pageSize 12, got ${full}`)
}

// Height fit: bump columns when a full pageSize layout overflows the viewport slightly.
{
  const width = 1200
  const gap = 12
  const minTile = 180
  const preferred = columnCountForViewerGrid({
    width,
    minTile,
    gap,
    pageSize: 48,
  })
  const tall = viewerGridContentHeight(width, preferred, gap, 48)
  const tight = tall - 40
  assert(tight > 0, 'expected positive tight height')
  const fitted = columnCountForViewerGrid({
    width,
    minTile,
    gap,
    pageSize: 48,
    availableHeight: tight,
  })
  assert(fitted > preferred, `fit should use more cols than ${preferred}, got ${fitted}`)
  assert(
    viewerGridContentHeight(width, fitted, gap, 48) <= tight + 0.5,
    'fitted grid should fit available height',
  )
}

console.log('viewerGrid.selftest: ok')
