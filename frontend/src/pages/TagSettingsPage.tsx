import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router-dom'
import {
  aliasTagsBatch,
  fetchTagGroups,
  fetchTags,
  mergeTagGroups,
  mergeTags,
  reindexTagGroupOrder,
  reindexTagOrder,
} from '../api/client'
import FormField from '../components/FormField'
import {
  SearchableGroupMultiSelect,
  SearchableGroupSingleSelect,
} from '../components/GroupChipSelect'
import { SearchableTagMultiSelect, SearchableTagSingleSelect } from '../components/TagChipSelect'
import { useConfirm } from '../context/ConfirmContext'
import { useSaveFeedback } from '../context/SaveFeedbackContext'

type SettingsKind = 'tags' | 'groups'

function settingsKindFromPath(pathname: string): SettingsKind {
  return pathname.includes('/groups/') ? 'groups' : 'tags'
}

export default function TagSettingsPage() {
  const location = useLocation()
  const kind = settingsKindFromPath(location.pathname)
  const isGroups = kind === 'groups'

  const queryClient = useQueryClient()
  const { notifySaved } = useSaveFeedback()
  const { confirm } = useConfirm()

  const [mergeSelected, setMergeSelected] = useState<number[]>([])
  const [mergeTargetId, setMergeTargetId] = useState<number | ''>('')
  const [aliasSelectedIds, setAliasSelectedIds] = useState<number[]>([])
  const [aliasCanonicalId, setAliasCanonicalId] = useState<number | ''>('')

  useEffect(() => {
    setMergeSelected([])
    setMergeTargetId('')
    setAliasSelectedIds([])
    setAliasCanonicalId('')
  }, [kind])

  const { data: tags = [] } = useQuery({
    queryKey: ['tags'],
    queryFn: fetchTags,
    enabled: !isGroups,
  })
  const { data: groups = [] } = useQuery({
    queryKey: ['tag-groups'],
    queryFn: fetchTagGroups,
    enabled: isGroups,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['tags'] })
    queryClient.invalidateQueries({ queryKey: ['tag-groups'] })
    queryClient.invalidateQueries({ queryKey: ['media'] })
  }

  const mergeTagsMutation = useMutation({
    mutationFn: () => mergeTags(mergeSelected, mergeTargetId ? Number(mergeTargetId) : undefined),
    onSuccess: () => {
      invalidate()
      notifySaved()
      setMergeSelected([])
      setMergeTargetId('')
    },
  })

  const mergeGroupsMutation = useMutation({
    mutationFn: () => mergeTagGroups(mergeSelected, Number(mergeTargetId)),
    onSuccess: () => {
      invalidate()
      notifySaved()
      setMergeSelected([])
      setMergeTargetId('')
    },
  })

  const aliasMutation = useMutation({
    mutationFn: () => aliasTagsBatch(aliasSelectedIds, Number(aliasCanonicalId)),
    onSuccess: () => {
      invalidate()
      notifySaved()
      setAliasSelectedIds([])
      setAliasCanonicalId('')
    },
  })

  const reindexMutation = useMutation({
    mutationFn: () => (isGroups ? reindexTagGroupOrder() : reindexTagOrder()),
    onSuccess: () => {
      invalidate()
      notifySaved()
    },
  })

  const mergeTargetExclude = mergeTargetId ? [Number(mergeTargetId)] : []
  const aliasCanonicalExclude = aliasCanonicalId ? [Number(aliasCanonicalId)] : []
  const mergePending = isGroups ? mergeGroupsMutation.isPending : mergeTagsMutation.isPending
  const mergeError = isGroups ? mergeGroupsMutation.error : mergeTagsMutation.error
  const backTo = isGroups ? '/tags/groups' : '/tags'
  const backLabel = isGroups ? '← Back to tag groups' : '← Back to tags'

  return (
    <div className="page">
      <div className="page-header">
        <Link to={backTo} className="btn btn-small">
          {backLabel}
        </Link>
        <h2 className="page-title">{isGroups ? 'Tag group settings' : 'Tag settings'}</h2>
      </div>

      {isGroups ? (
        <div className="panel">
          <h2>Merge tag groups</h2>
          <p className="settings-hint">
            Select one or more groups to remove, then pick the group their tags should move into.
            Source groups are deleted after merge. The Unknown group cannot be merged away.
          </p>
          <FormField label="Groups to merge (will be removed)">
            <SearchableGroupMultiSelect
              groups={groups.filter((g) => g.key !== 'unknown')}
              selectedIds={mergeSelected}
              onChange={setMergeSelected}
              excludeIds={mergeTargetExclude}
              searchPlaceholder="Search groups to merge..."
            />
          </FormField>
          <FormField label="Merge into (kept)">
            <SearchableGroupSingleSelect
              groups={groups}
              selectedId={mergeTargetId}
              onChange={setMergeTargetId}
              excludeIds={mergeSelected}
              searchPlaceholder="Search target group..."
            />
          </FormField>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={mergeSelected.length < 1 || !mergeTargetId || mergePending}
              onClick={() => mergeGroupsMutation.mutate()}
            >
              Merge {mergeSelected.length} group{mergeSelected.length === 1 ? '' : 's'} into target
            </button>
          </div>
          {mergeGroupsMutation.isError && (
            <div className="error">
              {mergeError instanceof Error ? mergeError.message : 'Merge failed'}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="panel">
            <h2>Merge tags</h2>
            <p className="settings-hint">
              Select one or more tags to remove, then pick the tag they should become on all media.
              Source tags are deleted after merge; every media item will use the target tag instead.
            </p>
            <FormField label="Tags to merge (will be removed)">
              <SearchableTagMultiSelect
                tags={tags}
                selectedIds={mergeSelected}
                onChange={setMergeSelected}
                excludeIds={mergeTargetExclude}
                searchPlaceholder="Search tags to merge..."
              />
            </FormField>
            <FormField label="Merge into (kept on media)">
              <SearchableTagSingleSelect
                tags={tags}
                selectedId={mergeTargetId}
                onChange={setMergeTargetId}
                excludeIds={mergeSelected}
                searchPlaceholder="Search target tag..."
              />
            </FormField>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={mergeSelected.length < 1 || !mergeTargetId || mergePending}
                onClick={() => mergeTagsMutation.mutate()}
              >
                Merge {mergeSelected.length} tag{mergeSelected.length === 1 ? '' : 's'} into target
              </button>
            </div>
            {mergeTagsMutation.isError && (
              <div className="error">
                {mergeError instanceof Error ? mergeError.message : 'Merge failed'}
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Tag aliases</h2>
            <p className="settings-hint">
              Link similar tags without merging them on media. Pick the alternate names, then choose
              the main tag they should be shown as in lists (when Display tag aliases is on in
              Settings).
            </p>
            <FormField label="Alternate tag names">
              <SearchableTagMultiSelect
                tags={tags}
                selectedIds={aliasSelectedIds}
                onChange={setAliasSelectedIds}
                excludeIds={aliasCanonicalExclude}
                searchPlaceholder="Search alternate tags..."
              />
            </FormField>
            <FormField label="Main tag (shown in lists)">
              <SearchableTagSingleSelect
                tags={tags}
                selectedId={aliasCanonicalId}
                onChange={setAliasCanonicalId}
                excludeIds={aliasSelectedIds}
                searchPlaceholder="Search main tag..."
              />
            </FormField>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  aliasSelectedIds.length < 1 || !aliasCanonicalId || aliasMutation.isPending
                }
                onClick={() => aliasMutation.mutate()}
              >
                Link {aliasSelectedIds.length} alias
                {aliasSelectedIds.length === 1 ? '' : 'es'}
              </button>
            </div>
            {aliasMutation.isError && (
              <div className="error">
                {aliasMutation.error instanceof Error
                  ? aliasMutation.error.message
                  : 'Failed to set aliases'}
              </div>
            )}
          </div>
        </>
      )}

      <div className="panel">
        <h2>Reset order by name</h2>
        <p className="settings-hint">
          {isGroups
            ? 'Reassign group order alphabetically by label. Unknown stays last.'
            : 'Reassign every tag’s order alphabetically by name within its group.'}
        </p>
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            disabled={reindexMutation.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: isGroups ? 'Reset group order by name' : 'Reset tag order by name',
                message: isGroups
                  ? 'Reassign tag group order alphabetically by label? Unknown stays last.'
                  : 'Reassign every tag’s order alphabetically by name within its group?',
                confirmLabel: 'Reset order',
              })
              if (ok) reindexMutation.mutate()
            }}
          >
            Reset order by name
          </button>
        </div>
      </div>
    </div>
  )
}
