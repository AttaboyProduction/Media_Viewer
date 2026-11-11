import { useEffect, useRef, useState, type WheelEvent } from 'react'
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
import RelatedMediaPicker from './RelatedMediaPicker'
import StarRating from './StarRating'
import TagEditor from './TagEditor'
import { useConfirm } from '../context/ConfirmContext'
import { useContentHide } from '../hooks/useContentHide'
import { DEFAULT_APP_SETTINGS } from '../types/appSettings'
import { registerEscapeHandler } from '../utils/escapeStack'

interface Props {
  mediaId: number
  mediaIds: number[]
  onClose: () => void
  onNavigate: (id: number) => void
}

const ZOOM_MIN = 1
const ZOOM_MAX = 8
const ZOOM_STEP = 0.25
/** Keep Fill/Fit slightly inside the media viewport to avoid edge overflow flicker. */
const VIEWPORT_FILL_SLACK = 0.98

function clampZoom(z: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z / ZOOM_STEP) * ZOOM_STEP))
}

/** Round up to the zoom step so Fill always covers (never snaps back down to Fit). */
function ceilZoom(z: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.ceil(z / ZOOM_STEP - 1e-9) * ZOOM_STEP))
}

export default function MediaDetailModal({ mediaId, mediaIds, onClose, onNavigate }: Props) {
  const queryClient = useQueryClient()
  const { confirm } = useConfirm()
  const { isLocked, revealForMedia, revealing } = useContentHide()
  const [newUrl, setNewUrl] = useState('')
  const [relatedOpen, setRelatedOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [urlAddOpen, setUrlAddOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 })
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 })
  const viewportRef = useRef<HTMLDivElement>(null)
  const mediaScrollRef = useRef<HTMLDivElement>(null)
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
  const discardMutation = useMutation({
    mutationFn: (discarded: boolean) => discardMedia(mediaId, discarded),
    onSuccess: (_, discarded) => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      if (discarded) onClose()
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
    mutationFn: (payload: { add: string[]; remove: string[] }) =>
      updateMediaUrls(mediaId, payload.add, payload.remove),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      setNewUrl('')
      setUrlAddOpen(false)
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media'] })
      queryClient.invalidateQueries({ queryKey: ['duplicates'] })
      onClose()
    },
  })
  const isLinked = media?.storage_kind === 'linked'
  // Keep expanded full view across ‹ › / arrow navigation; only reset per-item chrome.
  useEffect(() => {
    setUrlAddOpen(false)
    setNewUrl('')
    setRelatedOpen(false)
    setZoom(1)
    setNaturalSize({ w: 0, h: 0 })
  }, [mediaId])

  useEffect(() => {
    if (!expanded) setZoom(1)
  }, [expanded])

  useEffect(() => {
    const el = viewportRef.current
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
      const box = entry.contentBoxSize?.[0]
      if (box) {
        measure(box.inlineSize, box.blockSize)
        return
      }
      measure(entry.contentRect.width, entry.contentRect.height)
    })
    ro.observe(el)
    measure(el.clientWidth, el.clientHeight)
    return () => ro.disconnect()
  }, [expanded, mediaId])

  const ids = mediaIds
  const idx = ids.indexOf(mediaId)
  const canPrev = idx > 0
  const canNext = idx >= 0 && idx < ids.length - 1
  const goPrev = () => {
    if (canPrev) onNavigate(ids[idx - 1])
  }
  const goNext = () => {
    if (canNext) onNavigate(ids[idx + 1])
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
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
    }
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
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
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
        const step = Math.max(48, Math.floor(target.clientHeight * (e.repeat ? 0.12 : 0.18)))
        target.scrollBy({
          top: e.key === 'ArrowUp' ? -step : step,
          behavior: e.repeat ? 'auto' : 'smooth',
        })
        return
      }
      const list = mediaIds
      const i = list.indexOf(mediaId)
      if (i < 0) return
      if (e.key === 'ArrowLeft' && i > 0) {
        e.preventDefault()
        onNavigate(list[i - 1])
      }
      if (e.key === 'ArrowRight' && i < list.length - 1) {
        e.preventDefault()
        onNavigate(list[i + 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mediaIds, mediaId, onNavigate])

  const fitScale =
    naturalSize.w > 0 && naturalSize.h > 0 && viewportSize.w > 0 && viewportSize.h > 0
      ? Math.min(viewportSize.w / naturalSize.w, viewportSize.h / naturalSize.h) *
        VIEWPORT_FILL_SLACK
      : 1
  const fillZoom =
    naturalSize.w > 0 && naturalSize.h > 0 && viewportSize.w > 0 && viewportSize.h > 0 && fitScale > 0
      ? (Math.max(viewportSize.w / naturalSize.w, viewportSize.h / naturalSize.h) *
          VIEWPORT_FILL_SLACK) /
        fitScale
      : 1
  // Floor so fill/fit sizes stay inside the padded viewport.
  const displayW =
    naturalSize.w > 0 ? Math.max(1, Math.floor(naturalSize.w * fitScale * zoom)) : undefined
  const displayH =
    naturalSize.h > 0 ? Math.max(1, Math.floor(naturalSize.h * fitScale * zoom)) : undefined
  // Pan only on axes that actually overflow (avoids a useless horizontal bar).
  const allowScrollX =
    expanded && displayW != null && displayW > viewportSize.w + 1
  const allowScrollY =
    expanded && displayH != null && displayH > viewportSize.h + 1
  const mediaScrollClass = [
    allowScrollX ? 'modal-media-scroll-x' : '',
    allowScrollY ? 'modal-media-scroll-y' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const bumpZoom = (delta: number) => setZoom((z) => clampZoom(z + delta))
  const setFit = () => setZoom(1)
  const setFill = () => setZoom(ceilZoom(Math.max(fillZoom, 1)))

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
  const sourceUrls =
    media.source_urls && media.source_urls.length > 0 ? media.source_urls : [media.source_url]
  const displayNumber = numbering === 'db' ? String(media.id) : media.source_post_id
  const addUrl = () => {
    const trimmed = newUrl.trim()
    if (!trimmed) return
    urlsMutation.mutate({ add: [trimmed], remove: [] })
  }

  const mediaStyle =
    expanded && displayW != null && displayH != null
      ? { width: displayW, height: displayH, maxWidth: 'none', maxHeight: 'none' }
      : undefined

  const mediaControls = (
    <div className="modal-media-controls" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="btn btn-small modal-nav-btn"
        onClick={goPrev}
        disabled={!canPrev}
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
        disabled={!canNext}
        title="Next"
        aria-label="Next media"
      >
        &gt;
      </button>
    </div>
  )

  return (
    <div
      className={`modal-backdrop${expanded ? ' modal-backdrop-expanded' : ''}`}
      onClick={onClose}
    >
      {mediaControls}
      <div className="modal-stage">
        {/* Empty stage/backdrop closes; only the panel and control bar keep the click. */}
        <div ref={modalRef} className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-media-wrap">
            <div ref={viewportRef} className="modal-media" onWheel={onMediaWheel}>
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
            <span className="source-label">{isLinked ? 'Local file' : 'Source URLs'}</span>
            <span className="source-id" title={numbering === 'db' ? 'Database ID' : 'Source post id'}>
              #{displayNumber}
              {numbering === 'db' ? (
                <span className="source-id-secondary"> · source #{media.source_post_id}</span>
              ) : (
                <span className="source-id-secondary"> · id {media.id}</span>
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
          ) : isLinked ? null : (
            <>
              <ul className="source-url-list">
                {sourceUrls.map((url) => (
                  <li key={url} className="source-url-row">
                    <a href={url} target="_blank" rel="noreferrer" className="source-url">
                      {url}
                    </a>
                    {url === media.source_url && <span className="source-primary">primary</span>}
                    {url !== media.source_url && (
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={busy}
                        onClick={() => urlsMutation.mutate({ add: [], remove: [url] })}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
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
          <TagEditor media={media} />
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
        <div className="actions">
          {scrapeEnabled && !isLinked && (
            <>
              <button
                type="button"
                className="btn"
                disabled={busy || contentLocked}
                onClick={() => refreshTagsMutation.mutate()}
              >
                {refreshTagsMutation.isPending ? 'Updating tags…' : 'Update tags from URLs'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => rescrapeMutation.mutate()}
              >
                {rescrapeMutation.isPending ? 'Rescraping…' : 'Rescrape media'}
              </button>
            </>
          )}
          {media.is_discarded ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => discardMutation.mutate(false)}
            >
              Restore
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Discard media',
                  message: 'Discard this item from viewing?',
                  confirmLabel: 'Discard',
                })
                if (ok) discardMutation.mutate(true)
              }}
            >
              Discard
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={async () => {
              const ok = await confirm({
                title: 'Delete media',
                message: isLinked
                  ? 'Remove this item from the library? The file on disk will not be deleted.'
                  : 'Permanently delete this file and all metadata (tags, ratings)? This cannot be undone.',
                confirmLabel: 'Delete',
                danger: true,
              })
              if (ok) deleteMutation.mutate()
            }}
          >
            {deleteMutation.isPending ? 'Deleting…' : 'Delete permanently'}
          </button>
          {isLinked && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Delete from local folder',
                  message:
                    'Delete the file from its folder on this PC and remove it from the library? This cannot be undone.',
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
          <button
            type="button"
            className={`btn${relatedOpen ? ' btn-primary' : ''}`}
            disabled={busy}
            onClick={() => setRelatedOpen((open) => !open)}
            aria-expanded={relatedOpen}
          >
            Add related files
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
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
                    (item) => item.id !== primary.id && item.duplicate_kind !== 'similar',
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
        <div style={{ fontSize: '0.75rem', color: '#8b95a5', marginTop: 8 }}>
          Use ← → or &lt; &gt; to navigate · F toggles full view · Esc closes full view first
        </div>
            </>
          )}
          {expanded && (
            <div style={{ fontSize: '0.75rem', color: '#8b95a5', marginTop: 8 }}>
              Use ← → or &lt; &gt; to navigate · Esc exits full view · F toggles full view ·
              Ctrl+scroll to zoom
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
