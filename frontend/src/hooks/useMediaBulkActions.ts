import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { bulkAddMediaTags, bulkMediaAction, markRelatedMany } from '../api/client'
import { useConfirm } from '../context/ConfirmContext'
import type { MediaItem } from '../types'
import {
  downloadMediaFiles,
  shareDownloadFallbackMessage,
  shareMediaFiles,
  suggestedMediaFilename,
} from '../utils/mediaViewerActions'

type BulkAction = 'discard' | 'delete' | 'mark' | 'add_tags'

/** Discard, permanent delete, Mark as, Add tags, download, and share for a media grid selection. */
export function useMediaBulkActions({
  selectedIds,
  items,
  clearSelectedIds,
  onSettled,
  onFinished,
}: {
  selectedIds: number[]
  /** Current page items; selection is cleared when the page changes. */
  items: readonly MediaItem[]
  clearSelectedIds: () => void
  onSettled?: () => void
  onFinished?: (action: BulkAction, ids: number[]) => void
}) {
  const queryClient = useQueryClient()
  const { confirm } = useConfirm()
  const [transferBusy, setTransferBusy] = useState(false)
  const [transferMessage, setTransferMessage] = useState<string | null>(null)

  const selectedItems = useMemo(
    () =>
      selectedIds
        .map((id) => items.find((item) => item.id === id))
        .filter((item): item is MediaItem => Boolean(item)),
    [items, selectedIds],
  )

  useEffect(() => {
    if (!transferMessage) return
    const timer = window.setTimeout(() => setTransferMessage(null), 4000)
    return () => window.clearTimeout(timer)
  }, [transferMessage])

  const settle = () => {
    queryClient.invalidateQueries({ queryKey: ['media'] })
    queryClient.invalidateQueries({ queryKey: ['duplicates'] })
    queryClient.invalidateQueries({ queryKey: ['duplicate-group'] })
    queryClient.invalidateQueries({ queryKey: ['tags'] })
    onSettled?.()
  }

  const bulkMutation = useMutation({
    mutationFn: ({ ids, action }: { ids: number[]; action: 'discard' | 'delete' }) =>
      bulkMediaAction(ids, action),
    onSuccess: (_result, { ids, action }) => {
      clearSelectedIds()
      onFinished?.(action, ids)
    },
    onSettled: settle,
  })

  const markMutation = useMutation({
    mutationFn: ({ ids, kind }: { ids: number[]; kind: 'identical' | 'similar' }) =>
      markRelatedMany(ids, kind),
    onSuccess: (_result, { ids }) => {
      clearSelectedIds()
      onFinished?.('mark', ids)
    },
    onSettled: settle,
  })

  const addTagsMutation = useMutation({
    mutationFn: ({ ids, add }: { ids: number[]; add: string[] }) => bulkAddMediaTags(ids, add),
    onSuccess: (_result, { ids }) => {
      onFinished?.('add_tags', ids)
    },
    onSettled: settle,
  })

  const bulkBusy =
    bulkMutation.isPending ||
    markMutation.isPending ||
    addTagsMutation.isPending ||
    transferBusy

  const transferFiles = () =>
    selectedItems.map((item) => ({
      url: item.media_url,
      filename: suggestedMediaFilename(item),
      mediaType: item.media_type,
    }))

  const handleBulkDownload = async () => {
    const files = transferFiles()
    if (files.length === 0 || transferBusy) return
    setTransferBusy(true)
    setTransferMessage(null)
    try {
      await downloadMediaFiles(files)
      setTransferMessage(files.length === 1 ? 'Downloaded' : `Downloaded ${files.length} files`)
    } catch (err) {
      setTransferMessage(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setTransferBusy(false)
    }
  }

  const handleBulkShare = async () => {
    const files = transferFiles()
    if (files.length === 0 || transferBusy) return
    setTransferBusy(true)
    setTransferMessage(null)
    try {
      const result = await shareMediaFiles(files)
      if (result === 'downloaded_fallback') setTransferMessage(shareDownloadFallbackMessage())
      else if (result === 'shared') setTransferMessage(files.length === 1 ? 'Shared' : `Shared ${files.length} files`)
    } catch (err) {
      setTransferMessage(err instanceof Error ? err.message : 'Share failed')
    } finally {
      setTransferBusy(false)
    }
  }

  const handleBulkDiscard = async () => {
    if (selectedIds.length === 0) return
    const ok = await confirm({
      title: 'Discard selected?',
      message: `Discard ${selectedIds.length} item(s) from viewing?`,
      confirmLabel: 'Discard',
    })
    if (ok) bulkMutation.mutate({ ids: [...selectedIds], action: 'discard' })
  }

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return
    const ok = await confirm({
      title: 'Delete selected?',
      message: `Permanently delete ${selectedIds.length} item(s) and all metadata? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) bulkMutation.mutate({ ids: [...selectedIds], action: 'delete' })
  }

  const handleBulkMark = async (kind: 'identical' | 'similar') => {
    if (selectedIds.length < 2) return
    const ok = await confirm({
      title: kind === 'identical' ? 'Mark as identical?' : 'Mark as similar?',
      message: `Link ${selectedIds.length} files as ${kind}. The earliest file stays the primary.`,
      confirmLabel: 'Mark',
    })
    if (ok) markMutation.mutate({ ids: [...selectedIds], kind })
  }

  const handleBulkAddTags = async (tagNames: string[]) => {
    if (selectedIds.length === 0 || tagNames.length === 0) return
    await addTagsMutation.mutateAsync({ ids: [...selectedIds], add: tagNames })
  }

  const markError =
    markMutation.isError && markMutation.error instanceof Error
      ? markMutation.error.message
      : markMutation.isError
        ? 'Mark failed'
        : null

  return {
    bulkBusy,
    deletePending: bulkMutation.isPending,
    markError,
    handleBulkDiscard,
    handleBulkDelete,
    handleBulkMark,
    handleBulkAddTags,
    handleBulkDownload,
    handleBulkShare,
    transferMessage,
  }
}
