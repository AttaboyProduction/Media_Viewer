import { useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchAppSettings, fetchScrapeStatus, restartApp, shutdownApp } from './api/client'
import { SaveFeedbackProvider, useSaveFeedback } from './context/SaveFeedbackContext'
import { ConfirmProvider, useConfirm } from './context/ConfirmContext'
import ViewerPage from './pages/ViewerPage'
import TagsPage from './pages/TagsPage'
import TagAddPage from './pages/TagAddPage'
import TagGroupsPage from './pages/TagGroupsPage'
import TagSettingsPage from './pages/TagSettingsPage'
import ScrapePage from './pages/ScrapePage'
import AppSettingsPage from './pages/AppSettingsPage'
import AppSettingsSync from './components/AppSettingsSync'
import { DEFAULT_APP_SETTINGS } from './types/appSettings'

function TopNav({ hideScrapePage }: { hideScrapePage: boolean }) {
  const location = useLocation()
  const { savedVisible } = useSaveFeedback()
  const [reloading, setReloading] = useState(false)

  const handleReload = async () => {
    setReloading(true)
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const readHealth = async (): Promise<{ ok: boolean; bootId?: string }> => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        if (!res.ok) return { ok: false }
        const data = (await res.json()) as { boot_id?: string }
        return { ok: true, bootId: typeof data.boot_id === 'string' ? data.boot_id : undefined }
      } catch {
        return { ok: false }
      }
    }
    try {
      // Same path as Run.bat restart; wait until a *new* server is up, not the dying one.
      const before = await readHealth()
      const oldBootId = before.bootId
      await restartApp()
      let sawDown = !before.ok
      for (let i = 0; i < 180; i++) {
        await sleep(500)
        const health = await readHealth()
        if (!health.ok) {
          sawDown = true
          continue
        }
        const isNewBoot =
          Boolean(health.bootId) && (oldBootId == null || health.bootId !== oldBootId)
        if (isNewBoot || (sawDown && oldBootId == null)) {
          await sleep(400)
          window.location.reload()
          return
        }
      }
      window.location.reload()
    } catch {
      setReloading(false)
    }
  }

  const { confirm } = useConfirm()

  const handleExit = async () => {
    const ok = await confirm({
      title: 'Exit',
      message: 'Stop the server and close this window?',
      confirmLabel: 'Exit',
      danger: true,
    })
    if (!ok) return
    try {
      await shutdownApp()
    } catch {
      /* server may already be stopping */
    }
    window.close()
  }

  return (
    <>
      <nav className="top-nav" aria-busy={reloading}>
        <Link to="/" className="top-nav-brand">
          Media Viewer
        </Link>
        {savedVisible && <span className="saved-badge">Saved</span>}
        <Link className={location.pathname === '/' ? 'active' : ''} to="/">
          Viewer
        </Link>
        <Link className={location.pathname.startsWith('/tags') ? 'active' : ''} to="/tags">
          Tags
        </Link>
        {!hideScrapePage && (
          <Link className={location.pathname === '/scrape' ? 'active' : ''} to="/scrape">
            Scrape
          </Link>
        )}
        <Link className={location.pathname === '/settings' ? 'active' : ''} to="/settings">
          Settings
        </Link>
        <div className="nav-actions">
          <button type="button" className="btn btn-small" disabled={reloading} onClick={handleReload}>
            {reloading ? 'Reloading…' : 'Reload'}
          </button>
          <button
            type="button"
            className="btn btn-small btn-danger"
            disabled={reloading}
            onClick={handleExit}
          >
            Exit
          </button>
        </div>
      </nav>
      {reloading && (
        <div
          className="reload-lock-overlay"
          role="alertdialog"
          aria-modal="true"
          aria-live="assertive"
          aria-label="Reloading application"
        >
          <div className="reload-lock-message">Reloading…</div>
        </div>
      )}
    </>
  )
}

function AppRoutes({ hideScrapePage }: { hideScrapePage: boolean }) {
  return (
    <Routes>
      <Route path="/" element={<ViewerPage />} />
      <Route path="/tags" element={<TagsPage />} />
      <Route path="/tags/add" element={<TagAddPage />} />
      <Route path="/tags/groups" element={<TagGroupsPage />} />
      <Route path="/tags/groups/settings" element={<TagSettingsPage />} />
      <Route path="/tags/settings" element={<TagSettingsPage />} />
      {hideScrapePage ? (
        <>
          <Route path="/scrape" element={<Navigate to="/" replace />} />
          <Route path="/duplicates" element={<Navigate to="/" replace />} />
        </>
      ) : (
        <>
          <Route path="/scrape" element={<ScrapePage />} />
          <Route path="/duplicates" element={<Navigate to="/scrape" replace />} />
        </>
      )}
      <Route path="/settings" element={<AppSettingsPage />} />
    </Routes>
  )
}

export default function App() {
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 30_000,
  })
  const hideScrapePage = (appSettings ?? DEFAULT_APP_SETTINGS).hide_scrape_page

  // Prefetch so Scrape status is ready when opening the page (no late flash).
  useQuery({
    queryKey: ['scrape-status'],
    queryFn: fetchScrapeStatus,
    staleTime: 5_000,
    enabled: !hideScrapePage,
  })

  return (
    <SaveFeedbackProvider>
      <ConfirmProvider>
        <div className="app-shell">
          <AppSettingsSync />
          <TopNav hideScrapePage={hideScrapePage} />
          <AppRoutes hideScrapePage={hideScrapePage} />
        </div>
      </ConfirmProvider>
    </SaveFeedbackProvider>
  )
}
