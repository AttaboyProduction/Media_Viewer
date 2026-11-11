import { useMutation, useQueryClient } from '@tanstack/react-query'
import { bulkAddMediaTags, bulkMediaAction, markRelatedMany } from '../api/client'
import { useConfirm } from '../context/ConfirmContext'

type BulkAction = 'discard' | 'delete' | 'mark' | 'add_tags'

/** Discard, permanent delete, Mark as, and Add tags for a media grid selection. */
export function useMediaBulkActions({
  selectedIds,
  clearSelectedIds,
  onSettled,
  onFinished,
}: {
  selectedIds: number[]
  clearSelectedIds: () => void
  onSettled?: () => void
  onFinished?: (action: BulkAction, ids: number[]) => void
}) {
  const queryClient = useQueryClient()
  const { confirm } = useConfirm()

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
    bulkMutation.isPending || markMutation.isPending || addTagsMutation.isPending

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
  }
}
