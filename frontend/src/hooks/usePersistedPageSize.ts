import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { patchAppSettings } from '../api/client'
import type { AppSettings } from '../types/appSettings'

export type PageSizeSettingKey =
  | 'viewer_page_size'
  | 'scrape_downloads_page_size'
  | 'tags_page_size'

interface Options {
  settings: AppSettings | undefined
  settingKey: PageSizeSettingKey
  fallback: number
  onResetPage: () => void
  /** When the option list shrinks, re-sync from settings if local value is gone. */
  allowedSizes?: readonly number[]
}

export function usePersistedPageSize({
  settings,
  settingKey,
  fallback,
  onResetPage,
  allowedSizes,
}: Options) {
  const queryClient = useQueryClient()
  const applied = useRef(false)
  const [pageSize, setPageSize] = useState<number | null>(null)

  useEffect(() => {
    if (!settings) return
    const fromSettings = settings[settingKey] ?? fallback
    if (!applied.current) {
      applied.current = true
      setPageSize(fromSettings)
      return
    }
    if (
      pageSize !== null &&
      allowedSizes &&
      allowedSizes.length > 0 &&
      !allowedSizes.includes(pageSize) &&
      fromSettings !== pageSize
    ) {
      setPageSize(fromSettings)
    }
  }, [allowedSizes, fallback, pageSize, settingKey, settings])

  const { mutate, isPending } = useMutation({
    mutationFn: (size: number) => patchAppSettings({ [settingKey]: size }),
    onSuccess: (next) => queryClient.setQueryData(['app-settings'], next),
  })

  const onResetPageRef = useRef(onResetPage)
  onResetPageRef.current = onResetPage

  const changePageSize = useCallback(
    (size: number) => {
      if (pageSize === null || size === pageSize) return
      setPageSize(size)
      onResetPageRef.current()
      mutate(size)
    },
    [mutate, pageSize],
  )

  return {
    pageSize,
    ready: pageSize !== null,
    pending: isPending,
    changePageSize,
  }
}
