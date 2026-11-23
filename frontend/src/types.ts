export interface TagGroup {
  id: number
  key: string
  label: string
  default_color: string
  sort_order: number
  is_default: boolean
}

export interface MediaTag {
  id: number
  name: string
  group: TagGroup | null
  groups: TagGroup[]
  display_names: string[]
  color: string
  is_manual: boolean
  sort_order: number
}

export interface Rating {
  my_rating: number | null
  avg_rating: number | null
  rating_count: number
}

export type MediaStorageKind = 'managed' | 'linked'

export interface MediaItem {
  id: number
  source_post_id: string
  source_url: string
  source_urls: string[]
  media_type: string
  storage_kind: MediaStorageKind
  is_discarded: boolean
  scraped_at: string
  media_url: string
  thumbnail_url: string
  tags: MediaTag[]
  rating: Rating
  duplicate_of_id: number | null
  duplicate_kind: 'identical' | 'similar' | null
  file_size: number | null
  source_posted_at: string | null
}

export interface MediaListResponse {
  items: MediaItem[]
  total: number
  page: number
  page_size: number
  /** Frozen max media id for this browse session; null when empty or random sort. */
  cursor?: number | null
}

export interface Tag {
  id: number
  name: string
  group: TagGroup | null
  groups: TagGroup[]
  aliases: string[]
  color: string
  alias_of: string | null
  usage_count: number
  is_deleted: boolean
  sort_order: number
}

export type ScrapeFilterType = 'tag' | 'date_range' | 'url' | 'media_type'

/** Filter row sent to the scrape API. For `date_range`, value is `from..to`
 * where each side is optional ISO local datetime (`YYYY-MM-DD` or
 * `YYYY-MM-DDTHH:mm[:ss]`) from `datetime-local` inputs. */
export interface ScrapeFilter {
  type: ScrapeFilterType
  value: string
}

export interface ScrapeRunRequest {
  filters: ScrapeFilter[]
  sort: 'date_desc' | 'date_asc'
  limit: number
  exclude_tags: string[]
  tag_mode?: 'and' | 'or'
  /** Panel that pressed Run: the selected site id, or `unsupported` to retry raw files. */
  source_key?: string
}

export interface ScrapeSite {
  id: string
  name: string
  base_url: string
  default_gallery_url: string
  media_cdn_host: string
}

/** Scrape agent — can target one or more catalog sites. */
export interface ScrapeAgent {
  id: string
  name: string
  description: string
  site_ids: string[]
}

export interface ScrapeSource {
  id: string
  name: string
  kind: 'site' | 'local'
  base_url: string | null
}

export interface AdapterPackage {
  id: string
  path: string
  site_ids: string[]
  site_names: string[]
}

export interface AdaptersStatus {
  installed: AdapterPackage[]
  project: AdapterPackage[]
}

export interface ScrapeSession {
  selected_source_id: string | null
  selected_source: ScrapeSource | null
  available_sources: ScrapeSource[]
  selected_site_id: string | null
  selected_site: ScrapeSite | null
  selected_scraper_id: string | null
  selected_scraper: ScrapeAgent | null
  available_sites: ScrapeSite[]
  available_scrapers: ScrapeAgent[]
  local_import_folders: string[]
  local_import_files: string[]
  local_import_recursive: boolean
}

export interface ScrapeSkippedItem {
  url: string
  reason: string
  detail?: string
}

/** One source's session numbers and lists: `local`, an installed site id, or `unsupported`. */
export interface ScrapeSourcePanel {
  key: string
  label: string
  running: boolean
  total: number
  processed: number
  downloaded: number
  skipped: number
  similar: number
  message: string
  current_url: string | null
  last_gallery_url: string | null
  errors: string[]
  skipped_items: ScrapeSkippedItem[]
  error_items: ScrapeSkippedItem[]
  cancelled_urls: string[]
  queue_urls: string[]
}

export interface MissingLinkedFile {
  id: number
  path: string
}

export interface ScrapeStatus {
  running: boolean
  total: number
  processed: number
  downloaded: number
  skipped: number
  similar: number
  errors: string[]
  last_gallery_url: string | null
  message: string
  current_url: string | null
  skipped_items: ScrapeSkippedItem[]
  error_items?: ScrapeSkippedItem[]
  cancelled_urls: string[]
  queue_urls: string[]
  hash_backfill_running: boolean
  hash_backfill_total: number
  hash_backfill_done: number
  recent_media_ids: number[]
  ran_this_session: boolean
  /** Linked local rows whose files vanished under a Sync folders root. */
  missing_linked: MissingLinkedFile[]
  source_key: string
  source_label: string
  sources: ScrapeSourcePanel[]
}

export interface DuplicateGroup {
  primary_id: number
  items: MediaItem[]
}

export interface DuplicateReview {
  identical: DuplicateGroup[]
  similar: DuplicateGroup[]
}

export type DuplicateAction = 'keep_both' | 'discard' | 'discard_new' | 'discard_old'
