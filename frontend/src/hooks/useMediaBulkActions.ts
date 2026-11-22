import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  bulkAddMediaTags,
  bulkMediaAction,
  fetchMediaById,
  markRelatedMany,
} from '../api/client'
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
  /** Visible page items; remembered so Download/Share still work for off-page selections. */
  items: readonly MediaItem[]
  clearSelectedIds: () => void
  onSettled?: () => void
  onFinished?: (action: BulkAction, ids: number[]) => void
}) {
  const queryClient = useQueryClient()
  const { confirm } = useConfirm()
  const [transferBusy, setTransferBusy] = useState(false)
  const [transferMessage, setTransferMessage] = useState<string | null>(null)
  const [knownById, setKnownById] = useState(() => new Map<number, MediaItem>())

  useEffect(() => {
    const keep = new Set(selectedIds)
    for (const item of items) keep.add(item.id)
    setKnownById((prev) => {
      const next = new Map<number, MediaItem>()
      let changed = false
      for (const id of keep) {
        const item = items.find((row) => row.id === id) ?? prev.get(id)
        if (!item) continue
        next.set(id, item)
        if (prev.get(id) !== item) changed = true
      }
      if (!changed && next.size === prev.size) {
        for (const id of next.keys()) {
          if (!prev.has(id)) {
            changed = true
            break
          }
        }
        if (!changed) return prev
      }
      return next
    })
  }, [items, selectedIds])

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

  const resolveTransferItems = async () => {
    const byId = new Map(knownById)
    for (const item of items) byId.set(item.id, item)
    const resolved: MediaItem[] = []
    for (const id of selectedIds) {
      let item = byId.get(id)
      if (!item) {
        item = await fetchMediaById(id)
        byId.set(id, item)
      }
      resolved.push(item)
    }
    return resolved
  }

  const transferFilesFrom = (rows: MediaItem[]) =>
    rows.map((item) => ({
      url: item.media_url,
      filename: suggestedMediaFilename(item),
      mediaType: item.media_type,
    }))

  const handleBulkDownload = async () => {
    if (selectedIds.length === 0 || transferBusy) return
    setTransferBusy(true)
    setTransferMessage(null)
    try {
      const rows = await resolveTransferItems()
      const files = transferFilesFrom(rows)
      if (files.length === 0) return
      await downloadMediaFiles(files)
      setTransferMessage(files.length === 1 ? 'Downloaded' : `Downloaded ${files.length} files`)
    } catch (err) {
      setTransferMessage(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setTransferBusy(false)
    }
  }

  const handleBulkShare = async () => {
    if (selectedIds.length === 0 || transferBusy) return
    setTransferBusy(true)
    setTransferMessage(null)
    try {
      const rows = await resolveTransferItems()
      const files = transferFilesFrom(rows)
      if (files.length === 0) return
      const result = await shareMediaFiles(files)
      if (result === 'downloaded_fallback') setTransferMessage(shareDownloadFallbackMessage())
      else if (result === 'shared')
        setTransferMessage(files.length === 1 ? 'Shared' : `Shared ${files.length} files`)
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
