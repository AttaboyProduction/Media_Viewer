import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { fetchBrowsers, installBrowser, type AppSettings, type BrowsersStatus } from '../api/client'

type EngineId = 'obscura' | 'playwright'

const SCRAPE_BROWSER_ITEMS: {
  id: AppSettings['scrape_browser']
  label: string
  description: string
}[] = [
  { id: 'auto', label: 'Auto', description: 'Obscura if installed, otherwise Playwright Chromium' },
  { id: 'obscura', label: 'Obscura', description: 'Stealth headless browser' },
  { id: 'playwright', label: 'Playwright Chromium', description: 'Bundled Chromium' },
]

/** Browser status + install. Mount only while the Scrape page is enabled: probing Chromium is slow. */
function useScrapeBrowsers() {
  const queryClient = useQueryClient()
  const browsers = useQuery({
    queryKey: ['app-browsers'],
    queryFn: fetchBrowsers,
  })
  const install = useMutation({
    mutationFn: installBrowser,
    onSuccess: (result) => {
      queryClient.setQueryData(['app-browsers'], result)
    },
  })
  return { browsers, install }
}

function engineName(id: EngineId) {
  return id === 'obscura' ? 'Obscura' : 'Playwright Chromium'
}

function selectedEngineInstalled(data: BrowsersStatus) {
  return Boolean(data.engines.find((e) => e.id === data.resolved)?.installed)
}

function DownloadButton({
  id,
  install,
}: {
  id: EngineId
  install: ReturnType<typeof useScrapeBrowsers>['install']
}) {
  const installing = install.isPending && install.variables === id
  return (
    <button
      type="button"
      className="btn btn-small"
      disabled={install.isPending}
      onClick={() => install.mutate(id)}
    >
      {installing ? 'Downloading…' : `Download ${engineName(id)}`}
    </button>
  )
}

export function ScrapeBrowserList({
  value,
  onChange,
}: {
  value: AppSettings['scrape_browser']
  onChange: (next: AppSettings['scrape_browser']) => void
}) {
  const { browsers, install } = useScrapeBrowsers()
  const check = browsers.data?.last_update_check

  return (
    <>
      <ul className="browser-list">
        {SCRAPE_BROWSER_ITEMS.map((item) => {
          const selected = value === item.id
          const engine = browsers.data?.engines.find((e) => e.id === item.id)
          const inUse = browsers.data?.resolved === item.id && value !== 'auto'
          let status = item.description
          if (item.id === 'auto' && browsers.data) {
            status = `Uses ${engineName(browsers.data.resolved)}`
          } else if (engine) {
            const version = engine.version ? ` ${engine.version}` : ''
            status = engine.installed
              ? `Installed${version}${inUse ? ' · in use' : ''}`
              : 'Not installed'
          }
          return (
            <li key={item.id} className={`browser-list-item${selected ? ' selected' : ''}`}>
              <button
                type="button"
                className="browser-list-select"
                aria-pressed={selected}
                onClick={() => {
                  if (!selected) onChange(item.id)
                }}
              >
                <span className="browser-list-name">{item.label}</span>
                <span className="browser-list-status">{status}</span>
              </button>
              {engine && !engine.installed && item.id !== 'auto' && (
                <DownloadButton id={item.id as EngineId} install={install} />
              )}
            </li>
          )
        })}
      </ul>
      {browsers.data?.fallback_error && (
        <p className="settings-hint">
          Obscura could not start last time, so Playwright Chromium was used:{' '}
          {browsers.data.fallback_error}
        </p>
      )}
      {(browsers.data?.connection_metered || check) && (
        <p className="settings-hint">
          {browsers.data?.connection_metered && 'This connection is metered. '}
          {check && (
            <>
            Last check {new Date(check.checked_at * 1000).toLocaleString()}
            {check.results.length > 0 ? `: ${check.results.join('; ')}` : ''}.
            </>
          )}
        </p>
      )}
      {install.isError && <p className="banner error">{(install.error as Error).message}</p>}
    </>
  )
}

/** Scrape page notice for missing browsers. Silent when the selected browser is ready. */
export function ScrapeBrowserNotice() {
  const { browsers, install } = useScrapeBrowsers()
  const data = browsers.data
  if (!data) return null

  const ready = selectedEngineInstalled(data)
  const obscuraMissing = !data.engines.find((e) => e.id === 'obscura')?.installed
  // Soft hint only when Auto fell back to Playwright because Obscura is absent.
  // Do not treat a missing Playwright install as “Obscura is not installed” while Auto
  // is already resolving to an installed Obscura.
  const offerObscura =
    ready && data.selected === 'auto' && data.resolved === 'playwright' && obscuraMissing

  if (ready && !offerObscura) return null

  const downloadIds: EngineId[] = offerObscura
    ? ['obscura']
    : data.engines.filter((e) => !e.installed).map((e) => e.id as EngineId)

  return (
    <div className={`banner${ready ? '' : ' error'} browser-notice`}>
      <span>
        {offerObscura
          ? 'Obscura is not installed, so scrapes use Playwright Chromium.'
          : `${engineName(data.resolved)} is not installed. Download a browser before running a scrape.`}
      </span>
      {downloadIds.map((id) => (
        <DownloadButton key={id} id={id} install={install} />
      ))}
      {install.isError && <span>{(install.error as Error).message}</span>}
    </div>
  )
}
