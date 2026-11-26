/** Raw skip reasons rolled into the Already in library Skipped group. */
export const ALREADY_IN_LIBRARY_SKIP_REASONS = new Set([
  'already_have',
  'identical',
  'duplicate_hash',
])

/** Stable ordering for skip-reason groups in scrape panels. */
export const SCRAPE_SKIP_REASON_ORDER = [
  'unavailable',
  'interrupted',
  'already_have',
  'library_updated',
  'excluded_tag',
  'tag_mismatch',
  'media_type',
  'date_range',
] as const

/** Skipped rows that point at an existing library file (Open in library). */
export const LIBRARY_SKIP_REASONS = new Set([
  'library_updated',
  'already_have',
  'identical',
  'duplicate_hash',
])

const LABELS: Record<string, string> = {
  already_have: 'Already in library',
  library_updated: 'Updated info/file',
  unavailable: 'Unavailable',
  excluded_tag: 'Excluded tag',
  tag_mismatch: 'Tag filter',
  media_type: 'Media type filter',
  date_range: 'Date range filter',
  interrupted: 'Interrupted',
}

/** Per-row hint inside the merged Already in library group. */
const ALREADY_IN_LIBRARY_SUBLABELS: Record<string, string> = {
  already_have: 'Same post',
  duplicate_hash: 'Same file',
  identical: 'Identical image',
}

export function scrapeLibraryUpdatedDetail(detail: string | undefined): string | null {
  if (detail === 'file') return 'Updated file'
  if (detail === 'info') return 'Updated info'
  return null
}

/** Short line for rows in the Updated info/file group only. */
export function scrapeLibraryUpdatedLine(item: {
  reason: string
  detail?: string
}): string {
  const fromDetail = scrapeLibraryUpdatedDetail(item.detail)
  if (fromDetail) return fromDetail
  return 'Updated info'
}

export function scrapeSkipReasonGroupKey(reason: string): string {
  const key = reason.trim() || 'other'
  if (ALREADY_IN_LIBRARY_SKIP_REASONS.has(key)) return 'already_have'
  return key
}

export function scrapeSkipReasonSublabel(reason: string): string | null {
  return ALREADY_IN_LIBRARY_SUBLABELS[reason.trim()] ?? null
}

export function scrapeSkipReasonLabel(reason: string): string {
  const key = scrapeSkipReasonGroupKey(reason)
  return LABELS[key] ?? key.replace(/_/g, ' ')
}

export function sortScrapeSkipReasons(reasons: Iterable<string>): string[] {
  const order = new Map(SCRAPE_SKIP_REASON_ORDER.map((key, index) => [key, index]))
  return [...new Set(reasons)].sort((a, b) => {
    const ai = order.get(a as (typeof SCRAPE_SKIP_REASON_ORDER)[number])
    const bi = order.get(b as (typeof SCRAPE_SKIP_REASON_ORDER)[number])
    if (ai != null && bi != null) return ai - bi
    if (ai != null) return -1
    if (bi != null) return 1
    return scrapeSkipReasonLabel(a).localeCompare(scrapeSkipReasonLabel(b))
  })
}