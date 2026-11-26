import { useMemo, useState, type ReactNode } from 'react'
import type { ScrapeListName, ScrapeRetryWhich } from '../api/client'
import type { ScrapeSkippedItem, ScrapeSourcePanel as ScrapeSourcePanelData } from '../types'
import { scrapeSkipReasonLabel, sortScrapeSkipReasons } from '../utils/scrapeSkipReasons'

function statusMessageParts(
  message: string,
  currentUrl: string | null | undefined,
): { before: string; url: string | null; after: string } {
  const url = currentUrl?.trim() || null
  if (url && message.includes(url)) {
    const idx = message.indexOf(url)
    return {
      before: message.slice(0, idx),
      url,
      after: message.slice(idx + url.length),
    }
  }
  if (url) {
    return { before: message ? `${message} ` : '', url, after: '' }
  }
  return { before: message, url: null, after: '' }
}

function UrlLine({ url }: { url: string }) {
  return url.startsWith('http') ? (
    <a href={url} target="_blank" rel="noreferrer">
      {url}
    </a>
  ) : (
    <span title={url}>{url}</span>
  )
}

const QUEUE_LIST_SCROLL_AFTER = 15

const LIBRARY_SKIP_REASONS = new Set(['already_have', 'identical', 'duplicate_hash'])

function SkippedLibraryLink({
  item,
  onOpen,
}: {
  item: ScrapeSkippedItem
  onOpen?: (mediaId: number) => void
}) {
  const id = item.existing_media_id
  if (!onOpen || id == null || id <= 0 || !LIBRARY_SKIP_REASONS.has(item.reason)) {
    return null
  }
  return (
    <button
      type="button"
      className="scrape-skipped-library-link btn btn-small"
      onClick={() => onOpen(id)}
    >
      Open in library
    </button>
  )
}

function queueListClass(count: number): string {
  return count > QUEUE_LIST_SCROLL_AFTER
    ? 'scrape-skipped-list scrape-skipped-list--scroll'
    : 'scrape-skipped-list'
}

function QueueSection({
  title,
  count,
  open,
  onToggle,
  clearDisabled,
  clearTitle,
  onClear,
  retryDisabled,
  retryTitle,
  onRetry,
  nested = false,
  children,
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  clearDisabled: boolean
  clearTitle: string
  onClear: () => void
  retryDisabled?: boolean
  retryTitle?: string
  onRetry?: () => void
  nested?: boolean
  children?: ReactNode
}) {
  return (
    <div className={`scrape-queue${nested ? ' scrape-queue-nested' : ''}`}>
      <div className="scrape-queue-bar">
        <button
          type="button"
          className="scrape-queue-toggle"
          aria-expanded={open}
          onClick={onToggle}
        >
          {title} ({count})
        </button>
        {onRetry ? (
          <button
            type="button"
            className="btn btn-small"
            onClick={onRetry}
            disabled={retryDisabled}
            title={retryTitle}
          >
            Retry
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-small"
          onClick={onClear}
          disabled={clearDisabled}
          title={clearTitle}
        >
          Clear
        </button>
      </div>
      {open ? children : null}
    </div>
  )
}

interface Props {
  panel: ScrapeSourcePanelData
  /** The Source/Site chosen in the shared form: this panel's Run uses it. */
  isFormSource: boolean
  /** Scraper name for the form source (shown on its status line). */
  scraperName?: string | null
  /** Label of the panel whose job is running right now, if any. */
  runningLabel: string | null
  canRun: boolean
  runTitle: string
  runLabel: string
  onRun: () => void
  canEnqueue?: boolean
  enqueueTitle?: string
  onEnqueue?: () => void
  onStop: () => void
  onClear: () => void
  onClearList: (which: ScrapeListName, skipReason?: string) => void
  onRetry: (which?: ScrapeRetryWhich, skipReason?: string) => void
  neverAutoRun: boolean
  onNeverAutoRunChange: (value: boolean) => void
  onOpenLibraryMedia?: (mediaId: number) => void
}

/** Run / Stop / Clear queues and the status + Skipped / Queue lists for one source. */
export default function ScrapeSourcePanel({
  panel,
  isFormSource,
  scraperName,
  runningLabel,
  canRun,
  runTitle,
  runLabel,
  onRun,
  canEnqueue = false,
  enqueueTitle,
  onEnqueue,
  onStop,
  onClear,
  onClearList,
  onRetry,
  neverAutoRun,
  onNeverAutoRunChange,
  onOpenLibraryMedia,
}: Props) {
  const [skippedOpen, setSkippedOpen] = useState(false)
  const [skippedReasonOpen, setSkippedReasonOpen] = useState<Record<string, boolean>>({})
  const [errorsOpen, setErrorsOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [cancelledOpen, setCancelledOpen] = useState(false)

  const isLocal = panel.key === 'local'
  const cancelledUrls = panel.cancelled_urls
  const skippedItems = panel.skipped_items.filter(
    (item) => item.reason !== 'cancelled' && item.reason !== 'error',
  )
  const skippedByReason = useMemo(() => {
    const map = new Map<string, typeof skippedItems>()
    for (const item of skippedItems) {
      const key = item.reason.trim() || 'other'
      const bucket = map.get(key) ?? []
      bucket.push(item)
      map.set(key, bucket)
    }
    return map
  }, [skippedItems])
  const skipReasonKeys = useMemo(
    () => sortScrapeSkipReasons(skippedByReason.keys()),
    [skippedByReason],
  )
  const errorItems =
    panel.error_items && panel.error_items.length > 0
      ? panel.error_items
      : panel.errors.map((line) => {
          const idx = line.indexOf(': ')
          return idx >= 0
            ? { url: line.slice(0, idx), reason: 'error', detail: line.slice(idx + 2) }
            : { url: line, reason: 'error', detail: '' }
        })
  const queueUrls = panel.queue_urls
  const anyRunning = runningLabel !== null
  const hasActivity =
    panel.running ||
    panel.total > 0 ||
    panel.processed > 0 ||
    panel.downloaded > 0 ||
    skippedItems.length > 0 ||
    errorItems.length > 0 ||
    cancelledUrls.length > 0 ||
    queueUrls.length > 0 ||
    Boolean(panel.message)
  const percent =
    panel.total > 0 ? Math.min(100, Math.round((panel.processed / panel.total) * 100)) : 0
  const msgParts = statusMessageParts(
    panel.message || (panel.running ? 'Running...' : 'Idle'),
    panel.current_url,
  )

  return (
    <section
      className={`panel scrape-source-panel${isFormSource ? ' scrape-source-panel-active' : ''}`}
      aria-label={`${panel.label} scrape`}
      data-source={panel.key}
    >
      <h3 className="scrape-source-panel-title">{panel.label}</h3>
      <div className="scrape-actions">
        <button type="button" className="btn btn-primary" onClick={onRun} disabled={!canRun} title={runTitle}>
          {runLabel}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={onStop}
          disabled={!anyRunning && errorItems.length === 0}
          title={anyRunning ? `Stops the running ${runningLabel} job` : 'Nothing is running'}
        >
          Stop
        </button>
        {onEnqueue ? (
          <button
            type="button"
            className="btn"
            onClick={onEnqueue}
            disabled={!canEnqueue}
            title={enqueueTitle ?? 'Find post URLs and add them to Queue to scrape'}
          >
            Find URLs
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          onClick={onClear}
          disabled={
            panel.running ||
            (queueUrls.length === 0 &&
              skippedItems.length === 0 &&
              errorItems.length === 0 &&
              cancelledUrls.length === 0)
          }
          title={
            panel.running
              ? 'Stop the running job before clearing the queues'
              : `Empty ${panel.label}: Queue to scrape, Skipped, Errors, and Cancelled`
          }
        >
          Clear queues
        </button>
        <label
          className="scrape-never-auto-run"
          title="Extension downloads wait in Queue to scrape until you press Run scrape. Turn this off to start downloading as soon as a link arrives."
        >
          <input
            type="checkbox"
            checked={neverAutoRun}
            onChange={(e) => onNeverAutoRunChange(e.target.checked)}
          />{' '}
          Never auto-run scrape
        </label>
      </div>

      {hasActivity ? (
        <div className="scrape-progress">
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="scrape-progress-meta">
            <strong className="scrape-source-panel-label">{panel.label}</strong>
            {' · '}
            {!isLocal && isFormSource && scraperName ? `${scraperName} · ` : ''}
            {msgParts.before}
            {msgParts.url ? (
              isLocal ? (
                <span title={msgParts.url}>{msgParts.url}</span>
              ) : (
                <a href={msgParts.url} target="_blank" rel="noreferrer">
                  {msgParts.url}
                </a>
              )
            ) : null}
            {msgParts.after}
            {panel.total > 0 && ` · ${panel.processed}/${panel.total}`}
            {` · ${isLocal ? 'added' : 'downloaded'} ${panel.downloaded}`}
            {` · skipped ${skippedItems.length}`}
            {errorItems.length > 0 && ` · errors ${errorItems.length}`}
            {panel.similar > 0 && ` · similar ${panel.similar}`}
            {cancelledUrls.length > 0 && ` · cancelled ${cancelledUrls.length}`}
          </div>
          {cancelledUrls.length > 0 && (
            <QueueSection
              title="Cancelled"
              count={cancelledUrls.length}
              open={cancelledOpen}
              onToggle={() => setCancelledOpen((open) => !open)}
              clearDisabled={panel.running}
              clearTitle={
                panel.running
                  ? 'Stop the running job before clearing this list'
                  : `Empty ${panel.label} Cancelled`
              }
              onClear={() => onClearList('cancelled')}
            >
              <ul className={queueListClass(cancelledUrls.length)}>
                {cancelledUrls.map((url) => (
                  <li key={url}>
                    <UrlLine url={url} />
                  </li>
                ))}
              </ul>
            </QueueSection>
          )}
          {errorItems.length > 0 && (
            <QueueSection
              title="Errors"
              count={errorItems.length}
              open={errorsOpen}
              onToggle={() => setErrorsOpen((open) => !open)}
              clearDisabled={panel.running}
              clearTitle={
                panel.running
                  ? 'Stop the running job before clearing this list'
                  : `Empty ${panel.label} Errors`
              }
              onClear={() => onClearList('errors')}
              retryDisabled={anyRunning}
              retryTitle={
                anyRunning
                  ? `Wait for the running ${runningLabel} job, or press Stop`
                  : 'Try the error files again. Skipped, Queue to scrape, and Cancelled stay.'
              }
              onRetry={() => onRetry('errors')}
            >
              <ul className={queueListClass(errorItems.length)}>
                {errorItems.map((item) => (
                  <li key={`${item.url}:${item.detail || ''}`}>
                    <UrlLine url={item.url} />
                    {item.detail ? (
                      <details className="scrape-skipped-error">
                        <summary>Error</summary>
                        <pre>{item.detail}</pre>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            </QueueSection>
          )}
          {skippedItems.length > 0 && (
            <QueueSection
              title="Skipped"
              count={skippedItems.length}
              open={skippedOpen}
              onToggle={() => setSkippedOpen((open) => !open)}
              clearDisabled={panel.running}
              clearTitle={
                panel.running
                  ? 'Stop the running job before clearing this list'
                  : `Empty ${panel.label} Skipped`
              }
              onClear={() => onClearList('skipped')}
              retryDisabled={anyRunning}
              retryTitle={
                anyRunning
                  ? `Wait for the running ${runningLabel} job, or press Stop`
                  : 'Try the skipped files again. Errors, Queue to scrape, and Cancelled stay.'
              }
              onRetry={() => onRetry('skipped')}
            >
              <div className="scrape-skipped-groups">
                {skipReasonKeys.map((reason) => {
                  const group = skippedByReason.get(reason) ?? []
                  const label = scrapeSkipReasonLabel(reason)
                  const open = skippedReasonOpen[reason] ?? false
                  return (
                    <QueueSection
                      key={reason}
                      nested
                      title={label}
                      count={group.length}
                      open={open}
                      onToggle={() =>
                        setSkippedReasonOpen((prev) => ({
                          ...prev,
                          [reason]: !open,
                        }))
                      }
                      clearDisabled={panel.running}
                      clearTitle={
                        panel.running
                          ? 'Stop the running job before clearing this list'
                          : `Empty ${panel.label} Skipped — ${label}`
                      }
                      onClear={() => onClearList('skipped', reason)}
                      retryDisabled={anyRunning}
                      retryTitle={
                        anyRunning
                          ? `Wait for the running ${runningLabel} job, or press Stop`
                          : `Try only ${label.toLowerCase()} skips again. Other skip reasons stay.`
                      }
                      onRetry={() => onRetry('skipped', reason)}
                    >
                      <ul className={queueListClass(group.length)}>
                        {group.map((item) => (
                          <li key={`${item.url}:${item.reason}:${item.detail || ''}`}>
                            <UrlLine url={item.url} />
                            <SkippedLibraryLink item={item} onOpen={onOpenLibraryMedia} />
                            {item.detail ? (
                              <details className="scrape-skipped-error">
                                <summary>Detail</summary>
                                <pre>{item.detail}</pre>
                              </details>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </QueueSection>
                  )
                })}
              </div>
            </QueueSection>
          )}
          {queueUrls.length > 0 && (
            <QueueSection
              title="Queue to scrape"
              count={queueUrls.length}
              open={queueOpen}
              onToggle={() => setQueueOpen((open) => !open)}
              clearDisabled={panel.running}
              clearTitle={
                panel.running
                  ? 'Stop the running job before clearing this list'
                  : `Empty ${panel.label} Queue to scrape`
              }
              onClear={() => onClearList('queue')}
            >
              <ul className={queueListClass(queueUrls.length)}>
                {queueUrls.map((url) => (
                  <li key={url}>
                    <UrlLine url={url} />
                  </li>
                ))}
              </ul>
            </QueueSection>
          )}
        </div>
      ) : (
        <p className="settings-hint scrape-source-panel-idle">Nothing run for {panel.label} yet.</p>
      )}
    </section>
  )
}
