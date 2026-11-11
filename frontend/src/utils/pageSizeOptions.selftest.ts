import {
  TAGS_PAGE_SIZES,
  VIEWER_PAGE_SIZES,
} from '../types/appSettings'
import {
  clampPageSizeToOptions,
  normalizePageSizeOptions,
  suggestNextPageSize,
} from './pageSizeOptions'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`pageSizeOptions selftest: ${message}`)
}

assert(
  VIEWER_PAGE_SIZES.join(',') === '12,24,36,48,60,72,84,96',
  'default viewer options are 12 through 96 in steps of 12',
)
assert(TAGS_PAGE_SIZES.join(',') === '25,50,100', 'default tags options')

assert(
  normalizePageSizeOptions([24, 12, 24, 0, 99.7], 1, 200, VIEWER_PAGE_SIZES).join(',') ===
    '12,24,99',
  'normalize sorts, uniques, truncates, drops out of range',
)
assert(
  normalizePageSizeOptions([], 1, 200, VIEWER_PAGE_SIZES).join(',') === VIEWER_PAGE_SIZES.join(','),
  'empty list falls back to defaults',
)
assert(
  normalizePageSizeOptions([-1, 999], 1, 200, VIEWER_PAGE_SIZES).join(',') ===
    VIEWER_PAGE_SIZES.join(','),
  'all-invalid list falls back to defaults',
)

assert(clampPageSizeToOptions(36, [12, 24, 36], 24) === 36, 'kept when in options')
assert(clampPageSizeToOptions(48, [12, 24, 36], 24) === 24, 'falls back to default when present')
assert(clampPageSizeToOptions(48, [12, 36], 24) === 12, 'falls back to first when default missing')
assert(clampPageSizeToOptions(0, [25, 50], 50, true) === 0, 'All (0) stays when allowed')
assert(clampPageSizeToOptions(75, [25, 50], 50, true) === 50, 'tags size clamps with All allowed')

assert(suggestNextPageSize([12, 24], 1, 200, 12) === 36, 'add suggests last+step')
assert(suggestNextPageSize([12, 24, 36], 12, 36, 12) === 13, 'add fills first free gap when step is taken')
assert(
  normalizePageSizeOptions([12, 48, 24], 1, 200, VIEWER_PAGE_SIZES).join(',') === '12,24,48',
  'add/edit path keeps the list sorted',
)

console.log('pageSizeOptions.selftest: ok')
