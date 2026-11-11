import { paginationItemCount } from '../../utils/pagination'

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
      <span>
        Page {page} of {pages}
      </span>
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
