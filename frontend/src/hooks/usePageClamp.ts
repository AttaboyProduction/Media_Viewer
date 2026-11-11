import { useEffect } from 'react'
import { clampPaginationPage } from '../utils/pagination'

/** Pull the current page back into range when the list shrinks (deletes, filters, page size). */
export function usePageClamp(
  page: number,
  totalPages: number,
  setPage: (page: number) => void,
) {
  useEffect(() => {
    const clamped = clampPaginationPage(page, totalPages)
    if (clamped !== page) setPage(clamped)
  }, [page, totalPages, setPage])
}
