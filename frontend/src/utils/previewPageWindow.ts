/**
 * Pages of card previews kept decoded on each side of the open page.
 * `1` keeps the previous page and the next page. `2` keeps two before and two after.
 */
export const PREVIEW_PAGE_RADIUS = 1

function pageRadius(radius: number): number {
  if (!Number.isFinite(radius) || radius < 0) return 0
  return Math.floor(radius)
}

/** Open page, plus `radius` pages before it and `radius` pages after it. */
export function previewWindowPages(
  page: number,
  totalPages: number,
  radius = PREVIEW_PAGE_RADIUS,
): number[] {
  const last = Math.max(1, totalPages)
  const current = Math.min(Math.max(1, page), last)
  const span = pageRadius(radius)
  const pages: number[] = []
  for (let offset = span; offset >= 1; offset -= 1) {
    const before = current - offset
    if (before >= 1) pages.push(before)
  }
  pages.push(current)
  for (let offset = 1; offset <= span; offset += 1) {
    const after = current + offset
    if (after <= last) pages.push(after)
  }
  return pages
}

/**
 * Current page first, then the following pages (nearest first), then any missing
 * previous pages (nearest first). Opening page 1 loads page 1, then the pages after it.
 */
export function previewLoadOrder(
  page: number,
  totalPages: number,
  alreadyWarm: ReadonlySet<number>,
  radius = PREVIEW_PAGE_RADIUS,
): number[] {
  const windowPages = previewWindowPages(page, totalPages, radius)
  const current = windowPages.includes(page) ? page : windowPages[0]
  const order = [current]
  for (const target of windowPages) {
    if (target > current) order.push(target)
  }
  for (const target of windowPages) {
    if (target < current && !alreadyWarm.has(target)) order.push(target)
  }
  return order
}

export interface PreviewHandle {
  release: () => void
  /** Resolves when this picture is decoded, or failed. */
  ready?: Promise<void>
}

/**
 * Holds decoded preview handles for one list. Pages outside the radius window are released.
 */
export function createPreviewWindow(load: (url: string) => PreviewHandle) {
  let sessionKey = ''
  const pages = new Map<number, { signature: string; handles: PreviewHandle[] }>()

  function releasePage(page: number) {
    const slot = pages.get(page)
    if (!slot) return
    for (const handle of slot.handles) handle.release()
    pages.delete(page)
  }

  function reset(nextSession: string) {
    if (nextSession === sessionKey) return
    for (const page of [...pages.keys()]) releasePage(page)
    sessionKey = nextSession
  }

  return {
    warmPages(): Set<number> {
      return new Set(pages.keys())
    },
    /** Drop pages outside `keep`, and decode `updates` that are not already held. */
    sync(nextSession: string, keep: readonly number[], updates: ReadonlyMap<number, readonly string[]>) {
      reset(nextSession)
      const keepSet = new Set(keep)
      for (const page of [...pages.keys()]) {
        if (!keepSet.has(page)) releasePage(page)
      }
      for (const [page, urls] of updates) {
        if (!keepSet.has(page)) continue
        const signature = urls.join('\n')
        const existing = pages.get(page)
        if (existing?.signature === signature) continue
        releasePage(page)
        pages.set(page, {
          signature,
          handles: urls.map((url) => load(url)),
        })
      }
    },
    async wait(page: number) {
      const slot = pages.get(page)
      if (!slot) return
      await Promise.all(slot.handles.map((handle) => handle.ready ?? Promise.resolve()))
    },
    releaseAll() {
      for (const page of [...pages.keys()]) releasePage(page)
      sessionKey = ''
    },
  }
}
