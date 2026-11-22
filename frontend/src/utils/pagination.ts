export function paginationTotalPages(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize))
}

export function clampPaginationPage(page: number, totalPages: number): number {
  return Math.max(1, Math.min(page, Math.max(1, totalPages)))
}

/** Parse a typed page number; empty/invalid returns null (caller restores current). */
export function parseGoToPage(raw: string, totalPages: number): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  if (!Number.isSafeInteger(n) || n < 1) return null
  return clampPaginationPage(n, totalPages)
}

export function paginationItemCount(
  shown: number,
  total: number,
  noun = 'items',
): string {
  return `${Math.max(0, shown)} out of ${Math.max(0, total)} ${noun}`
}
