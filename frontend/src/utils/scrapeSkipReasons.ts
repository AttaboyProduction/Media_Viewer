/** Stable ordering for skip-reason groups in scrape panels. */
export const SCRAPE_SKIP_REASON_ORDER = [
  'unavailable',
  'interrupted',
  'already_have',
  'identical',
  'duplicate_hash',
  'excluded_tag',
  'tag_mismatch',
  'media_type',
  'date_range',
] as const

const LABELS: Record<string, string> = {
  already_have: 'Already in library',
  identical: 'Identical file',
  duplicate_hash: 'Duplicate file',
  unavailable: 'Unavailable',
  excluded_tag: 'Excluded tag',
  tag_mismatch: 'Tag filter',
  media_type: 'Media type filter',
  date_range: 'Date range filter',
  interrupted: 'Interrupted',
}

export function scrapeSkipReasonLabel(reason: string): string {
  const key = reason.trim()
  if (!key) return 'Other'
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