import type { ScrapeStatus } from '../types'
import { scrapeFinishedNotificationCopy, scrapeUiNotInFocus } from './scrapeNotification'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

export function runScrapeNotificationSelfTest(): void {
  const status: ScrapeStatus = {
    running: false,
    total: 10,
    processed: 10,
    downloaded: 8,
    skipped: 2,
    similar: 0,
    errors: [],
    last_gallery_url: null,
    message: 'Done',
    current_url: null,
    skipped_items: [],
    cancelled_urls: [],
    queue_urls: [],
    hash_backfill_running: false,
    hash_backfill_total: 0,
    hash_backfill_done: 0,
    recent_media_ids: [],
    ran_this_session: true,
    missing_linked: [],
    source_key: 'site',
    source_label: 'Rule34',
    sources: [],
  }
  const copy = scrapeFinishedNotificationCopy(status)
  assert(copy.title === 'Rule34 finished', `title=${copy.title}`)
  assert(copy.body.includes('8 downloaded'), `body=${copy.body}`)
  assert(typeof scrapeUiNotInFocus() === 'boolean', 'scrapeUiNotInFocus')
}

runScrapeNotificationSelfTest()
console.log('scrapeNotification.selftest: ok')