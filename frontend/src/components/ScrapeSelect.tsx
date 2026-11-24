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

type BusyPanel = {
  running: boolean
  total: number
  processed: number
  current_url: string | null
  queue_urls: string[]
  skipped_items?: { reason: string }[]
  error_items?: { reason: string }[]
  cancelled_urls?: string[]
}

function panelBusyCounts(panel: BusyPanel) {
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
  return {
    scraping,
    running: panel.running,
    queued,
    skipped,
    errors,
    cancelled,
  }
}

function formatBusyCounts(counts: {
  scraping: number
  running: boolean
  queued: number
  skipped: number
  errors: number
  cancelled: number
}): string | null {
  const parts: string[] = []
  if (counts.scraping > 0) parts.push(`${counts.scraping} scraping`)
  else if (counts.running) parts.push('scraping')
  if (counts.queued > 0) parts.push(`${counts.queued} queue`)
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`)
  if (counts.errors > 0) parts.push(`${counts.errors} errors`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** Short counts for every scrape queue on a source status panel. */
export function sourceBusyDetail(panel: BusyPanel | null | undefined): string | null {
  if (!panel) return null
  return formatBusyCounts(panelBusyCounts(panel))
}

/** Sum queue counts across every site a scraper covers. */
export function scraperBusyDetail(
  siteIds: string[],
  panelsByKey: Map<string, BusyPanel>,
): string | null {
  const totals = {
    scraping: 0,
    running: false,
    queued: 0,
    skipped: 0,
    errors: 0,
    cancelled: 0,
  }
  for (const siteId of siteIds) {
    const panel = panelsByKey.get(siteId)
    if (!panel) continue
    const counts = panelBusyCounts(panel)
    totals.scraping += counts.scraping
    totals.running = totals.running || counts.running
    totals.queued += counts.queued
    totals.skipped += counts.skipped
    totals.errors += counts.errors
    totals.cancelled += counts.cancelled
  }
  return formatBusyCounts(totals)
}
