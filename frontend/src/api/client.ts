import type {
  AdaptersStatus,
  DuplicateAction,
  DuplicateGroup,
  DuplicateReview,
  MediaItem,
  MediaListResponse,
  Rating,
  ScrapeRunRequest,
  ScrapeSession,
  ScrapeStatus,
  Tag,
  TagGroup,
} from '../types'

const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(detail || res.statusText)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export type TagMatchMode = 'and' | 'or'

export interface MediaFilters {
  page?: number
  page_size?: number
  tags?: string[]
  tag_mode?: TagMatchMode
  media_type?: string
  min_rating?: number
  include_discarded?: boolean
  exclude_tags?: string[]
  exclude_tag_groups?: string[]
  exclude_id?: number
  sort?: string
}

export function fetchMedia(filters: MediaFilters = {}) {
  const params = new URLSearchParams()
  if (filters.page) params.set('page', String(filters.page))
  if (filters.page_size) params.set('page_size', String(filters.page_size))
  if (filters.tags?.length) {
    params.set('tags', filters.tags.join(','))
    if (filters.tag_mode) params.set('tag_mode', filters.tag_mode)
  }
  if (filters.media_type) params.set('media_type', filters.media_type)
  if (filters.min_rating) params.set('min_rating', String(filters.min_rating))
  if (filters.include_discarded) params.set('include_discarded', 'true')
  if (filters.exclude_tags?.length) params.set('exclude_tags', filters.exclude_tags.join(','))
  if (filters.exclude_tag_groups?.length) {
    params.set('exclude_tag_groups', filters.exclude_tag_groups.join(','))
  }
  if (filters.exclude_id) params.set('exclude_id', String(filters.exclude_id))
  if (filters.sort) params.set('sort', filters.sort)
  return request<MediaListResponse>(`/media?${params}`)
}

export function fetchMediaById(id: number) {
  return request<MediaItem>(`/media/${id}`)
}

export function updateMediaTags(id: number, add: string[], remove: string[]) {
  return request<MediaItem>(`/media/${id}/tags`, {
    method: 'PATCH',
    body: JSON.stringify({ add, remove }),
  })
}

export function discardMedia(id: number, is_discarded: boolean) {
  return request<MediaItem>(`/media/${id}/discard`, {
    method: 'PATCH',
    body: JSON.stringify({ is_discarded }),
  })
}

export function setRating(id: number, score: number) {
  return request<Rating>(`/media/${id}/rating`, {
    method: 'PUT',
    body: JSON.stringify({ score }),
  })
}

export function updateMediaUrls(id: number, add: string[], remove: string[]) {
  return request<MediaItem>(`/media/${id}/urls`, {
    method: 'PATCH',
    body: JSON.stringify({ add, remove }),
  })
}

export function refreshMediaTags(id: number) {
  return request<MediaItem>(`/media/${id}/refresh-tags`, { method: 'POST' })
}

export function rescrapeMedia(id: number) {
  return request<MediaItem>(`/media/${id}/rescrape`, { method: 'POST' })
}

export function deleteMedia(id: number) {
  return request<void>(`/media/${id}`, { method: 'DELETE' })
}

export function deleteLinkedMediaFile(id: number) {
  return request<void>(`/media/${id}/local-file`, { method: 'DELETE' })
}

export function bulkMediaAction(ids: number[], action: 'discard' | 'delete') {
  return request<{ processed: number[]; missing: number[] }>('/media/bulk', {
    method: 'POST',
    body: JSON.stringify({ ids, action }),
  })
}

export function bulkAddMediaTags(ids: number[], add: string[]) {
  return request<{ processed: number[]; missing: number[]; added_tag_names: string[] }>(
    '/media/bulk-tags',
    {
      method: 'POST',
      body: JSON.stringify({ ids, add }),
    },
  )
}

export function fetchTags() {
  return request<Tag[]>('/tags')
}

export function recalculateTagUsage() {
  return request<{ updated: number }>('/tags/recalculate-usage', { method: 'POST' })
}

export function createTag(name: string, group_ids: number[] = [], sort_order?: number) {
  return request<Tag>('/tags', {
    method: 'POST',
    body: JSON.stringify({
      name,
      group_ids,
      ...(sort_order !== undefined ? { sort_order } : {}),
    }),
  })
}

export function fetchTagGroups() {
  return request<TagGroup[]>('/tag-groups')
}

export function createTagGroup(data: {
  key: string
  label: string
  default_color?: string
  sort_order?: number
}) {
  return request<TagGroup>('/tag-groups', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function reindexTagOrder(group_id?: number) {
  const query = group_id != null ? `?group_id=${group_id}` : ''
  return request<{ ok: boolean; updated: number }>(`/tags/reindex-order${query}`, {
    method: 'POST',
  })
}

export function reindexTagGroupOrder() {
  return request<{ ok: boolean; updated: number }>('/tag-groups/reindex-order', {
    method: 'POST',
  })
}

export function mergeTags(source_ids: number[], target_id?: number, new_name?: string) {
  return request<Tag>('/tags/merge', {
    method: 'POST',
    body: JSON.stringify({ source_ids, target_id, new_name }),
  })
}

export function mergeTagGroups(source_ids: number[], target_id: number) {
  return request<TagGroup>('/tag-groups/merge', {
    method: 'POST',
    body: JSON.stringify({ source_ids, target_id }),
  })
}

export function renameTag(tag_id: number, new_name: string) {
  return request<Tag>('/tags/rename', {
    method: 'POST',
    body: JSON.stringify({ tag_id, new_name }),
  })
}

export function aliasTag(alias_id: number, canonical_id: number) {
  return request<Tag>('/tags/alias', {
    method: 'POST',
    body: JSON.stringify({ alias_id, canonical_id }),
  })
}

export function aliasTagsBatch(alias_ids: number[], canonical_id: number) {
  return request<Tag>('/tags/alias-batch', {
    method: 'POST',
    body: JSON.stringify({ alias_ids, canonical_id }),
  })
}

export function patchTag(
  id: number,
  data: {
    group_id?: number
    add_group_ids?: number[]
    remove_group_ids?: number[]
    replace_group?: { from_id: number; to_id: number }
    color_override?: string | null
    sort_order?: number
  },
) {
  return request<Tag>(`/tags/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export function deleteTag(id: number) {
  return request<{ ok: boolean }>(`/tags/${id}`, { method: 'DELETE' })
}

export function patchTagGroup(
  id: number,
  data: { label?: string; default_color?: string; sort_order?: number; is_default?: boolean },
) {
  return request<TagGroup>(`/tag-groups/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export function deleteTagGroup(id: number) {
  return request<{ ok: boolean }>(`/tag-groups/${id}`, { method: 'DELETE' })
}

export function runScrape(payload: ScrapeRunRequest) {
  return request<ScrapeStatus>('/scrape/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function cancelScrape() {
  return request<ScrapeStatus>('/scrape/cancel', { method: 'POST' })
}

export function fetchScrapeStatus() {
  return request<ScrapeStatus>('/scrape/status')
}

export function clearRecentScrapedMedia() {
  return request<ScrapeStatus>('/scrape/clear-recent', { method: 'POST' })
}

export function fetchRecentScrapedMedia(
  page = 1,
  pageSize = 12,
  tags: string[] = [],
  scope: 'session' | 'all' = 'session',
  tagMode: TagMatchMode = 'and',
  excludeTags: string[] = [],
) {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    scope,
  })
  if (tags.length) {
    params.set('tags', tags.join(','))
    params.set('tag_mode', tagMode)
  }
  if (excludeTags.length) params.set('exclude_tags', excludeTags.join(','))
  return request<MediaListResponse>(`/scrape/recent-media?${params}`)
}

export function fetchScrapeSession() {
  return request<ScrapeSession>('/scrape/session')
}

export function patchScrapeSession(data: {
  selected_source_id?: string | null
  selected_site_id?: string | null
  selected_scraper_id?: string | null
  local_import_folders?: string[]
  local_import_files?: string[]
  local_import_recursive?: boolean
}) {
  return request<ScrapeSession>('/scrape/session', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export function pickLocalImportFiles() {
  return request<{ paths: string[] }>('/scrape/import/pick-files', { method: 'POST' })
}

export function pickLocalImportFolder() {
  return request<{ paths: string[] }>('/scrape/import/pick-folder', { method: 'POST' })
}

export function runLocalImport(paths: string[], recursive: boolean) {
  return request<ScrapeStatus>('/scrape/import/run', {
    method: 'POST',
    body: JSON.stringify({ paths, recursive }),
  })
}

export function fetchDuplicates() {
  return request<DuplicateReview>('/media/duplicates')
}

export function fetchDuplicateGroup(id: number) {
  return request<DuplicateGroup>(`/media/${id}/duplicate-group`).catch((error: Error) => {
    if (error.message.includes('No related files') || error.message.includes('404')) {
      return null
    }
    throw error
  })
}

export function resolveDuplicate(id: number, action: DuplicateAction) {
  return request<MediaItem>(`/media/${id}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  })
}

export function mergeDuplicates(payload: {
  keep_id: number
  merge_ids: number[]
  rating_from_id?: number | null
}) {
  return request<MediaItem>('/media/duplicates/merge', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function keepDuplicates(keepIds: number[], scopeIds: number[]) {
  return request<DuplicateReview>('/media/duplicates/keep', {
    method: 'POST',
    body: JSON.stringify({ keep_ids: keepIds, scope_ids: scopeIds }),
  })
}

export function markRelated(id: number, ids: number[], kind: 'identical' | 'similar') {
  return request<DuplicateGroup>(`/media/${id}/related`, {
    method: 'POST',
    body: JSON.stringify({ ids, kind }),
  })
}

export function markRelatedMany(ids: number[], kind: 'identical' | 'similar') {
  return request<DuplicateReview>('/media/duplicates/mark', {
    method: 'POST',
    body: JSON.stringify({ ids, kind }),
  })
}

import type { AppSettings } from '../types/appSettings'

export type { AppSettings } from '../types/appSettings'

export function fetchAppSettings() {
  return request<AppSettings>('/app/settings')
}

export function patchAppSettings(data: Partial<AppSettings>) {
  return request<AppSettings>('/app/settings', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export function restartApp() {
  return request<{ ok: boolean }>('/app/restart', { method: 'POST' })
}

export function shutdownApp() {
  return request<{ ok: boolean }>('/app/shutdown', { method: 'POST' })
}

export interface BrowserEngineStatus {
  id: string
  name: string
  installed: boolean
  path: string | null
  version: string | null
}

export interface BrowsersStatus {
  selected: 'auto' | 'obscura' | 'playwright'
  resolved: 'obscura' | 'playwright'
  engines: BrowserEngineStatus[]
  /** Why the last Auto scrape fell back from Obscura to Playwright Chromium. */
  fallback_error: string | null
  /** Launcher's daily update check (runs only while the Scrape page is enabled). */
  last_update_check: { checked_at: number; results: string[] } | null
  /** Windows reports the current internet connection as metered. */
  connection_metered: boolean
}

export function fetchBrowsers() {
  return request<BrowsersStatus>('/app/browsers')
}

export function installBrowser(engine: 'obscura' | 'playwright') {
  return request<BrowsersStatus>('/app/browsers/install', {
    method: 'POST',
    body: JSON.stringify({ engine }),
  })
}

export function fetchAdapters() {
  return request<AdaptersStatus>('/app/adapters')
}

export function installAdapter(payload: { from_project?: string; path?: string }) {
  return request<AdaptersStatus>('/app/adapters/install', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function pickAdapterFolder() {
  return request<{ path: string | null }>('/app/adapters/pick-folder', { method: 'POST' })
}

export function openViewerWindow() {
  return request<{ ok: boolean; mode: string }>('/app/open-viewer', { method: 'POST' })
}
