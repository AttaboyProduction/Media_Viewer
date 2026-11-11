export type ViewerSort =
  | 'date_desc'
  | 'date_asc'
  | 'rating_desc'
  | 'rating_asc'
  | 'random'

export type ScrapeSort = 'date_desc' | 'date_asc'

export type GridThumbnailSize = 'compact' | 'normal' | 'large'

export type UntypedTagGroup = 'unknown' | 'default'

export type TagsSortMode = 'name' | 'order'

export type TagsAutoOrderMode = 'end' | 'by_name'

/** How selected tags/groups appear in picker and viewer filter lists. */
export type TagsSelectDisplayMode = 'highlight' | 'front' | 'panel'

/** Viewer tag filter: chips above the grid, or a left sidebar. */
export type ViewerTagLayout = 'chips' | 'sidebar'

/** Blur media that have any of these tags until the rule id is revealed. */
export interface ContentHideRule {
  id: string
  /** Display name in Settings; defaults to Rule #N. */
  label: string
  tag_names: string[]
  message: string
}

export interface AppSettings {
  display_mode: 'browser' | 'window'
  display_tag_aliases: boolean
  hide_scrape_page: boolean
  theme: 'dark' | 'light' | 'system'
  viewer_exclude_tags: string
  viewer_exclude_tag_groups: string
  viewer_hide_excluded_tags: boolean
  viewer_sort: ViewerSort
  viewer_page_size: number
  /** Dropdown options for Viewer items-per-page (not including live selection). */
  viewer_page_sizes: number[]
  viewer_include_discarded: boolean
  scrape_default_limit: number
  scrape_default_sort: ScrapeSort
  scrape_default_exclude_tags: string
  phash_threshold: number
  tags_page_size: number
  /** Dropdown options for Tags per-page (All / 0 is always appended in the UI). */
  tags_page_sizes: number[]
  grid_thumbnail_size: GridThumbnailSize
  grid_video_autoplay: boolean
  media_open_on_double_click: boolean
  tag_group_color_palette: string[]
  tag_group_color_next_index: number
  tag_group_default_color: string
  tag_group_next_color: string
  tags_untyped_group: UntypedTagGroup
  tags_sort_mode: TagsSortMode
  tags_auto_order_mode: TagsAutoOrderMode
  tags_select_display_mode: TagsSelectDisplayMode
  viewer_tag_layout: ViewerTagLayout
  launch_on_startup: boolean
  start_minimized: boolean
  viewer_media_numbering: 'source' | 'db'
  media_detail_tags_collapsed: boolean
  /** Scrape downloads panel: false = this session; true = all library downloads by scraped_at. */
  scrape_downloads_show_all: boolean
  /** Items per page on Scrape "Downloaded previously" panel. */
  scrape_downloads_page_size: number
  /** Do not download a new post when it is identical to a file already in the library. */
  scrape_skip_identical: boolean
  /** auto = Obscura when installed, otherwise Playwright Chromium. */
  scrape_browser: 'auto' | 'obscura' | 'playwright'
  /** Installed scrape browsers. Default follows Windows metered-connection status. */
  check_browser_updates_on_start: boolean
  /** Rules that blur matching media until revealed. */
  content_hide_rules: ContentHideRule[]
  /** Rule ids unlocked once; persisted so reveal is one-time. */
  content_hide_revealed_rule_ids: string[]
}

export const VIEWER_PAGE_SIZE_MIN = 1
export const VIEWER_PAGE_SIZE_MAX = 200
export const TAGS_PAGE_SIZE_MIN = 1
export const TAGS_PAGE_SIZE_MAX = 500

/** Default Viewer items-per-page options (also the fallback list). */
export const VIEWER_PAGE_SIZES = [12, 24, 36, 48, 60, 72, 84, 96] as const

/** Default Tags per-page options (All is always appended in the UI). */
export const TAGS_PAGE_SIZES = [25, 50, 100] as const

/** Compact cards on Scrape downloads panel — multiples of 18. */
export const SCRAPE_DOWNLOAD_PAGE_SIZES = [18, 36, 54, 72, 90] as const

export const DEFAULT_APP_SETTINGS: AppSettings = {
  display_mode: 'browser',
  display_tag_aliases: true,
  hide_scrape_page: false,
  theme: 'system',
  viewer_exclude_tags: '',
  viewer_exclude_tag_groups: '',
  viewer_hide_excluded_tags: false,
  viewer_sort: 'date_desc',
  viewer_page_size: 36,
  viewer_page_sizes: [...VIEWER_PAGE_SIZES],
  viewer_include_discarded: false,
  scrape_default_limit: 10,
  scrape_default_sort: 'date_desc',
  scrape_default_exclude_tags: '',
  phash_threshold: 8,
  tags_page_size: 50,
  tags_page_sizes: [...TAGS_PAGE_SIZES],
  grid_thumbnail_size: 'normal',
  grid_video_autoplay: false,
  media_open_on_double_click: false,
  tag_group_color_palette: [
    '#e74c3c',
    '#3498db',
    '#f39c12',
    '#9b59b6',
    '#7f8c8d',
    '#8e44ad',
    '#95a5a6',
  ],
  tag_group_color_next_index: 0,
  tag_group_default_color: '#bdc3c7',
  tag_group_next_color: '#e74c3c',
  tags_untyped_group: 'default',
  tags_sort_mode: 'order',
  tags_auto_order_mode: 'by_name',
  tags_select_display_mode: 'panel',
  viewer_tag_layout: 'chips',
  launch_on_startup: false,
  start_minimized: true,
  viewer_media_numbering: 'source',
  media_detail_tags_collapsed: true,
  scrape_downloads_show_all: false,
  scrape_downloads_page_size: 18,
  scrape_skip_identical: false,
  scrape_browser: 'auto',
  check_browser_updates_on_start: true,
  content_hide_rules: [],
  content_hide_revealed_rule_ids: [],
}
