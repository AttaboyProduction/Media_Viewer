import { useCallback, useEffect, useRef, useState, type WheelEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteLinkedMediaFile,
  deleteMedia,
  discardMedia,
  fetchAppSettings,
  fetchDuplicateGroup,
  fetchMediaById,
  refreshMediaTags,
  rescrapeMedia,
  setRating,
  updateMediaUrls,
} from '../api/client'
import ContentHideMedia from './ContentHideMedia'
import DuplicateGroupCard from './DuplicateGroupCard'
import MediaViewerChrome from './MediaViewerChrome'
import RelatedMediaPicker from './RelatedMediaPicker'
import StarRating from './StarRating'
import TagEditor from './TagEditor'
import { useConfirm } from '../context/ConfirmContext'
import { useContentHide } from '../hooks/useContentHide'
import { useKeyboardRating } from '../hooks/useKeyboardRating'
import { DEFAULT_APP_SETTINGS } from '../types/appSettings'
import { registerEscapeHandler } from '../utils/escapeStack'
import { useHorizontalWheelNav } from '../hooks/useHorizontalWheelNav'
import {
  shouldSkipKeyboardChord,
  shouldSkipKeyboardShortcut,
} from '../utils/keyboardTarget'
import { formatFileSize, formatPixelSize } from '../utils/mediaViewerActions'

interface Props {
  mediaId: number
  /** 0-based index in the full list (all pages / session), not only this page. */
  fileIndex: number
  fileTotal: number
  canPrev: boolean
  canNext: boolean
  onClose: () => void
  /** Move one file; may load the previous/next page when at a page edge. */
  onNavigateAdjacent: (direction: 'prev' | 'next') => void | Promise<void>
  selectedFilterTags?: string[]
  onToggleViewerFilter?: (name: string) => void
  /** Above resolve-similar overlay and nested inside another detail modal. */
  stackElevated?: boolean
}

const ZOOM_MIN = 1
const ZOOM_MAX = 8
const ZOOM_STEP = 0.25
/** Keep Fit slightly inside the media viewport to avoid edge overflow flicker. */
const VIEWPORT_FIT_SLACK = 0.98

function clampZoom(z: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
}

/** Step zoom and keep moving when the current value is between the 0.25 stops. */
function stepZoom(z: number, delta: number) {
  const direction = delta < 0 ? -1 : 1
  let next = Math.round((z + delta) / ZOOM_STEP) * ZOOM_STEP
  if (direction > 0 && next <= z + 1e-6) next = z + ZOOM_STEP
  if (direction < 0 && next >= z - 1e-6) next = z - ZOOM_STEP
  return clampZoom(next)
}

export default function MediaDetailModal({
  mediaId,
  fileIndex,
  fileTotal,
  canPrev,
  canNext,
  onClose,
  onNavigateAdjacent,
  selectedFilterTags,
  onToggleViewerFilter,
  stackElevated = false,
}: Props) {
  const queryClient = useQueryClient()
  const { confirm } = useConfirm()
  const { isLocked, revealForMedia, revealing } = useContentHide()
  const [newUrl, setNewUrl] = useState('')
  const [relatedOpen, setRelatedOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [navBusy, setNavBusy] = useState(false)
  const [urlAddOpen, setUrlAddOpen] = useState(false)
  const [editingUrl, setEditingUrl] = useState<string | null>(null)
  const [editUrlValue, setEditUrlValue] = useState('')
  const [zoom, setZoom] = useState(1)
  /** Degrees counterclockwise from the stored file orientation. */
  const [rotationDeg, setRotationDeg] = useState(0)
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 })
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 })
  const mediaScrollRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const scrollMediaToStartRef = useRef(false)
  const modalRef = useRef<HTMLDivElement>(null)

  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 60_000,
  })
  const numbering =
    appSettings?.viewer_media_numbering ?? DEFAULT_APP_SETTINGS.viewer_media_numbering
  // Both actions open a scrape browser, which is off while the Scrape page is hidden.
  const scrapeEnabled = !(appSettings?.hide_scrape_page ?? DEFAULT_APP_SETTINGS.hide_scrape_page)

  const { data: media } = useQuery({
    queryKey: ['media', mediaId],
    queryFn: () => fetchMediaById(mediaId),
  })
  const contentLocked = media ? isLocked(media) : false
  const { data: related } = useQuery({
    queryKey: ['duplicate-group', mediaId],
    queryFn: () => fetchDuplicateGroup(mediaId),
  })
  const ratingMutation = useMutation({
    mutationFn: (score: number) => setRating(mediaId, score),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['media'] }),
  })
  useKeyboardRating(Boolean(media), mediaId, (score) => ratingMutation.mutate(score))
  const discardMutation = useMutation({
    mutationFn: (discarded: boolean) => discardMedia(mediaId, discarded),
    onSuccess: (updated) => {
      // Stay open so Discard ↔ Restore (and Delete key) can toggle without reopening.
      queryClient.setQueryData(['media', mediaId], updated)
      queryClient.invalidateQueries({ queryKey: ['media'] })
      queryClient.invalidateQueries({ queryKey: ['duplicates'] })
    },
  })
  const rescrapeMutation = useMutation({
    mutationFn: () => rescrapeMedia(mediaId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      queryClient.invalidateQueries({ queryKey: ['duplicates'] })
      queryClient.invalidateQueries({ queryKey: ['tags'] })
    },
  })
  const refreshTagsMutation = useMutation({
    mutationFn: () => refreshMediaTags(mediaId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      queryClient.invalidateQueries({ queryKey: ['tags'] })
    },
  })
  const urlsMutation = useMutation({
    mutationFn: (payload: { add?: string[]; remove?: string[]; urls?: string[] }) =>
      updateMediaUrls(mediaId, payload.add ?? [], payload.remove ?? [], payload.urls),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      setNewUrl('')
      setUrlAddOpen(false)
      setEditingUrl(null)
      setEditUrlValue('')
    },
  })
  const deleteMutation = useMutation({
    mutationFn: () => deleteMedia(mediaId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      queryClient.invalidateQueries({ queryKey: ['duplicates'] })
      onClose()
    },
  })
  const deleteLocalFileMutation = useMutation({
    mutationFn: () => deleteLinkedMediaFile(mediaId),
    onSuccess: (updated) => {
      queryClient.setQueryData(['media', mediaId], updated)
      queryClient.invalidateQueries({ queryKey: ['media'] })
      queryClient.invalidateQueries({ queryKey: ['duplicates'] })
    },
  })
  const isLinked = media?.storage_kind === 'linked'
  const actionBusy =
    discardMutation.isPending ||
    deleteMutation.isPending ||
    deleteLocalFileMutation.isPending ||
    rescrapeMutation.isPending ||
    refreshTagsMutation.isPending ||
    urlsMutation.isPending

  const promptDiscard = useCallback(async () => {
    if (!media || actionBusy) return
    if (media.is_discarded) {
      const ok = await confirm({
        title: 'Restore media',
        message: 'Restore this item to the viewer?',
        confirmLabel: 'Restore',
      })
      if (ok) discardMutation.mutate(false)
      return
    }
    const ok = await confirm({
      title: 'Discard media',
      message: 'Discard this item from viewing?',
      confirmLabel: 'Discard',
    })
    if (ok) discardMutation.mutate(true)
  }, [media, actionBusy, confirm, discardMutation])

  const promptDeletePermanent = useCallback(async () => {
    if (!media || actionBusy) return
    const ok = await confirm({
      title: 'Delete media',
      message: isLinked
        ? 'Remove this item from the library? The file on disk will not be deleted.'
        : 'Permanently delete this file and all metadata (tags, ratings)? This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) deleteMutation.mutate()
  }, [media, actionBusy, confirm, isLinked, deleteMutation])
  // Keep expanded full view across ‹ › / arrow navigation; only reset per-item chrome.
  useEffect(() => {
    setUrlAddOpen(false)
    setNewUrl('')
    setRelatedOpen(false)
    setZoom(1)
    setRotationDeg(0)
    setNaturalSize({ w: 0, h: 0 })
  }, [mediaId])

  useEffect(() => {
    if (!expanded) setZoom(1)
  }, [expanded])

  useEffect(() => {
    // Measure the scroller (not the padded outer frame) so width already excludes
    // scrollbar-gutter; Fill then matches what is actually visible.
    const el = mediaScrollRef.current
    if (!el || !expanded) return
    const measure = (width: number, height: number) => {
      const w = Math.max(1, Math.floor(width))
      const h = Math.max(1, Math.floor(height))
      // Ignore 1px jitter from subpixel layout / scrollbar feedback.
      setViewportSize((prev) =>
        Math.abs(prev.w - w) < 2 && Math.abs(prev.h - h) < 2 ? prev : { w, h },
      )
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      // clientWidth/Height exclude the classic scrollbar and stable gutter.
      measure(el.clientWidth, el.clientHeight)
    })
    ro.observe(el)
    measure(el.clientWidth, el.clientHeight)
    return () => ro.disconnect()
  }, [expanded, mediaId])

  const step = useCallback(
    async (direction: 'prev' | 'next') => {
      if (navBusy) return
      if (direction === 'prev' && !canPrev) return
      if (direction === 'next' && !canNext) return
      setNavBusy(true)
      try {
        await onNavigateAdjacent(direction)
      } finally {
        setNavBusy(false)
      }
    },
    [navBusy, canPrev, canNext, onNavigateAdjacent],
  )
  const goPrev = () => {
    void step('prev')
  }
  const goNext = () => {
    void step('next')
  }

  useEffect(() => {
    return registerEscapeHandler(() => {
      if (expanded) {
        setExpanded(false)
        return
      }
      if (urlAddOpen) {
        setUrlAddOpen(false)
        setNewUrl('')
        return
      }
      onClose()
    })
  }, [onClose, expanded, urlAddOpen])

  useEffect(() => {
    const verticalScrollTarget = (): HTMLElement | null => {
      const mediaScroll = mediaScrollRef.current
      if (mediaScroll && mediaScroll.scrollHeight > mediaScroll.clientHeight + 1) {
        return mediaScroll
      }
      const modal = modalRef.current
      if (modal && modal.scrollHeight > modal.clientHeight + 1) {
        return modal
      }
      return null
    }
    // Capture so ←/→/F/↑/↓/Delete still work when the <video> (or its controls) has focus.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.code === 'Delete') {
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          if (shouldSkipKeyboardChord(e)) return
          e.preventDefault()
          e.stopPropagation()
          void promptDeletePermanent()
          return
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return
        if (shouldSkipKeyboardShortcut(e)) return
        e.preventDefault()
        e.stopPropagation()
        void promptDiscard()
        return
      }
      if (shouldSkipKeyboardShortcut(e)) return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        setExpanded((v) => !v)
        return
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const target = verticalScrollTarget()
        if (!target) return
        e.preventDefault()
        // Soft single-step; key-repeat stays instant so queued smooth scrolls don't fight.
        const delta = Math.max(48, Math.floor(target.clientHeight * (e.repeat ? 0.12 : 0.18)))
        target.scrollBy({
          top: e.key === 'ArrowUp' ? -delta : delta,
          behavior: e.repeat ? 'auto' : 'smooth',
        })
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!stackElevated && document.querySelector('.modal-backdrop-elevated')) {
          return
        }
        // Always consume so grid page ←/→ does not fire under an open detail view.
        e.preventDefault()
        e.stopPropagation()
        if (stackElevated) {
          e.stopImmediatePropagation()
        }
        if (navBusy) return
        if (e.key === 'ArrowLeft' && canPrev) void step('prev')
        if (e.key === 'ArrowRight' && canNext) void step('next')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [canPrev, canNext, navBusy, step, promptDeletePermanent, promptDiscard, stackElevated])

  useHorizontalWheelNav(
    backdropRef,
    (direction) => {
      if (navBusy) return
      if (direction === 'prev' && canPrev) void step('prev')
      if (direction === 'next' && canNext) void step('next')
    },
    Boolean(media),
  )

  const fitScale =
    naturalSize.w > 0 && naturalSize.h > 0 && viewportSize.w > 0 && viewportSize.h > 0
      ? Math.min(viewportSize.w / naturalSize.w, viewportSize.h / naturalSize.h) *
        VIEWPORT_FIT_SLACK
      : 1
  const fillZoom =
    naturalSize.w > 0 && naturalSize.h > 0 && viewportSize.w > 0 && viewportSize.h > 0 && fitScale > 0
      ? Math.max(viewportSize.w / naturalSize.w, viewportSize.h / naturalSize.h) / fitScale
      : 1
  const displayW =
    naturalSize.w > 0 ? Math.max(1, Math.round(naturalSize.w * fitScale * zoom)) : undefined
  const displayH =
    naturalSize.h > 0 ? Math.max(1, Math.round(naturalSize.h * fitScale * zoom)) : undefined
  // Pan only on axes that actually overflow. Anything past the screen stays reachable.
  const allowScrollX = expanded && displayW != null && displayW > viewportSize.w
  const allowScrollY = expanded && displayH != null && displayH > viewportSize.h
  const mediaScrollClass = [
    allowScrollX ? 'modal-media-scroll-x' : '',
    allowScrollY ? 'modal-media-scroll-y' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const bumpZoom = (delta: number) => setZoom((z) => stepZoom(z, delta))
  const setFit = () => setZoom(1)
  const setFill = () => {
    // Exact cover (not the next 0.25 step) so the short edges meet the screen
    // and +/− still move away from that size.
    scrollMediaToStartRef.current = true
    setZoom(clampZoom(Math.max(fillZoom, 1)))
  }

  useEffect(() => {
    if (!scrollMediaToStartRef.current) return
    scrollMediaToStartRef.current = false
    const scroller = mediaScrollRef.current
    if (!scroller) return
    scroller.scrollTop = 0
    scroller.scrollLeft = 0
  }, [zoom])

  const onMediaWheel = (e: WheelEvent) => {
    if (!expanded || !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    bumpZoom(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
  }

  const captureNatural = (w: number, h: number) => {
    if (w > 0 && h > 0) setNaturalSize({ w, h })
  }

  if (!media) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          Loading...
        </div>
      </div>
    )
  }
  const busy =
    rescrapeMutation.isPending ||
    deleteMutation.isPending ||
    deleteLocalFileMutation.isPending ||
    refreshTagsMutation.isPending ||
    urlsMutation.isPending
  const sourceUrls = (media.source_urls ?? (media.source_url ? [media.source_url] : [])).filter(
    (url) => url && !url.toLowerCase().startsWith('file:'),
  )
  const sourceNumber = (() => {
    if (!media.source_post_id.startsWith('loc_')) return media.source_post_id
    for (const url of sourceUrls) {
      const match = url.match(/\/post\/(\d+)/)
      if (match) return match[1]
    }
    return media.source_post_id
  })()
  const displayNumber = numbering === 'db' ? String(media.id) : sourceNumber
  const addUrl = () => {
    const trimmed = newUrl.trim()
    if (!trimmed) return
    urlsMutation.mutate({ add: [trimmed], remove: [] })
  }

  const replaceUrls = (next: string[]) => {
    urlsMutation.mutate({ urls: next })
  }

  const saveEditedUrl = (oldUrl: string) => {
    const trimmed = editUrlValue.trim()
    if (!trimmed || trimmed === oldUrl) {
      setEditingUrl(null)
      setEditUrlValue('')
      return
    }
    replaceUrls(sourceUrls.map((u) => (u === oldUrl ? trimmed : u)))
  }

  const makePrimaryUrl = (url: string) => {
    if (url === media?.source_url) return
    replaceUrls([url, ...sourceUrls.filter((u) => u !== url)])
  }

  const removeSourceUrl = (url: string) => {
    if (!isLinked && sourceUrls.length <= 1) return
    replaceUrls(sourceUrls.filter((u) => u !== url))
  }

  const rotated = ((rotationDeg % 360) + 360) % 360
  const mediaStyle = {
    ...(expanded && displayW != null && displayH != null
      ? { width: displayW, height: displayH, maxWidth: 'none' as const, maxHeight: 'none' as const }
      : null),
    // CSS positive angles are clockwise; store counterclockwise turns.
    transform: rotated ? `rotate(-${rotated}deg)` : undefined,
  }

  const mediaControls = (
    <div className="modal-media-controls" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="btn btn-small modal-nav-btn"
        onClick={goPrev}
        disabled={!canPrev || navBusy}
        title="Previous"
        aria-label="Previous media"
      >
        &lt;
      </button>
      {expanded && (
        <div className="modal-media-zoom-controls">
          <button
            type="button"
            className="btn btn-small modal-zoom-btn"
            onClick={() => bumpZoom(-ZOOM_STEP)}
            disabled={zoom <= ZOOM_MIN}
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className="btn btn-small modal-zoom-btn"
            onClick={setFit}
            disabled={zoom <= ZOOM_MIN}
            title="Fit to window"
            aria-label="Fit to window"
          >
            Fit
          </button>
          <button
            type="button"
            className="btn btn-small modal-zoom-btn"
            onClick={setFill}
            title="Fill window (narrower side)"
            aria-label="Fill window"
          >
            Fill
          </button>
          <button
            type="button"
            className="btn btn-small modal-zoom-btn"
            onClick={() => bumpZoom(ZOOM_STEP)}
            disabled={zoom >= ZOOM_MAX}
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      )}
      <button
        type="button"
        className="media-fullscreen-btn"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Exit full view (F)' : 'Full view (F)'}
        aria-label={expanded ? 'Exit full view' : 'Full view'}
      >
        {expanded ? (
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              fill="currentColor"
              d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              fill="currentColor"
              d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"
            />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="btn btn-small modal-nav-btn"
        onClick={goNext}
        disabled={!canNext || navBusy}
        title="Next"
        aria-label="Next media"
      >
        &gt;
      </button>
    </div>
  )

  return (
    <div
      ref={backdropRef}
      className={`modal-backdrop${expanded ? ' modal-backdrop-expanded' : ''}${
        stackElevated ? ' modal-backdrop-elevated' : ''
      }`}
      onClick={onClose}
    >
      {mediaControls}
      <button
        type="button"
        className="modal-viewer-close"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        disabled={busy}
        title="Close"
        aria-label="Close"
      >
        ×
      </button>
      <MediaViewerChrome
        media={media}
        index={fileIndex}
        total={fileTotal}
        onRotate={() => setRotationDeg((deg) => (deg + 90) % 360)}
        detailActions={
          <>
            <div className="modal-viewer-info-actions-row">
              {scrapeEnabled && sourceUrls.length > 0 && (
                <>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy || contentLocked}
                    onClick={() => refreshTagsMutation.mutate()}
                  >
                    {refreshTagsMutation.isPending ? 'Updating tags…' : 'Update tags from URLs'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-primary"
                    disabled={busy}
                    onClick={() => rescrapeMutation.mutate()}
                  >
                    {rescrapeMutation.isPending ? 'Rescraping…' : 'Rescrape media'}
                  </button>
                </>
              )}
              <button
                type="button"
                className={`btn btn-small${relatedOpen ? ' btn-primary' : ''}`}
                disabled={busy}
                onClick={() => {
                  setRelatedOpen((open) => {
                    const next = !open
                    if (next) setExpanded(false)
                    return next
                  })
                }}
                aria-expanded={relatedOpen}
              >
                Add related files
              </button>
            </div>
            <div className="modal-viewer-info-actions-row">
              <button
                type="button"
                className={`btn btn-small btn-compact${media.is_discarded ? ' btn-primary' : ''}`}
                disabled={busy}
                title={media.is_discarded ? 'Restore (Delete)' : 'Discard (Delete)'}
                aria-keyshortcuts="Delete"
                onClick={() => void promptDiscard()}
              >
                {media.is_discarded ? 'Restore' : 'Discard'}
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger btn-compact"
                disabled={busy}
                title="Delete permanently (Ctrl+Delete)"
                onClick={() => void promptDeletePermanent()}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete permanently'}
              </button>
              {isLinked && (
                <button
                  type="button"
                  className="btn btn-small btn-danger btn-compact"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Delete from local folder',
                      message:
                        'Delete the file from its folder and keep a copy in the library, like a scraped file? The folder file cannot be restored.',
                      confirmLabel: 'Delete file',
                      danger: true,
                    })
                    if (ok) deleteLocalFileMutation.mutate()
                  }}
                >
                  {deleteLocalFileMutation.isPending
                    ? 'Deleting file…'
                    : 'Delete from local folder'}
                </button>
              )}
            </div>
            <p className="modal-viewer-info-hint">
              {expanded
                ? 'Use ← → to navigate · Esc exits full view · F toggles full view · Delete discards · Ctrl+Delete deletes · Ctrl+scroll to zoom'
                : 'Use ← → to navigate · F full view · Esc closes · Delete discards/restores · Ctrl+Delete deletes'}
            </p>
          </>
        }
      />
      <div className="modal-stage">
        {/* Empty stage/backdrop closes; only the panel and control bar keep the click. */}
        <div ref={modalRef} className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-media-wrap">
            <div className="modal-media" onWheel={onMediaWheel}>
              <div
                ref={mediaScrollRef}
                className={`modal-media-scroll${mediaScrollClass ? ` ${mediaScrollClass}` : ''}`}
              >
                <ContentHideMedia item={media} className="content-hide-media-fill">
                  {media.media_type === 'video' ? (
                    <video
                      src={media.media_url}
                      controls={!isLocked(media)}
                      autoPlay={!isLocked(media)}
                      loop
                      muted={false}
                      style={mediaStyle}
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget
                        captureNatural(v.videoWidth, v.videoHeight)
                        if (isLocked(media)) {
                          v.pause()
                          v.currentTime = 0
                        }
                      }}
                    />
                  ) : (
                    <img
                      src={media.media_url}
                      alt={displayNumber}
                      style={mediaStyle}
                      onLoad={(e) => {
                        const img = e.currentTarget
                        captureNatural(img.naturalWidth, img.naturalHeight)
                      }}
                    />
                  )}
                </ContentHideMedia>
              </div>
            </div>
          </div>
          {!expanded && (
            <>
        <div className="source-meta-block">
          <div className="source-meta-header">
            <span className="source-label">Source URLs</span>
            <span className="source-id" title={numbering === 'db' ? 'Database ID' : 'Source post id'}>
              #{displayNumber}
              {numbering === 'db' ? (
                <span className="source-id-secondary"> · source #{sourceNumber}</span>
              ) : (
                <span className="source-id-secondary"> · id {media.id}</span>
              )}
              {(formatPixelSize(naturalSize.w, naturalSize.h) ||
                formatFileSize(media.file_size)) && (
                <span className="source-id-secondary">
                  {' '}
                  ·{' '}
                  {[
                    formatPixelSize(naturalSize.w, naturalSize.h),
                    formatFileSize(media.file_size),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
            </span>
          </div>
          {contentLocked ? (
            <div className="content-hide-meta-placeholder">
              <p className="settings-hint">Source URLs are hidden until content is shown.</p>
              <button
                type="button"
                className="btn btn-small"
                disabled={busy || revealing}
                onClick={() => void revealForMedia(media)}
              >
                Show hidden content
              </button>
            </div>
          ) : (
            <>
              {sourceUrls.length > 0 ? (
              <ul className="source-url-list">
                {(() => {
                  const primaryUrl = sourceUrls[0]
                  const extraUrls = sourceUrls.slice(1)
                  const canRemoveUrl = isLinked ? sourceUrls.length >= 1 : sourceUrls.length > 1
                  const renderUrlRow = (url: string) =>
                    editingUrl === url ? (
                      <div className="source-url-add">
                        <input
                          type="url"
                          value={editUrlValue}
                          onChange={(e) => setEditUrlValue(e.target.value)}
                          disabled={busy}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              saveEditedUrl(url)
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault()
                              setEditingUrl(null)
                              setEditUrlValue('')
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={busy}
                          onClick={() => saveEditedUrl(url)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={busy}
                          onClick={() => {
                            setEditingUrl(null)
                            setEditUrlValue('')
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="source-url-main">
                          <a href={url} target="_blank" rel="noreferrer" className="source-url">
                            {url}
                          </a>
                          {url === primaryUrl ? (
                            <span className="source-primary">primary</span>
                          ) : null}
                        </span>
                        <span className="source-url-actions">
                          <button
                            type="button"
                            className="btn btn-small url-make-primary"
                            disabled={busy || url === primaryUrl}
                            aria-hidden={url === primaryUrl}
                            tabIndex={url === primaryUrl ? -1 : 0}
                            style={{ visibility: url === primaryUrl ? 'hidden' : 'visible' }}
                            onClick={() => makePrimaryUrl(url)}
                          >
                            Make primary
                          </button>
                          <button
                            type="button"
                            className="btn btn-small"
                            disabled={busy}
                            onClick={() => {
                              setEditingUrl(url)
                              setEditUrlValue(url)
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn-small btn-danger"
                            disabled={busy || !canRemoveUrl}
                            aria-hidden={!canRemoveUrl}
                            tabIndex={canRemoveUrl ? 0 : -1}
                            style={{ visibility: canRemoveUrl ? 'visible' : 'hidden' }}
                            onClick={() => removeSourceUrl(url)}
                          >
                            Remove
                          </button>
                        </span>
                      </>
                    )
                  return (
                    <>
                      <li key={primaryUrl} className="source-url-row">
                        {renderUrlRow(primaryUrl)}
                      </li>
                      {extraUrls.length > 0 ? (
                        <li className="source-url-extra">
                          <details>
                            <summary>
                              {extraUrls.length} more URL{extraUrls.length === 1 ? '' : 's'}
                            </summary>
                            <ul className="source-url-list source-url-list-nested">
                              {extraUrls.map((url) => (
                                <li key={url} className="source-url-row">
                                  {renderUrlRow(url)}
                                </li>
                              ))}
                            </ul>
                          </details>
                        </li>
                      ) : null}
                    </>
                  )
                })()}
              </ul>
              ) : null}
              {!urlAddOpen ? (
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => setUrlAddOpen(true)}
                  aria-expanded={false}
                >
                  + Add URL
                </button>
              ) : (
                <div className="source-url-add">
                  <input
                    type="url"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    placeholder="https://..."
                    disabled={busy}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addUrl()
                      }
                    }}
                  />
                  <button type="button" className="btn btn-small" disabled={busy} onClick={addUrl}>
                    Add
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy}
                    onClick={() => {
                      setUrlAddOpen(false)
                      setNewUrl('')
                    }}
                    aria-label="Cancel adding URL"
                  >
                    ×
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        <StarRating
          value={media.rating.my_rating}
          onChange={(score) => ratingMutation.mutate(score)}
          avg={media.rating.avg_rating}
          count={media.rating.rating_count}
        />
        {contentLocked ? (
          <div className="content-hide-meta-placeholder">
            <p className="settings-hint">Tags are hidden until content is shown.</p>
            <button
              type="button"
              className="btn btn-small"
              disabled={busy || revealing}
              onClick={() => void revealForMedia(media)}
            >
              Show hidden content
            </button>
          </div>
        ) : (
          <TagEditor
            media={media}
            selectedFilterTags={selectedFilterTags}
            onToggleViewerFilter={onToggleViewerFilter}
          />
        )}
        {refreshTagsMutation.isError && (
          <div className="error">
            {refreshTagsMutation.error instanceof Error
              ? refreshTagsMutation.error.message
              : 'Tag refresh failed'}
          </div>
        )}
        {rescrapeMutation.isError && (
          <div className="error">
            {rescrapeMutation.error instanceof Error
              ? rescrapeMutation.error.message
              : 'Rescrape failed'}
          </div>
        )}
        {deleteMutation.isError && (
          <div className="error">
            {deleteMutation.error instanceof Error
              ? deleteMutation.error.message
              : 'Delete failed'}
          </div>
        )}
        {deleteLocalFileMutation.isError && (
          <div className="error">
            {deleteLocalFileMutation.error instanceof Error
              ? deleteLocalFileMutation.error.message
              : 'Delete from folder failed'}
          </div>
        )}
        {relatedOpen && (
          <div className="duplicate-detail">
            <h3>Add related files</h3>
            <RelatedMediaPicker
              key={media.id}
              sourceId={media.id}
              initialTags={contentLocked ? [] : media.tags.map((tag) => tag.name)}
            />
            {related && related.items.length > 1 &&
              (() => {
                const primary =
                  related.items.find((item) => item.id === related.primary_id) ?? related.items[0]
                const identicalItems = [
                  primary,
                  ...related.items.filter(
                    (item) =>
                      item.id !== primary.id && item.duplicate_kind === 'identical',
                  ),
                ]
                const similarItems = [
                  primary,
                  ...related.items.filter((item) => item.duplicate_kind === 'similar'),
                ]
                return (
                  <>
                    {identicalItems.length > 1 && (
                      <>
                        <h4>Identical</h4>
                        <DuplicateGroupCard
                          group={{ primary_id: related.primary_id, items: identicalItems }}
                          kind="identical"
                        />
                      </>
                    )}
                    {similarItems.length > 1 && (
                      <>
                        <h4>Similar</h4>
                        <DuplicateGroupCard
                          group={{ primary_id: related.primary_id, items: similarItems }}
                          kind="similar"
                        />
                      </>
                    )}
                  </>
                )
              })()}
          </div>
        )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
