import { useCallback, useEffect, useRef, useState } from 'react'
import { readDevicePref, writeDevicePref } from '../utils/devicePrefs'

export type PageSizeSettingKey =
  | 'viewer_page_size'
  | 'scrape_downloads_page_size'
  | 'tags_page_size'

interface Options {
  /** Shared app settings (used once to seed this browser if nothing is stored yet). */
  settings: { [K in PageSizeSettingKey]?: number } | undefined
  settingKey: PageSizeSettingKey
  fallback: number
  onResetPage: () => void
  /** When the option list shrinks, re-sync if the local value is gone. */
  allowedSizes?: readonly number[]
}

export function usePersistedPageSize({
  settings,
  settingKey,
  fallback,
  onResetPage,
  allowedSizes,
}: Options) {
  const applied = useRef(false)
  const [pageSize, setPageSize] = useState<number | null>(null)

  useEffect(() => {
    if (!settings || applied.current) return
    applied.current = true
    const seed = settings[settingKey]
    const stored = readDevicePref(
      settingKey,
      fallback,
      typeof seed === 'number' ? seed : null,
    )
    setPageSize(typeof stored === 'number' ? stored : fallback)
  }, [fallback, settingKey, settings])

  useEffect(() => {
    if (
      pageSize === null ||
      !allowedSizes ||
      allowedSizes.length === 0 ||
      allowedSizes.includes(pageSize)
    ) {
      return
    }
    const next = allowedSizes.includes(fallback) ? fallback : allowedSizes[0]
    setPageSize(next)
    writeDevicePref(settingKey, next)
  }, [allowedSizes, fallback, pageSize, settingKey])

  const onResetPageRef = useRef(onResetPage)
  onResetPageRef.current = onResetPage

  const changePageSize = useCallback(
    (size: number) => {
      if (pageSize === null || size === pageSize) return
      setPageSize(size)
      writeDevicePref(settingKey, size)
      onResetPageRef.current()
    },
    [pageSize, settingKey],
  )

  return {
    pageSize,
    ready: pageSize !== null,
    pending: false,
    changePageSize,
  }
}
