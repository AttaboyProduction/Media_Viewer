import type { ScrapeStatus } from '../types'

/** True when the user is not looking at the Scrape page or the browser window. */
export function scrapeUiNotInFocus(): boolean {
  if (typeof document === 'undefined') return false
  return (
    document.visibilityState === 'hidden' ||
    !document.hasFocus() ||
    window.location.pathname !== '/scrape'
  )
}

export function scrapeFinishedNotificationCopy(status: ScrapeStatus): {
  title: string
  body: string
} {
  const label = (status.source_label || 'Scrape').trim()
  const message = (status.message || 'Done').trim()
  const parts = [message]
  if (status.total > 0) {
    parts.push(`${status.processed}/${status.total} processed`)
  }
  if (status.downloaded > 0) {
    parts.push(`${status.downloaded} downloaded`)
  }
  return {
    title: `${label} finished`,
    body: parts.join(' · '),
  }
}

/** Ask once before a job starts so a background finish can toast without a visible tab. */
export function ensureScrapeNotificationPermission(): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission !== 'default') return
  void Notification.requestPermission()
}

export async function notifyScrapeFinished(status: ScrapeStatus): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission === 'denied') return
  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return
  }
  const { title, body } = scrapeFinishedNotificationCopy(status)
  try {
    new Notification(title, { body, tag: 'mediaviewer-scrape-finished' })
  } catch {
    /* ignored — some hosts block notifications */
  }
}