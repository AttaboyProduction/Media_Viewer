import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { keepDuplicates, mergeDuplicates, resolveDuplicate } from '../api/client'
import type { DuplicateGroup, MediaItem } from '../types'
import ContentHideMedia from './ContentHideMedia'
import MediaCardThumb from './MediaCardThumb'

function formatSize(bytes: number | null) {
  if (bytes == null || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function Preview({ item, selected }: { item: MediaItem; selected: boolean }) {
  return (
    <div className={`duplicate-preview${selected ? ' selected' : ''}`}>
      <ContentHideMedia item={item}>
        <MediaCardThumb item={item} size="large" alt={item.source_post_id} />
      </ContentHideMedia>
      <div className="media-card-meta">
        #{item.source_post_id} · {item.media_type}
        {formatSize(item.file_size) ? ` · ${formatSize(item.file_size)}` : ''}
        {item.rating.my_rating != null ? ` · ${item.rating.my_rating}★` : ''}
        {item.is_discarded ? ' · discarded' : ''}
      </div>
    </div>
  )
}

/** Prefer larger file_size; tie → lower id. */
export function largestDuplicateId(items: MediaItem[]) {
  return [...items].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0) || a.id - b.id)[0].id
}

export default function DuplicateGroupCard({
  group,
  kind,
  wizard = false,
}: {
  group: DuplicateGroup
  kind: 'identical' | 'similar'
  /** One-group resolve overlay: Auto-resolve larger + start keep-selected for similar. */
  wizard?: boolean
}) {
  const queryClient = useQueryClient()
  const [keepId, setKeepId] = useState(() => largestDuplicateId(group.items))
  const rated = useMemo(
    () => group.items.filter((item) => item.rating.my_rating != null),
    [group.items],
  )
  const [ratingFrom, setRatingFrom] = useState<number | ''>(
    rated.length > 1 ? rated[0].id : '',
  )
  const [pickingKeep, setPickingKeep] = useState(() => wizard && kind === 'similar')
  const [checkedKeep, setCheckedKeep] = useState<number[]>(() => group.items.map((item) => item.id))

  useEffect(() => {
    if (wizard && kind === 'similar') setPickingKeep(true)
  }, [wizard, kind, group.primary_id])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['duplicates'] })
    queryClient.invalidateQueries({ queryKey: ['duplicate-group'] })
    queryClient.invalidateQueries({ queryKey: ['media'] })
    queryClient.invalidateQueries({ queryKey: ['scrape-recent-media'] })
    queryClient.invalidateQueries({ queryKey: ['scrape-status'] })
  }

  const resolve = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'keep_both' | 'discard' }) =>
      resolveDuplicate(id, action),
    onSuccess: invalidate,
  })
  const merge = useMutation({
    mutationFn: (payload: {
      keep_id: number
      merge_ids: number[]
      rating_from_id: number | null
    }) => mergeDuplicates(payload),
    onSuccess: invalidate,
  })
  const keep = useMutation({
    mutationFn: (ids: number[]) =>
      keepDuplicates(
        ids,
        group.items.map((item) => item.id),
      ),
    onSuccess: invalidate,
  })

  const busy = resolve.isPending || merge.isPending || keep.isPending
  const canMerge = kind === 'identical' && group.items.length >= 2

  const mergeInto = (targetId: number) => {
    merge.mutate({
      keep_id: targetId,
      merge_ids: group.items.filter((item) => item.id !== targetId).map((item) => item.id),
      rating_from_id: ratingFrom === '' ? null : ratingFrom,
    })
  }

  const autoResolveLarger = () => mergeInto(largestDuplicateId(group.items))

  return (
    <div className="duplicate-group">
      <div className="duplicate-group-grid">
        {group.items.map((item) => {
          return (
            <div key={item.id} className="duplicate-col">
              {canMerge && (
                <label className="duplicate-keep">
                  <input
                    type="radio"
                    name={`keep-${group.primary_id}-${kind}`}
                    checked={keepId === item.id}
                    onChange={() => setKeepId(item.id)}
                  />
                  Keep this
                </label>
              )}
              {pickingKeep && (
                <label className="duplicate-keep">
                  <input
                    type="checkbox"
                    checked={checkedKeep.includes(item.id)}
                    onChange={() =>
                      setCheckedKeep((prev) =>
                        prev.includes(item.id)
                          ? prev.filter((id) => id !== item.id)
                          : [...prev, item.id],
                      )
                    }
                  />
                  Keep
                </label>
              )}
              {!canMerge && !pickingKeep && (
                <h3>{item.id === group.primary_id ? 'Existing' : 'Match'}</h3>
              )}
              <Preview item={item} selected={canMerge && keepId === item.id} />
              <div className="duplicate-item-actions">
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  disabled={busy}
                  onClick={() => resolve.mutate({ id: item.id, action: 'discard' })}
                >
                  Discard
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <div className="actions">
        {canMerge && rated.length > 1 && (
            <label className="duplicate-rating-pick">
              Rating to keep
              <select
                value={ratingFrom}
                onChange={(e) => setRatingFrom(e.target.value ? Number(e.target.value) : '')}
              >
                {rated.map((item) => (
                  <option key={item.id} value={item.id}>
                    #{item.source_post_id} ({item.rating.my_rating})
                  </option>
                ))}
              </select>
            </label>
        )}
        {canMerge && wizard && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || group.items.length < 2}
            onClick={autoResolveLarger}
          >
            {merge.isPending ? 'Merging…' : 'Auto-resolve (keep larger)'}
          </button>
        )}
        {canMerge && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || group.items.every((item) => item.id === keepId)}
            onClick={() => mergeInto(keepId)}
          >
            {merge.isPending && !wizard ? 'Merging…' : 'Merge into selected'}
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => keep.mutate(group.items.map((item) => item.id))}
          title="Keep every file in this group and clear the identical/similar link"
        >
          Keep all
        </button>
        {pickingKeep ? (
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || checkedKeep.length === 0}
              onClick={() => keep.mutate(checkedKeep)}
              title="Keep checked files; discard the rest of this group"
            >
              Keep selected, discard the rest
            </button>
            {!wizard && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setPickingKeep(false)}
              >
                Cancel
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setPickingKeep(true)}
            title="Choose which files to keep; unchecked files in this group are discarded"
          >
            Keep selected, discard the rest
          </button>
        )}
      </div>
      {merge.isError && (
        <p className="error">{merge.error instanceof Error ? merge.error.message : 'Merge failed'}</p>
      )}
      {keep.isError && (
        <p className="error">{keep.error instanceof Error ? keep.error.message : 'Keep failed'}</p>
      )}
      {resolve.isError && (
        <p className="error">
          {resolve.error instanceof Error ? resolve.error.message : 'Action failed'}
        </p>
      )}
    </div>
  )
}
