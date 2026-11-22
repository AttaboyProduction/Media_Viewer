import { useEffect, useState } from 'react'

/**
 * True only while the same page is refetching (filters, sort).
 * A page change keeps full opacity until that page's fetch settles.
 */
export function useSuppressPageSwitchDim(
  page: number,
  dataPage: number | undefined,
  isFetching: boolean,
): boolean {
  const [settledPage, setSettledPage] = useState(page)
  useEffect(() => {
    if (!isFetching && dataPage === page) setSettledPage(page)
  }, [isFetching, dataPage, page])
  return isFetching && dataPage === page && settledPage === page
}
