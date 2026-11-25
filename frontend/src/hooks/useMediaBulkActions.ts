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
  commitShareMediaFiles,
  downloadMediaFiles,
  formatFileSize,
  prepareShareMediaFiles,
  shareMediaFileOrDownload,
  sharePreparedBatch,
  suggestedMediaFilename,
  WEB_SHARE_MAX_BYTES,
  webShareNeedsNotice,
  webShareStepOptions,
} from '../utils/mediaViewerActions'

type BulkAction = 'discard' | 'delete' | 'mark' | 'add_tags'

/** Discard, permanent delete, Mark as, Add tags, download, and share for a media grid selection. */
export function useMediaBulkActions({
  selectedIds,
  items,
  clearSelectedIds,
  setSelectedIds,
  onSettled,
  onFinished,
}: {
  selectedIds: number[]
  /** Visible page items; remembered so Download/Share still work for off-page selections. */
  items: readonly MediaItem[]
  clearSelectedIds: () => void
  /** Drop ids that already shared so the next Share click sends the remainder. */
  setSelectedIds?: (updater: (prev: number[]) => number[]) => void
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

      if (files.length === 1) {
        const only = files[0]
        const row = rows[0]
        if (row && row.file_size != null && row.file_size > WEB_SHARE_MAX_BYTES) {
          const sizeLabel = formatFileSize(row.file_size) || 'over 50 MB'
          const ok = await confirm({
            title: 'File too large to share',
            message: `Windows cannot share a file larger than about 50 MB through the share sheet (this file is ${sizeLabel}). Download it instead?`,
            confirmLabel: 'Download',
            cancelLabel: 'Cancel',
          })
          if (!ok) return
          await downloadMediaFiles(files)
          if (setSelectedIds) setSelectedIds(() => [])
          return
        }
        const result = await shareMediaFileOrDownload(only.url, only.filename, only.mediaType)
        if (result === 'cancelled') return
        if (result === 'shared' || result === 'downloaded_fallback') {
          if (setSelectedIds) setSelectedIds(() => [])
          return
        }
        return
      }

      const prepared = await prepareShareMediaFiles(files)
      const oversizedLabels = prepared.tooLarge.map((index) => {
        const name = files[index]?.filename || `File ${index + 1}`
        const size = formatFileSize(prepared.built[index]?.size) || 'over 50 MB'
        return `${name} (${size})`
      })

      // Multi-step / oversized: keep a Share next dialog until every shareable batch is done.
      // Each dialog confirm click is a fresh user gesture for navigator.share.
      if (webShareNeedsNotice(prepared.plan)) {
        let sharedCount = 0
        const dropIds = new Set<number>()
        const totalSteps = Math.max(1, prepared.batches.length)

        if (prepared.batches.length === 0 && prepared.tooLarge.length > 0) {
          const ok = await confirm(
            webShareStepOptions({
              step: 1,
              totalSteps: 1,
              nextCount: 0,
              remainingShareCount: 0,
              sharedSoFar: 0,
              tooLargeCount: prepared.tooLarge.length,
              oversizedLabels,
            }),
          )
          if (!ok) return
        }

        for (let batchIndex = 0; batchIndex < prepared.batches.length; batchIndex += 1) {
          const nextCount = prepared.batches[batchIndex]?.length ?? 0
          const remainingAfter = prepared.batches.slice(batchIndex + 1).flat().length
          const ok = await confirm(
            webShareStepOptions({
              step: batchIndex + 1,
              totalSteps,
              nextCount,
              remainingShareCount: remainingAfter,
              sharedSoFar: sharedCount,
              tooLargeCount: prepared.tooLarge.length,
              oversizedLabels: batchIndex === 0 ? oversizedLabels : [],
            }),
          )
          if (!ok) break

          const result = await sharePreparedBatch(prepared, batchIndex)
          if (result.status === 'cancelled' || result.status === 'failed') {
            if (result.status === 'failed') {
              setTransferMessage('Share failed — open Share again for the remaining files')
            }
            break
          }
          sharedCount += result.sharedIndexes.length
          for (const index of result.sharedIndexes) {
            const id = selectedIds[index]
            if (typeof id === 'number') dropIds.add(id)
          }
          if (setSelectedIds && dropIds.size) {
            setSelectedIds((prev) => prev.filter((id) => !dropIds.has(id)))
          }
        }

        if (prepared.tooLarge.length) {
          await downloadMediaFiles(prepared.tooLarge.map((i) => prepared.downloadMeta[i]))
          for (const index of prepared.tooLarge) {
            const id = selectedIds[index]
            if (typeof id === 'number') dropIds.add(id)
          }
          if (setSelectedIds && dropIds.size) {
            setSelectedIds((prev) => prev.filter((id) => !dropIds.has(id)))
          }
        }
        return
      }

      const outcome = await commitShareMediaFiles(prepared)
      if (setSelectedIds) {
        const dropIndexes = [...outcome.sharedIndexes, ...outcome.downloadedIndexes]
        const dropIds = new Set(
          dropIndexes
            .map((index) => selectedIds[index])
            .filter((id): id is number => typeof id === 'number'),
        )
        if (dropIds.size) {
          setSelectedIds((prev) => prev.filter((id) => !dropIds.has(id)))
        }
      }
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
