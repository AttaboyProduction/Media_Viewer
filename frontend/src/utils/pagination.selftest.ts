import {
  SCRAPE_DOWNLOAD_PAGE_SIZES,
  VIEWER_PAGE_SIZES,
} from '../types/appSettings'
import { horizontalWheelDirection } from './horizontalWheelNav'
import {
  clampPaginationPage,
  paginationItemCount,
  paginationTotalPages,
  parseGoToPage,
} from './pagination'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`pagination selftest: ${message}`)
}

assert(paginationTotalPages(0, 24) === 1, 'empty lists have one page')
assert(paginationTotalPages(49, 24) === 3, 'partial final page is counted')
assert(paginationTotalPages(12, 0) === 1, 'non-paged/all mode has one page')

assert(clampPaginationPage(0, 5) === 1, 'page clamps at lower bound')
assert(clampPaginationPage(7, 5) === 5, 'page clamps at upper bound')
assert(clampPaginationPage(3, 5) === 3, 'valid page remains unchanged')

assert(parseGoToPage('3', 10) === 3, 'go-to accepts a valid page')
assert(parseGoToPage(' 12 ', 10) === 10, 'go-to clamps above total pages')
assert(parseGoToPage('0', 10) === null, 'go-to rejects zero')
assert(parseGoToPage('', 10) === null, 'go-to rejects empty')
assert(parseGoToPage('2.5', 10) === null, 'go-to rejects decimals')
assert(parseGoToPage('abc', 10) === null, 'go-to rejects non-digits')

assert(horizontalWheelDirection(40, 0) === 'next', 'wheel tilt right is next')
assert(horizontalWheelDirection(-40, 0) === 'prev', 'wheel tilt left is previous')
assert(horizontalWheelDirection(4, 0) === null, 'tiny horizontal wheel is ignored')
assert(horizontalWheelDirection(10, 40) === null, 'vertical wheel scroll is not navigation')

assert(
  paginationItemCount(18, 47) === '18 out of 47 items',
  'default count copy is shared',
)
assert(
  paginationItemCount(5, 9, 'pairs') === '5 out of 9 pairs',
  'custom nouns are supported',
)

assert(
  VIEWER_PAGE_SIZES.join(',') === '12,24,36,48,60,72,84,96',
  'default viewer options are 12 through 96 in steps of 12',
)
assert(
  SCRAPE_DOWNLOAD_PAGE_SIZES.every((size) => size % 18 === 0),
  'scrape options remain multiples of 18',
)

console.log('pagination.selftest: ok')
