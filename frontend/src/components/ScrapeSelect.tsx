import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { registerEscapeHandler } from '../utils/escapeStack'

export interface ScrapeSelectOption {
  id: string
  label: string
  /** Secondary line (counts, description). */
  detail?: string | null
  group?: string | null
}

interface Props {
  label: string
  value: string
  options: ScrapeSelectOption[]
  disabled?: boolean
  emptyLabel?: string
  onChange: (id: string) => void
  /** Hint under the control when the menu is closed. */
  hint?: ReactNode
}

function optionRows(options: ScrapeSelectOption[]): Array<
  | { kind: 'group'; label: string }
  | { kind: 'option'; option: ScrapeSelectOption }
> {
  const rows: Array<
    | { kind: 'group'; label: string }
    | { kind: 'option'; option: ScrapeSelectOption }
  > = []
  for (const option of options) {
    if (!option.group) rows.push({ kind: 'option', option })
  }
  const groups: string[] = []
  for (const option of options) {
    if (option.group && !groups.includes(option.group)) groups.push(option.group)
  }
  groups.sort((left, right) => {
    if (left === 'Gelbooru') return -1
    if (right === 'Gelbooru') return 1
    if (left === 'Rule34') return -1
    if (right === 'Rule34') return 1
    return left.localeCompare(right)
  })
  for (const group of groups) {
    rows.push({ kind: 'group', label: group })
    for (const option of options) {
      if (option.group === group) rows.push({ kind: 'option', option })
    }
  }
  return rows
}

export default function ScrapeSelect({
  label,
  value,
  options,
  disabled = false,
  emptyLabel = 'Nothing to choose',
  onChange,
  hint,
}: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const selected = options.find((item) => item.id === value) ?? null

  const rows = useMemo(() => optionRows(options), [options])

  useEffect(() => {
    if (!open) return
    return registerEscapeHandler(() => setOpen(false))
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [open])

  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  return (
    <div className="scrape-source-field" ref={rootRef}>
      <span className="scrape-source-label" id={`${listId}-label`}>
        {label}
      </span>
      <div className={`scrape-select${open ? ' scrape-select-open' : ''}`}>
        <button
          type="button"
          className="scrape-select-trigger"
          disabled={disabled || options.length === 0}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby={`${listId}-label`}
          aria-controls={listId}
          onClick={() => setOpen((prev) => !prev)}
        >
          <span className="scrape-select-trigger-main">
            <span className="scrape-select-trigger-label">
              {selected?.label || (options.length === 0 ? emptyLabel : 'Choose…')}
            </span>
            {selected?.detail ? (
              <>
                <span className="scrape-select-sep" aria-hidden>
                  ·
                </span>
                <span className="scrape-select-trigger-detail">{selected.detail}</span>
              </>
            ) : null}
          </span>
          <span className="scrape-select-chevron" aria-hidden>
            ▾
          </span>
        </button>
        {open && (
          <div className="scrape-select-menu" role="listbox" id={listId} aria-labelledby={`${listId}-label`}>
            {rows.length === 0 ? (
              <div className="scrape-select-empty">{emptyLabel}</div>
            ) : (
              rows.map((row) =>
                row.kind === 'group' ? (
                  <div key={`g:${row.label}`} className="scrape-select-group" role="presentation">
                    {row.label}
                  </div>
                ) : (
                  <button
                    key={row.option.id}
                    type="button"
                    role="option"
                    aria-selected={row.option.id === value}
                    className={`scrape-select-option${row.option.id === value ? ' active' : ''}`}
                    onClick={() => {
                      onChange(row.option.id)
                      setOpen(false)
                    }}
                  >
                    <span className="scrape-select-option-label">{row.option.label}</span>
                    {row.option.detail ? (
                      <>
                        <span className="scrape-select-sep" aria-hidden>
                          ·
                        </span>
                        <span className="scrape-select-option-detail">{row.option.detail}</span>
                      </>
                    ) : null}
                  </button>
                ),
              )
            )}
          </div>
        )}
      </div>
      {hint}
    </div>
  )
}

/** Short counts for every scrape queue on a source status panel. */
export function sourceBusyDetail(panel: {
  running: boolean
  total: number
  processed: number
  current_url: string | null
  queue_urls: string[]
  skipped_items?: { reason: string }[]
  error_items?: { reason: string }[]
  cancelled_urls?: string[]
} | null | undefined): string | null {
  if (!panel) return null
  const remaining = Math.max(0, panel.total - panel.processed)
  const scraping = panel.running ? (remaining > 0 ? remaining : panel.current_url ? 1 : 0) : 0
  const queued = panel.queue_urls.length
  const skipped = (panel.skipped_items ?? []).filter(
    (item) => item.reason !== 'cancelled' && item.reason !== 'error',
  ).length
  const errors =
    panel.error_items && panel.error_items.length > 0
      ? panel.error_items.length
      : (panel.skipped_items ?? []).filter((item) => item.reason === 'error').length
  const cancelled = (panel.cancelled_urls ?? []).length
  const parts: string[] = []
  if (scraping > 0) parts.push(`${scraping} scraping`)
  else if (panel.running) parts.push('scraping')
  if (queued > 0) parts.push(`${queued} queue`)
  if (skipped > 0) parts.push(`${skipped} skipped`)
  if (errors > 0) parts.push(`${errors} errors`)
  if (cancelled > 0) parts.push(`${cancelled} cancelled`)
  return parts.length > 0 ? parts.join(' · ') : null
}
