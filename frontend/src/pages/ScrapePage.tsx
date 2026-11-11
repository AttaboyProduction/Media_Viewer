import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchScrapeSession, fetchScrapeStatus } from '../api/client'
import DuplicatesPanel from '../components/DuplicatesPanel'
import RecentScrapedMediaPanel from '../components/RecentScrapedMediaPanel'
import { ScrapeBrowserNotice } from '../components/ScrapeBrowsers'
import ScrapePanel from '../components/ScrapePanel'

export default function ScrapePage() {
  const queryClient = useQueryClient()

  const handleScrapeFinished = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['duplicates'] })
    queryClient.invalidateQueries({ queryKey: ['media'] })
    queryClient.invalidateQueries({ queryKey: ['tags'] })
    queryClient.invalidateQueries({ queryKey: ['scrape-recent-media'] })
    queryClient.invalidateQueries({ queryKey: ['scrape-status'] })
  }, [queryClient])

  const { data: scrapeStatus } = useQuery({
    queryKey: ['scrape-status'],
    queryFn: fetchScrapeStatus,
    refetchInterval: 2000,
  })
  const { data: session } = useQuery({
    queryKey: ['scrape-session'],
    queryFn: fetchScrapeSession,
    staleTime: 30_000,
  })
  const showBrowserNotice = session?.selected_source?.kind !== 'local'

  return (
    <div className="page">
      {showBrowserNotice && <ScrapeBrowserNotice />}
      <ScrapePanel onFinished={handleScrapeFinished} />

      {scrapeStatus?.hash_backfill_running && (
        <div className="banner">
          Indexing existing files… {scrapeStatus.hash_backfill_done}/{scrapeStatus.hash_backfill_total}
        </div>
      )}

      <RecentScrapedMediaPanel />
      <DuplicatesPanel />
    </div>
  )
}
