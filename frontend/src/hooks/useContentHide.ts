import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { fetchAppSettings, patchAppSettings } from '../api/client'
import { useConfirm } from '../context/ConfirmContext'
import { DEFAULT_APP_SETTINGS, type ContentHideRule } from '../types/appSettings'
import type { MediaItem } from '../types'
import {
  lockedRulesForMedia,
  mergeRevealedRuleIds,
  pendingRevealRules,
  type ContentHideTagged,
} from '../utils/contentHide'
import { writeCachedAppSettings } from '../utils/appSettingsCache'

export function useContentHide() {
  const queryClient = useQueryClient()
  const { confirm } = useConfirm()
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: fetchAppSettings,
    staleTime: 30_000,
  })
  const prefs = appSettings ?? DEFAULT_APP_SETTINGS
  const rules = prefs.content_hide_rules
  const revealedIds = prefs.content_hide_revealed_rule_ids

  const revealMutation = useMutation({
    mutationFn: (ids: string[]) =>
      patchAppSettings({ content_hide_revealed_rule_ids: ids }),
    onSuccess: (result) => {
      writeCachedAppSettings(result)
      queryClient.setQueryData(['app-settings'], result)
    },
  })

  const lockedFor = useCallback(
    (item: ContentHideTagged) => lockedRulesForMedia(rules, revealedIds, item),
    [rules, revealedIds],
  )

  const isLocked = useCallback(
    (item: ContentHideTagged) => lockedFor(item).length > 0,
    [lockedFor],
  )

  const pending = useMemo(
    () => pendingRevealRules(rules, revealedIds),
    [rules, revealedIds],
  )

  const runRevealFlow = useCallback(
    async (
      applicable: ContentHideRule[],
      options: { mode: 'toolbar' | 'item' } = { mode: 'toolbar' },
    ) => {
      if (applicable.length === 0) return true
      const withMessages = applicable.filter((r) => r.message.trim())

      if (options.mode === 'item') {
        // Tap blur: generic confirm only when no rule messages; otherwise messages only.
        if (withMessages.length === 0) {
          const ok = await confirm({
            title: 'Show hidden content',
            message: 'Show all of the hidden content?',
            confirmLabel: 'Show',
          })
          if (!ok) return false
        } else {
          for (const rule of withMessages) {
            const ok = await confirm({
              title: 'Show hidden content',
              message: rule.message.trim(),
              confirmLabel: 'Continue',
            })
            if (!ok) return false
          }
        }
      } else {
        // Toolbar: always start with the generic confirm, then any messages.
        const okFirst = await confirm({
          title: 'Show hidden content',
          message: 'Show all of the hidden content?',
          confirmLabel: 'Show',
        })
        if (!okFirst) return false
        for (const rule of withMessages) {
          const ok = await confirm({
            title: 'Show hidden content',
            message: rule.message.trim(),
            confirmLabel: 'Continue',
          })
          if (!ok) return false
        }
      }

      const next = mergeRevealedRuleIds(
        revealedIds,
        applicable.map((r) => r.id),
      )
      await revealMutation.mutateAsync(next)
      return true
    },
    [confirm, revealedIds, revealMutation],
  )

  const revealForMedia = useCallback(
    (item: MediaItem | ContentHideTagged) =>
      runRevealFlow(lockedFor(item), { mode: 'item' }),
    [lockedFor, runRevealFlow],
  )

  const revealAllPending = useCallback(
    () => runRevealFlow(pending, { mode: 'toolbar' }),
    [pending, runRevealFlow],
  )

  return {
    rules,
    revealedIds,
    pending,
    hasPendingReveals: pending.length > 0,
    isLocked,
    lockedFor,
    revealForMedia,
    revealAllPending,
    revealing: revealMutation.isPending,
  }
}
