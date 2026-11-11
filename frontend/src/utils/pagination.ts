export function paginationTotalPages(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize))
}

export function clampPaginationPage(page: number, totalPages: number): number {
  return Math.max(1, Math.min(page, Math.max(1, totalPages)))
}

export function paginationItemCount(
  shown: number,
  total: number,
  noun = 'items',
): string {
  return `${Math.max(0, shown)} out of ${Math.max(0, total)} ${noun}`
}
