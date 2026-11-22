import { createPreviewWindow, previewLoadOrder, previewWindowPages } from './previewPageWindow'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(previewWindowPages(1, 5).join() === '1,2,3', 'page 1 keeps itself and two following pages')
assert(previewWindowPages(3, 5).join() === '1,2,3,4,5', 'a middle page keeps two neighbors each side')
assert(previewWindowPages(5, 5).join() === '3,4,5', 'the last page keeps two previous pages')
assert(previewWindowPages(9, 2).join() === '1,2', 'a page past the end clamps into the window')

assert(previewLoadOrder(1, 4, new Set()).join() === '1,2,3', 'first page loads itself, then two after')
assert(
  previewLoadOrder(3, 5, new Set([2])).join() === '3,4,5,1',
  'warm previous pages are kept and not loaded again',
)
assert(
  previewLoadOrder(3, 5, new Set()).join() === '3,4,5,1,2',
  'cold previous pages load after the following pages',
)
assert(previewLoadOrder(4, 4, new Set([3])).join() === '4,2', 'last page loads a cold page two back')

assert(previewWindowPages(3, 8, 2).join() === '1,2,3,4,5', 'radius 2 keeps two pages each side')
assert(previewWindowPages(1, 8, 2).join() === '1,2,3', 'radius 2 on page 1 has no pages before')
assert(
  previewLoadOrder(4, 8, new Set([3]), 2).join() === '4,5,6,2',
  'radius 2 loads forward first and skips a warm previous page',
)
assert(previewLoadOrder(3, 8, new Set(), 0).join() === '3', 'radius 0 keeps only the open page')

const released: string[] = []
const windowCache = createPreviewWindow((url) => {
  released.push(`live:${url}`)
  return { release: () => released.push(`drop:${url}`) }
})

windowCache.sync('viewer', [1, 2], new Map([[1, ['a']]]))
windowCache.sync('viewer', [1, 2], new Map([[2, ['b']]]))
assert(windowCache.warmPages().has(1) && windowCache.warmPages().has(2), 'neighbors stay decoded')
assert(!released.includes('drop:a'), 'page 1 is not dropped while it is still in the window')

windowCache.sync('viewer', [2, 3, 4], new Map([[3, ['c']], [4, ['d']]]))
assert(!windowCache.warmPages().has(1), 'the page before the previous one is unloaded')
assert(released.includes('drop:a'), 'unloaded page releases its pictures')
assert(windowCache.warmPages().has(2), 'the previous page stays')

windowCache.sync('viewer', [2, 3, 4], new Map([[3, ['c']]]))
assert(
  released.filter((entry) => entry === 'drop:c').length === 0,
  'the same page urls are not decoded again',
)

windowCache.sync('other', [1], new Map([[1, ['z']]]))
assert(!windowCache.warmPages().has(2), 'a new list drops the previous list')
assert(windowCache.warmPages().has(1), 'the new list keeps its own page')

console.log('previewPageWindow.selftest: ok')
