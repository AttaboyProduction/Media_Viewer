import { useEffect, useState } from 'react'
import { paginationItemCount, parseGoToPage } from '../../utils/pagination'

export interface PageSizeOption {
  value: number
  label?: string
}

interface Props {
  page: number
  totalPages: number
  shown: number
  total: number
  onPageChange: (page: number) => void
  noun?: string
  className?: string
  pageSize?: number
  pageSizeOptions?: readonly (number | PageSizeOption)[]
  onPageSizeChange?: (pageSize: number) => void
  pageSizeLabel?: string
  pageSizeDisabled?: boolean
}

export default function PaginationBar({
  page,
  totalPages,
  shown,
  total,
  onPageChange,
  noun = 'items',
  className,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  pageSizeLabel = 'Items per page',
  pageSizeDisabled = false,
}: Props) {
  const pages = Math.max(1, totalPages)
  const showPageSize =
    pageSize !== undefined && pageSizeOptions?.length && onPageSizeChange
  const [goToDraft, setGoToDraft] = useState(String(page))

  useEffect(() => {
    setGoToDraft(String(page))
  }, [page])

  const commitGoTo = () => {
    const next = parseGoToPage(goToDraft, pages)
    if (next === null) {
      setGoToDraft(String(page))
      return
    }
    setGoToDraft(String(next))
    if (next !== page) onPageChange(next)
  }

  return (
    <div className={['pagination', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="btn"
        disabled={page <= 1}
        onClick={() => onPageChange(Math.max(1, page - 1))}
      >
        Previous
      </button>
      <label className="pagination-go-to">
        <span className="pagination-go-to-label">Page</span>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          className="pagination-go-to-input"
          value={goToDraft}
          aria-label={`Go to page (1–${pages})`}
          size={Math.max(2, String(pages).length)}
          onChange={(event) => setGoToDraft(event.target.value)}
          onBlur={commitGoTo}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitGoTo()
              ;(event.target as HTMLInputElement).blur()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setGoToDraft(String(page))
              ;(event.target as HTMLInputElement).blur()
            }
          }}
        />
        <span className="pagination-go-to-of">of {pages}</span>
      </label>
      <button
        type="button"
        className="btn"
        disabled={page >= pages}
        onClick={() => onPageChange(Math.min(pages, page + 1))}
      >
        Next
      </button>
      <span className="pagination-item-count">
        ({paginationItemCount(shown, total, noun)})
      </span>
      {showPageSize && (
        <label className="pagination-page-size">
          {pageSizeLabel}
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            disabled={pageSizeDisabled}
          >
            {pageSizeOptions.map((option) => {
              const normalized =
                typeof option === 'number' ? { value: option, label: String(option) } : option
              return (
                <option key={normalized.value} value={normalized.value}>
                  {normalized.label ?? normalized.value}
                </option>
              )
            })}
          </select>
        </label>
      )}
    </div>
  )
}
