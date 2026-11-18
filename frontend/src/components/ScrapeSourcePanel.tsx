import { useState } from 'react'
import type { ScrapeSourcePanel as ScrapeSourcePanelData } from '../types'

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
  onStop: () => void
  onClear: () => void
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
  onStop,
  onClear,
}: Props) {
  const [skippedOpen, setSkippedOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [cancelledOpen, setCancelledOpen] = useState(false)

  const isLocal = panel.key === 'local'
  const cancelledUrls = panel.cancelled_urls
  const skippedItems = panel.skipped_items.filter((item) => item.reason !== 'cancelled')
  const queueUrls = panel.queue_urls
  const anyRunning = runningLabel !== null
  const hasActivity =
    panel.running ||
    panel.total > 0 ||
    panel.processed > 0 ||
    panel.downloaded > 0 ||
    skippedItems.length > 0 ||
    cancelledUrls.length > 0 ||
    queueUrls.length > 0 ||
    panel.errors.length > 0 ||
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
          disabled={!anyRunning && panel.errors.length === 0}
          title={anyRunning ? `Stops the running ${runningLabel} job` : 'Nothing is running'}
        >
          Stop
        </button>
        <button
          type="button"
          className="btn"
          onClick={onClear}
          disabled={
            panel.running ||
            (queueUrls.length === 0 && skippedItems.length === 0 && cancelledUrls.length === 0)
          }
          title={
            panel.running
              ? 'Stop the running job before clearing the queues'
              : `Empty ${panel.label}: Queue to scrape, Skipped, and Cancelled`
          }
        >
          Clear queues
        </button>
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
            {panel.similar > 0 && ` · similar ${panel.similar}`}
            {cancelledUrls.length > 0 && ` · cancelled ${cancelledUrls.length}`}
          </div>
          {cancelledUrls.length > 0 && (
            <details
              className="scrape-skipped"
              open={cancelledOpen}
              onToggle={(e) => {
                if (e.target !== e.currentTarget) return
                setCancelledOpen((e.currentTarget as HTMLDetailsElement).open)
              }}
            >
              <summary>Cancelled ({cancelledUrls.length})</summary>
              {cancelledOpen && (
                <ul className="scrape-skipped-list">
                  {cancelledUrls.map((url) => (
                    <li key={url}>
                      <UrlLine url={url} />
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
          {skippedItems.length > 0 && (
            <details
              className="scrape-skipped"
              open={skippedOpen}
              onToggle={(e) => {
                if (e.target !== e.currentTarget) return
                setSkippedOpen((e.currentTarget as HTMLDetailsElement).open)
              }}
            >
              <summary>Skipped ({skippedItems.length})</summary>
              {skippedOpen && (
                <ul className="scrape-skipped-list">
                  {skippedItems.map((item) => (
                    <li key={`${item.url}:${item.reason}:${item.detail || ''}`}>
                      <UrlLine url={item.url} />
                      <span className="scrape-skipped-reason">{item.reason}</span>
                      {item.detail ? (
                        <details
                          className="scrape-skipped-error"
                          onToggle={(e) => e.stopPropagation()}
                        >
                          <summary>Error</summary>
                          <pre>{item.detail}</pre>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
          {queueUrls.length > 0 && (
            <details
              className="scrape-skipped"
              open={queueOpen}
              onToggle={(e) => {
                if (e.target !== e.currentTarget) return
                setQueueOpen((e.currentTarget as HTMLDetailsElement).open)
              }}
            >
              <summary>Queue to scrape ({queueUrls.length})</summary>
              {queueOpen && (
                <ul className="scrape-skipped-list">
                  {queueUrls.map((url) => (
                    <li key={url}>
                      <UrlLine url={url} />
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
          {panel.errors.length > 0 && (
            <div className="error">
              {panel.errors.slice(-5).map((item) => (
                <div key={item}>{item}</div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="settings-hint scrape-source-panel-idle">Nothing run for {panel.label} yet.</p>
      )}
    </section>
  )
}
