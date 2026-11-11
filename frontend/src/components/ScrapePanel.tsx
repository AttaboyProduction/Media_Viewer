import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  cancelScrape,
  fetchAdapters,
  fetchAppSettings,
  fetchScrapeSession,
  fetchScrapeStatus,
  fetchTags,
  installAdapter,
  patchScrapeSession,
  pickAdapterFolder,
  pickLocalImportFiles,
  pickLocalImportFolder,
  runLocalImport,
  runScrape,
  patchAppSettings,
} from '../api/client'
import { useApplyAppDefaults } from '../hooks/useAppDefaults'
import { DEFAULT_APP_SETTINGS } from '../types/appSettings'
import type { ScrapeFilter, ScrapeFilterType } from '../types'
import ExcludeTagsPicker from './ExcludeTagsPicker'
import { SearchableTagSingleSelect } from './TagChipSelect'

interface FilterRow {
  id: string
  type: ScrapeFilterType
  value: string
  dateFrom: string
  dateTo: string
}

let rowSeq = 1

function newRow(type: ScrapeFilterType = 'tag'): FilterRow {
  return { id: `f${rowSeq++}`, type, value: '', dateFrom: '', dateTo: '' }
}

/** Only one date range / media type; tags and URLs may repeat. */
const UNIQUE_TYPES: ScrapeFilterType[] = ['date_range', 'media_type']

function splitUrlValues(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function toFilters(rows: FilterRow[]): ScrapeFilter[] {
  const out: ScrapeFilter[] = []
  for (const row of rows) {
    if (row.type === 'date_range') {
      if (!row.dateFrom && !row.dateTo) continue
      out.push({ type: row.type, value: `${row.dateFrom}..${row.dateTo}` })
      continue
    }
    if (row.type === 'url') {
      for (const value of splitUrlValues(row.value)) {
        out.push({ type: 'url', value })
      }
      continue
    }
    if (!row.value.trim()) continue
    out.push({ type: row.type, value: row.value.trim() })
  }
  return out
}

function joinerLabel(
  prev: FilterRow,
  curr: FilterRow,
  tagMode: 'and' | 'or',
): string {
  if (prev.type === 'tag' && curr.type === 'tag') {
    return tagMode === 'or' ? 'OR' : 'AND'
  }
  return '+'
}

function UrlFilterField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const urls = splitUrlValues(value)
  const urlCount = urls.length
  return (
    <div className="scrape-url-field">
      <textarea
        className="scrape-url-input"
        rows={Math.min(8, Math.max(3, urlCount || 3))}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'https://…/post/123\nhttps://…/post/456\n(one URL per line)'}
        spellCheck={false}
      />
      {urlCount > 0 && (
        <span className="settings-hint">
          {urlCount} URL{urlCount === 1 ? '' : 's'} to scrape
        </span>
      )}
    </div>
  )
}

function statusMessageParts(
  message: string,
  currentUrl: string | null | undefined,
): { before: string; url: string | null; after: string } {
  const url = currentUrl?.trim() || null
  if (url && message.includes(url)) {
    const idx = message.indexOf(url)
    return {
      before: message.slice(0, idx),
      url,
      after: message.slice(idx + url.length),
    }
  }
  if (url) {
    return { before: message ? `${message} ` : '', url, after: '' }
  }
  return { before: message, url: null, after: '' }
}

export default function ScrapePanel({ onFinished }: { onFinished: () => void }) {
  const queryClient = useQueryClient()
  const [rows, setRows] = useState<FilterRow[]>([newRow('tag')])
  const [tagMode, setTagMode] = useState<'and' | 'or'>('and')
  const [sort, setSort] = useState<'date_desc' | 'date_asc'>('date_desc')
  const [limit, setLimit] = useState(10)
  const [excludeTags, setExcludeTags] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [skippedOpen, setSkippedOpen] = useState(false)
  const [localFolders, setLocalFolders] = useState<string[]>([])
  const [localFiles, setLocalFiles] = useState<string[]>([])
  const [localRecursive, setLocalRecursive] = useState(true)
  const localHydratedRef = useRef(false)
  const wasRunningRef = useRef(false)

  const { data: tags } = useQuery({ queryKey: ['tags'], queryFn: fetchTags })
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 60_000,
  })
  const { data: session, isLoading: sessionLoading } = useQuery({
    queryKey: ['scrape-session'],
    queryFn: fetchScrapeSession,
    staleTime: 30_000,
  })
  const { data: adapters } = useQuery({
    queryKey: ['adapters'],
    queryFn: fetchAdapters,
    staleTime: 30_000,
  })
  const { data: status = null } = useQuery({
    queryKey: ['scrape-status'],
    queryFn: fetchScrapeStatus,
    refetchInterval: 1000,
  })

  useEffect(() => {
    if (wasRunningRef.current && status && !status.running) {
      onFinished()
    }
    wasRunningRef.current = Boolean(status?.running)
  }, [status, onFinished])

  const selectedSource = session?.selected_source ?? null
  const isLocalSource = selectedSource?.kind === 'local'
  const selectedScraper = session?.selected_scraper ?? null
  const scrapersForSite = useMemo(() => {
    const siteId = session?.selected_site_id
    if (!siteId || !session) return []
    return session.available_scrapers.filter((agent) => agent.site_ids.includes(siteId))
  }, [session])
  const localPaths = useMemo(
    () => [...localFolders, ...localFiles],
    [localFolders, localFiles],
  )

  const sessionMutation = useMutation({
    mutationFn: patchScrapeSession,
    onSuccess: (next) => {
      queryClient.setQueryData(['scrape-session'], next)
    },
  })
  const adapterMutation = useMutation({
    mutationFn: installAdapter,
    onSuccess: async (next) => {
      queryClient.setQueryData(['adapters'], next)
      await queryClient.invalidateQueries({ queryKey: ['scrape-session'] })
    },
    onError: (err: Error) => setError(err.message),
  })
  const installedSiteCount = session?.available_sites.length ?? 0
  const projectAdapters = adapters?.project ?? []
  const installedAdapterIds = new Set((adapters?.installed ?? []).map((item) => item.id))

  // Persist Local when the server still has a null source (pre-adapter sessions).
  useEffect(() => {
    if (!session || sessionLoading || sessionMutation.isPending) return
    if (session.selected_source_id) return
    sessionMutation.mutate({ selected_source_id: 'local' })
  }, [session, sessionLoading, sessionMutation])

  // Always restore previously chosen Local folders/files from session.
  useEffect(() => {
    if (!session || localHydratedRef.current) return
    localHydratedRef.current = true
    setLocalFolders(session.local_import_folders ?? [])
    setLocalFiles(session.local_import_files ?? [])
    setLocalRecursive(session.local_import_recursive ?? true)
  }, [session])

  const persistLocalSelection = useCallback(
    (folders: string[], files: string[], recursive: boolean) => {
      sessionMutation.mutate({
        local_import_folders: folders,
        local_import_files: files,
        local_import_recursive: recursive,
      })
    },
    [sessionMutation],
  )

  const applyScrapeDefaults = useCallback((s: typeof DEFAULT_APP_SETTINGS) => {
    setSort(s.scrape_default_sort)
    setLimit(s.scrape_default_limit)
    setExcludeTags(s.scrape_default_exclude_tags)
  }, [])
  useApplyAppDefaults(appSettings, applyScrapeDefaults)

  const usedUnique = useMemo(
    () => new Set(rows.filter((row) => UNIQUE_TYPES.includes(row.type)).map((row) => row.type)),
    [rows],
  )

  const tagRowCount = useMemo(() => rows.filter((row) => row.type === 'tag').length, [rows])
  const hasUrlFilters = useMemo(
    () => rows.some((row) => row.type === 'url' && splitUrlValues(row.value).length > 0),
    [rows],
  )

  const updateRow = (id: string, patch: Partial<FilterRow>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  const addRow = (type: ScrapeFilterType = 'tag') => setRows((prev) => [...prev, newRow(type)])
  const removeRow = (id: string) => {
    setRows((prev) => {
      if (prev.length === 1) {
        // Keep the last row; clear its values instead of deleting it.
        return prev.map((row) =>
          row.id === id ? { ...row, value: '', dateFrom: '', dateTo: '' } : row,
        )
      }
      return prev.filter((row) => row.id !== id)
    })
  }

  const addLocalFolders = (paths: string[]) => {
    if (!paths.length) return
    setLocalFolders((prev) => {
      const seen = new Set(prev.map((p) => p.toLowerCase()))
      const next = [...prev]
      for (const path of paths) {
        const key = path.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          next.push(path)
        }
      }
      persistLocalSelection(next, localFiles, localRecursive)
      return next
    })
  }

  const addLocalFiles = (paths: string[]) => {
    if (!paths.length) return
    setLocalFiles((prev) => {
      const seen = new Set(prev.map((p) => p.toLowerCase()))
      const next = [...prev]
      for (const path of paths) {
        const key = path.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          next.push(path)
        }
      }
      persistLocalSelection(localFolders, next, localRecursive)
      return next
    })
  }

  const removeLocalFolder = (path: string) => {
    setLocalFolders((prev) => {
      const next = prev.filter((item) => item !== path)
      persistLocalSelection(next, localFiles, localRecursive)
      return next
    })
  }

  const removeLocalFile = (path: string) => {
    setLocalFiles((prev) => {
      const next = prev.filter((item) => item !== path)
      persistLocalSelection(localFolders, next, localRecursive)
      return next
    })
  }

  const setRecursiveAndPersist = (recursive: boolean) => {
    setLocalRecursive(recursive)
    persistLocalSelection(localFolders, localFiles, recursive)
  }

  const startLocalImport = async (paths: string[], recursive: boolean) => {
    const next = await runLocalImport(paths, recursive)
    queryClient.setQueryData(['scrape-status'], next)
  }

  const start = async () => {
    setError(null)
    setSkippedOpen(false)
    if (isLocalSource) {
      if (!localPaths.length) {
        setError('Add at least one folder or file before running.')
        return
      }
      try {
        await startLocalImport(localPaths, localRecursive)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start local import')
      }
      return
    }
    if (!session?.selected_site_id || !session.selected_scraper_id) {
      setError('Choose a site and scraper before running.')
      return
    }
    try {
      const next = await runScrape({
        filters: toFilters(rows),
        sort,
        // URL-filter scrapes ignore the download quota (backend + UI).
        limit: hasUrlFilters ? 0 : limit,
        exclude_tags: excludeTags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        tag_mode: tagMode,
      })
      queryClient.setQueryData(['scrape-status'], next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start scrape')
    }
  }

  const stop = async () => {
    const next = await cancelScrape()
    queryClient.setQueryData(['scrape-status'], next)
  }

  const effectiveLimit = isLocalSource ? 0 : hasUrlFilters ? 0 : limit
  const percent =
    status && effectiveLimit > 0 && (status.running || status.downloaded > 0)
      ? Math.min(100, Math.round((status.downloaded / effectiveLimit) * 100))
      : status && status.total > 0
        ? Math.round((status.processed / status.total) * 100)
        : 0

  const canRun = isLocalSource
    ? localPaths.length > 0 && !status?.running
    : Boolean(session?.selected_site_id && session.selected_scraper_id) && !status?.running
  const canSyncFolders = isLocalSource && localFolders.length > 0 && !status?.running

  const msgParts = status
    ? statusMessageParts(status.message || (status.running ? 'Running...' : 'Idle'), status.current_url)
    : null

  const skippedItems = status?.skipped_items ?? []

  return (
    <div className="panel">
      <div className="scrape-panel-header">
        <h2>Scrape</h2>
        {selectedSource && (
          <span
            className="scrape-site-badge"
            title={selectedSource.base_url || selectedSource.name}
          >
            {selectedSource.name}
          </span>
        )}
      </div>

      <div className="scrape-source">
        <div className="scrape-source-row">
          <label className="scrape-source-field">
            <span className="scrape-source-label">Source</span>
            <select
              value={session?.selected_source_id ?? session?.available_sources[0]?.id ?? ''}
              disabled={
                sessionLoading ||
                sessionMutation.isPending ||
                status?.running ||
                (session?.available_sources.length ?? 0) === 0
              }
              onChange={(e) => {
                sessionMutation.mutate({ selected_source_id: e.target.value })
              }}
            >
              {(session?.available_sources ?? []).map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
            {selectedSource?.kind === 'site' && selectedSource.base_url ? (
              <a
                className="scrape-source-hint scrape-source-link"
                href={selectedSource.base_url}
                target="_blank"
                rel="noreferrer"
              >
                {selectedSource.base_url}
              </a>
            ) : selectedSource?.kind === 'local' ? (
              <span className="scrape-source-hint">
                Link folders or files from this PC (no copy into the app)
              </span>
            ) : (
              <span className="scrape-source-hint">Loading sources…</span>
            )}
          </label>

          {!isLocalSource && (
            <label className="scrape-source-field">
              <span className="scrape-source-label">Scraper</span>
              <select
                value={session?.selected_scraper_id ?? scrapersForSite[0]?.id ?? ''}
                disabled={
                  sessionLoading ||
                  sessionMutation.isPending ||
                  status?.running ||
                  !session?.selected_site_id ||
                  scrapersForSite.length === 0
                }
                onChange={(e) => {
                  sessionMutation.mutate({ selected_scraper_id: e.target.value })
                }}
              >
                {scrapersForSite.length === 0 ? (
                  <option value="">No scrapers for this site</option>
                ) : (
                  scrapersForSite.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))
                )}
              </select>
              <span className="scrape-source-hint">
                {selectedScraper?.description ||
                  (session?.selected_site_id
                    ? 'How media is downloaded from this site'
                    : 'Waiting for a site…')}
              </span>
            </label>
          )}
        </div>
        {(installedSiteCount === 0 || projectAdapters.length > 0) && (
          <div className="scrape-adapters">
            {installedSiteCount === 0 && (
              <p className="scrape-source-hint">
                No site adapters installed. Local import works as-is. Use Install for a package under
                the project <code>adapters/</code> folder, or Load to pick that folder (or another
                path) and install every package inside.
              </p>
            )}
            <div className="scrape-adapter-actions">
              {projectAdapters.map((pkg) => (
                <button
                  key={pkg.id}
                  type="button"
                  className="btn btn-small"
                  disabled={adapterMutation.isPending || status?.running}
                  onClick={() => adapterMutation.mutate({ from_project: pkg.id })}
                  title={`Copy adapters/${pkg.id} into data/adapters/`}
                >
                  {installedAdapterIds.has(pkg.id)
                    ? `Reinstall ${pkg.site_names[0] || pkg.id}`
                    : `Install ${pkg.site_names[0] || pkg.id}`}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-small"
                disabled={adapterMutation.isPending || status?.running}
                title="Opens in project adapters/; pick the whole folder to install all packages, or one package folder"
                onClick={async () => {
                  try {
                    const { path } = await pickAdapterFolder()
                    if (!path) return
                    adapterMutation.mutate({ path })
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err))
                  }
                }}
              >
                Load adapters folder…
              </button>
            </div>
          </div>
        )}
      </div>

      {isLocalSource ? (
        <div className="scrape-local-import">
          <div className="scrape-local-actions">
            <button
              type="button"
              className="btn"
              disabled={Boolean(status?.running)}
              onClick={async () => {
                setError(null)
                try {
                  const result = await pickLocalImportFolder()
                  addLocalFolders(result.paths)
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Folder picker failed')
                }
              }}
            >
              Add folder…
            </button>
            <button
              type="button"
              className="btn"
              disabled={Boolean(status?.running)}
              onClick={async () => {
                setError(null)
                try {
                  const result = await pickLocalImportFiles()
                  addLocalFiles(result.paths)
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'File picker failed')
                }
              }}
            >
              Add files…
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSyncFolders}
              title={
                localFolders.length
                  ? 'Re-scan saved folders and link any new media'
                  : 'Add a folder first'
              }
              onClick={async () => {
                setError(null)
                setSkippedOpen(false)
                try {
                  await startLocalImport(localFolders, localRecursive)
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Failed to sync folders')
                }
              }}
            >
              Sync folders
            </button>
            <label className="scrape-local-recursive">
              <input
                type="checkbox"
                checked={localRecursive}
                disabled={Boolean(status?.running)}
                onChange={(e) => setRecursiveAndPersist(e.target.checked)}
              />{' '}
              Include subfolders
            </label>
          </div>
          {localFolders.length > 0 ? (
            <div className="scrape-local-section">
              <div className="scrape-local-section-label">
                Folders ({localFolders.length}) — kept for Sync
              </div>
              <ul className="scrape-local-path-list">
                {localFolders.map((path) => (
                  <li key={path}>
                    <button
                      type="button"
                      className="btn btn-small scrape-local-remove"
                      disabled={Boolean(status?.running)}
                      onClick={() => removeLocalFolder(path)}
                      title="Remove folder"
                      aria-label={`Remove folder ${path}`}
                    >
                      🗑️
                    </button>
                    <span className="scrape-local-path" title={path}>
                      {path}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="settings-hint">
              Add folders to remember them here. Sync re-scans those folders for new media.
            </p>
          )}
          {localFiles.length > 0 && (
            <div className="scrape-local-section">
              <div className="scrape-local-section-label">Files ({localFiles.length})</div>
              <ul className="scrape-local-path-list">
                {localFiles.map((path) => (
                  <li key={path}>
                    <button
                      type="button"
                      className="btn btn-small scrape-local-remove"
                      disabled={Boolean(status?.running)}
                      onClick={() => removeLocalFile(path)}
                      title="Remove file"
                      aria-label={`Remove file ${path}`}
                    >
                      🗑️
                    </button>
                    <span className="scrape-local-path" title={path}>
                      {path}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <>
      <div className="scrape-tag-mode">
        <span className="scrape-tag-mode-label">Filters</span>
        <div className="scrape-tag-mode-toggle" role="group" aria-label="How multiple Tag rows combine">
          <button
            type="button"
            className={`btn btn-small${tagMode === 'and' ? ' active' : ''}`}
            onClick={() => setTagMode('and')}
          >
            AND
          </button>
          <button
            type="button"
            className={`btn btn-small${tagMode === 'or' ? ' active' : ''}`}
            onClick={() => setTagMode('or')}
          >
            OR
          </button>
        </div>
        <span className="scrape-tag-mode-hint">
          {tagRowCount < 2
            ? 'Add Tag, URL, date, or media-type rows. AND / OR applies when you have multiple Tag rows.'
            : tagMode === 'and'
              ? 'Posts must include every listed tag; URL, date, and media-type filters still apply.'
              : 'Posts matching any listed tag; URL, date, and media-type filters still apply.'}
        </span>
      </div>
      <div className="filter-builder">
        {rows.map((row, index) => (
          <div className="filter-row" key={row.id}>
            {index > 0 && (
              <span className={`filter-and${rows[index - 1].type === 'tag' && row.type === 'tag' ? ' filter-joiner-tags' : ''}`}>
                {joinerLabel(rows[index - 1], row, tagMode)}
              </span>
            )}
            <select
              value={row.type}
              onChange={(e) => {
                const type = e.target.value as ScrapeFilterType
                updateRow(row.id, { type, value: '', dateFrom: '', dateTo: '' })
              }}
            >
              <option value="tag">Tag</option>
              <option
                value="date_range"
                disabled={usedUnique.has('date_range') && row.type !== 'date_range'}
              >
                Date &amp; time
              </option>
              <option value="url">URL</option>
              <option
                value="media_type"
                disabled={usedUnique.has('media_type') && row.type !== 'media_type'}
              >
                Media type
              </option>
            </select>
            {row.type === 'tag' && (
              <input
                value={row.value}
                onChange={(e) => updateRow(row.id, { value: e.target.value })}
                placeholder="Type any site tag or pick below"
              />
            )}
            {row.type === 'url' && (
              <UrlFilterField
                value={row.value}
                onChange={(value) => updateRow(row.id, { value })}
              />
            )}
            {row.type === 'media_type' && (
              <select value={row.value} onChange={(e) => updateRow(row.id, { value: e.target.value })}>
                <option value="">All</option>
                <option value="image">Images</option>
                <option value="gif">GIFs</option>
                <option value="video">Videos</option>
              </select>
            )}
            {row.type === 'date_range' && (
              <>
                <input
                  type="datetime-local"
                  className="scrape-datetime-input"
                  value={row.dateFrom}
                  onChange={(e) => updateRow(row.id, { dateFrom: e.target.value })}
                  title="From (local date and time; leave empty for open start)"
                />
                <span className="filter-and">..</span>
                <input
                  type="datetime-local"
                  className="scrape-datetime-input"
                  value={row.dateTo}
                  onChange={(e) => updateRow(row.id, { dateTo: e.target.value })}
                  title="To (local date and time; leave empty for open end)"
                />
              </>
            )}
            <button type="button" className="btn" onClick={() => removeRow(row.id)}>
              Remove
            </button>
            {row.type === 'tag' && (
              <div className="filter-row-tag-picker">
                <SearchableTagSingleSelect
                  tags={tags ?? []}
                  selectedId={(tags ?? []).find((tag) => tag.name === row.value.trim())?.id ?? ''}
                  onChange={(id) =>
                    updateRow(row.id, {
                      value: id === '' ? '' : ((tags ?? []).find((tag) => tag.id === id)?.name ?? ''),
                    })
                  }
                  searchPlaceholder="Search library tags..."
                />
              </div>
            )}
          </div>
        ))}
        <div className="filter-add-row">
          <button type="button" className="btn btn-add" onClick={() => addRow('tag')}>
            + Tag
          </button>
          <button type="button" className="btn btn-add" onClick={() => addRow('url')}>
            + URL
          </button>
          <button
            type="button"
            className="btn btn-add"
            onClick={() => addRow('date_range')}
            disabled={usedUnique.has('date_range')}
          >
            + Date &amp; time
          </button>
          <button
            type="button"
            className="btn btn-add"
            onClick={() => addRow('media_type')}
            disabled={usedUnique.has('media_type')}
          >
            + Media type
          </button>
        </div>
      </div>

      <div className="filters scrape-filters">
        <label>
          Sort{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value as 'date_desc' | 'date_asc')}>
            <option value="date_desc">Date desc (newest first)</option>
            <option value="date_asc">Date asc (oldest first)</option>
          </select>
        </label>
        <label>
          Limit{' '}
          <input
            type="number"
            min={0}
            value={hasUrlFilters ? 0 : limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            style={{ width: 80 }}
            disabled={hasUrlFilters}
            title={
              hasUrlFilters
                ? 'Download limit does not apply when scraping by URL'
                : 'Stop after this many successful downloads (skips do not count; 0 = no limit)'
            }
          />
          {hasUrlFilters ? (
            <span className="settings-hint"> (not used for URL scrapes)</span>
          ) : null}
        </label>
        <label title="Do not download a new post when it is identical to a file already in the library. Tags and the URL are added to the kept file.">
          <input
            type="checkbox"
            checked={appSettings?.scrape_skip_identical ?? false}
            onChange={(e) => {
              queryClient.setQueryData(['app-settings'], (prev: typeof appSettings) =>
                prev ? { ...prev, scrape_skip_identical: e.target.checked } : prev,
              )
              patchAppSettings({ scrape_skip_identical: e.target.checked }).then((next) => {
                queryClient.setQueryData(['app-settings'], next)
              })
            }}
          />{' '}
          Skip identical
        </label>
      </div>

      <div className="scrape-exclude-tags">
        <span className="scrape-exclude-tags-label">Exclude tags</span>
        <ExcludeTagsPicker value={excludeTags} onChange={setExcludeTags} />
      </div>
        </>
      )}

      <div className="scrape-actions">
        <button type="button" className="btn btn-primary" onClick={start} disabled={!canRun}>
          {isLocalSource ? 'Run import' : 'Run scrape'}
        </button>
        <button type="button" className="btn btn-danger" onClick={stop} disabled={!status?.running}>
          Stop
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {status?.ran_this_session && (
        <div className="scrape-progress">
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="scrape-progress-meta">
            {selectedSource ? `${selectedSource.name} · ` : ''}
            {!isLocalSource && selectedScraper ? `${selectedScraper.name} · ` : ''}
            {msgParts && (
              <>
                {msgParts.before}
                {msgParts.url ? (
                  isLocalSource ? (
                    <span title={msgParts.url}>{msgParts.url}</span>
                  ) : (
                    <a href={msgParts.url} target="_blank" rel="noreferrer">
                      {msgParts.url}
                    </a>
                  )
                ) : null}
                {msgParts.after}
              </>
            )}
            {status.total > 0 &&
              ` · ${effectiveLimit > 0 ? `${status.downloaded}/${effectiveLimit}` : `${status.processed}/${status.total}`}`}
            {` · ${isLocalSource ? 'added' : 'downloaded'} ${status.downloaded}`}
            {` · skipped ${status.skipped}`}
            {status.similar > 0 && ` · similar ${status.similar}`}
          </div>
          {skippedItems.length > 0 && (
            <details
              className="scrape-skipped"
              open={skippedOpen}
              onToggle={(e) => setSkippedOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary>
                Skipped ({skippedItems.length})
              </summary>
              {skippedOpen && (
                <ul className="scrape-skipped-list">
                  {skippedItems.map((item) => (
                    <li key={`${item.url}:${item.reason}`}>
                      {item.url.startsWith('http') ? (
                        <a href={item.url} target="_blank" rel="noreferrer">
                          {item.url}
                        </a>
                      ) : (
                        <span title={item.url}>{item.url}</span>
                      )}
                      <span className="scrape-skipped-reason">{item.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
          {status.errors.length > 0 && (
            <div className="error">
              {status.errors.slice(-5).map((item) => (
                <div key={item}>{item}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
