import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { fetchDuplicates } from '../api/client'
import type { DuplicateGroup } from '../types'
import { registerEscapeHandler } from '../utils/escapeStack'
import { shouldSkipKeyboardShortcut } from '../utils/keyboardTarget'
import DuplicateGroupCard from './DuplicateGroupCard'

type QueueEntry = {
  key: string
  kind: 'identical' | 'similar'
  group: DuplicateGroup
}

function buildQueue(
  identical: DuplicateGroup[],
  similar: DuplicateGroup[],
): QueueEntry[] {
  return [
    ...identical.map((group) => ({
      key: `i-${group.primary_id}`,
      kind: 'identical' as const,
      group,
    })),
    ...similar.map((group) => ({
      key: `s-${group.primary_id}`,
      kind: 'similar' as const,
      group,
    })),
  ]
}

export default function ResolveDuplicatesOverlay({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set())
  const [index, setIndex] = useState(0)
  const [sessionTotals, setSessionTotals] = useState<{
    identical: number
    similar: number
  } | null>(null)

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['duplicates'],
    queryFn: fetchDuplicates,
  })

  useEffect(() => registerEscapeHandler(onClose), [onClose])

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!data || sessionTotals != null) return
    setSessionTotals({
      identical: data.identical.length,
      similar: data.similar.length,
    })
  }, [data, sessionTotals])

  const queue = useMemo(
    () =>
      buildQueue(data?.identical ?? [], data?.similar ?? []).filter(
        (entry) => !skipped.has(entry.key),
      ),
    [data, skipped],
  )

  useEffect(() => {
    if (queue.length === 0) {
      if (index !== 0) setIndex(0)
      return
    }
    if (index > queue.length - 1) setIndex(queue.length - 1)
  }, [queue.length, index])

  const current = queue[index] ?? null
  const canPrev = index > 0
  const canNext = index < queue.length - 1

  const progressLabel = (() => {
    if (!current || queue.length === 0) return null
    const kindQueue = queue.filter((e) => e.kind === current.kind)
    const posInKind = kindQueue.findIndex((e) => e.key === current.key) + 1
    const kindTotal =
      current.kind === 'identical'
        ? (sessionTotals?.identical ?? kindQueue.length)
        : (sessionTotals?.similar ?? kindQueue.length)
    const label = current.kind === 'identical' ? 'Identical' : 'Similar'
    return `${label} ${posInKind} of ${kindTotal} · Group ${index + 1} of ${queue.length}`
  })()

  const goPrev = () => {
    if (!canPrev) return
    setIndex((i) => i - 1)
  }
  const goNext = () => {
    if (!canNext) return
    setIndex((i) => i + 1)
  }
  const skipCurrent = () => {
    if (!current) return
    const key = current.key
    setSkipped((prev) => new Set(prev).add(key))
    // Same index shows the next group after this one drops out of the queue.
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      // Capture + stop so Viewer page ←/→ behind this overlay never runs.
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      const root = panelRef.current
      const active = document.activeElement
      if (!root || !active || !root.contains(active)) return
      if (shouldSkipKeyboardShortcut(event)) return
      if (event.key === 'ArrowLeft') {
        setIndex((i) => (i > 0 ? i - 1 : i))
      } else {
        setIndex((i) => (i < queue.length - 1 ? i + 1 : i))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [queue.length])

  const allClear = !isLoading && !error && queue.length === 0

  return (
    <div
      className="resolve-duplicates-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="resolve-duplicates-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className="resolve-duplicates-panel"
        tabIndex={-1}
        onMouseDown={(e) => {
          // Keep keyboard focus on the panel when clicking chrome (not form controls).
          const t = e.target as HTMLElement | null
          if (!t) return
          if (t.closest('input, textarea, select, button, a, label')) return
          panelRef.current?.focus()
        }}
      >
        <div className="resolve-duplicates-header">
          <h2 id="resolve-duplicates-title">Resolve similar files</h2>
          <button type="button" className="btn btn-small" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="hint">
          Identical groups first (merge into the larger file), then similar groups. With this panel
          focused, ← / → move between groups (the Viewer behind does not change page).{' '}
          <strong>Keep all</strong> keeps every file and only clears the similar/identical link.{' '}
          <strong>Keep selected, discard the rest</strong> keeps the checked files and discards the
          unchecked ones in this group.
        </p>
        {isLoading && <div className="empty">Loading…</div>}
        {error && (
          <div className="error">
            {error instanceof Error ? error.message : 'Failed to load duplicates'}
          </div>
        )}
        {allClear && (
          <div className="empty">
            {sessionTotals && sessionTotals.identical + sessionTotals.similar === 0
              ? 'No identical or similar files to resolve.'
              : 'All groups resolved or skipped.'}
          </div>
        )}
        {current && (
          <>
            <div className="resolve-duplicates-nav">
              <button
                type="button"
                className="btn btn-small"
                disabled={!canPrev}
                onClick={goPrev}
                aria-label="Previous group"
              >
                ← Previous
              </button>
              <div className="resolve-duplicates-progress">
                <strong>{progressLabel}</strong>
                {isFetching && !isLoading ? <span className="hint"> Updating…</span> : null}
              </div>
              <button
                type="button"
                className="btn btn-small"
                disabled={!canNext}
                onClick={goNext}
                aria-label="Next group"
              >
                Next →
              </button>
            </div>
            <DuplicateGroupCard
              key={`${current.key}-${current.group.items.map((item) => item.id).join('-')}`}
              group={current.group}
              kind={current.kind}
              wizard
            />
            <div className="resolve-duplicates-actions">
              <button type="button" className="btn" onClick={skipCurrent}>
                Skip
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
