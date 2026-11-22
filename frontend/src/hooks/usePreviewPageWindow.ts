import { useEffect } from 'react'
import type { MediaItem } from '../types'
import { mediaPreviewUrl, type PreviewSize } from '../utils/mediaPreview'
import { createPreviewWindow, previewLoadOrder, previewWindowPages } from '../utils/previewPageWindow'

const windows = new Map<string, ReturnType<typeof createPreviewWindow>>()

function browserWindow(scope: string) {
  let existing = windows.get(scope)
  if (existing) return existing
  existing = createPreviewWindow((url) => {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    const ready = image.decode ? image.decode().catch(() => undefined) : Promise.resolve()
    return {
      ready,
      release: () => {
        image.onload = null
        image.onerror = null
        image.src = ''
      },
    }
  })
  windows.set(scope, existing)
  return existing
}

function urlsFor(items: Pick<MediaItem, 'id' | 'file_size'>[], size: PreviewSize): string[] {
  return items.map((item) => mediaPreviewUrl(item.id, size, item.file_size))
}

/**
 * Decode the open page first, then `PREVIEW_PAGE_RADIUS` pages after it, and keep that
 * many pages before it. Pages outside that window are released.
 */
export function usePreviewPageWindow(options: {
  /** Separate caches (viewer vs scrape vs related) so one list cannot evict another. */
  scope: string
  enabled: boolean
  /** Changes when filters, sort, page size, or preview size change. */
  sessionKey: string
  page: number
  totalPages: number
  currentItems: Pick<MediaItem, 'id' | 'file_size'>[] | undefined
  previewSize: PreviewSize
  fetchPage: (page: number) => Promise<{ items: Pick<MediaItem, 'id' | 'file_size'>[] }>
}) {
  const { scope, enabled, sessionKey, page, totalPages, currentItems, previewSize, fetchPage } = options

  useEffect(() => {
    if (!enabled || !currentItems) return
    const cache = browserWindow(scope)
    const keep = previewWindowPages(page, totalPages)
    let cancelled = false

    cache.sync(sessionKey, keep, new Map([[page, urlsFor(currentItems, previewSize)]]))

    const run = async () => {
      // Finish the open page before asking the server for the neighbor pages.
      await cache.wait(page)
      if (cancelled) return
      const order = previewLoadOrder(page, totalPages, cache.warmPages())
      for (const target of order) {
        if (cancelled) return
        if (target === page) continue
        if (cache.warmPages().has(target)) continue
        let items: Pick<MediaItem, 'id' | 'file_size'>[]
        try {
          const result = await fetchPage(target)
          items = result.items
        } catch {
          continue
        }
        if (cancelled) return
        cache.sync(sessionKey, keep, new Map([[target, urlsFor(items, previewSize)]]))
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [scope, enabled, sessionKey, page, totalPages, currentItems, previewSize, fetchPage])
}
