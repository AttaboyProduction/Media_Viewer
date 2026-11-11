import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'

import { fetchTags } from '../api/client'
import type { Tag } from '../types'
import type { ContentHideRule } from '../types/appSettings'
import {
  defaultContentHideRuleLabel,
  newContentHideRuleId,
} from '../utils/contentHide'
import TagChip from './TagChip'
import { SearchableTagMultiSelect } from './TagChipSelect'
import { SettingsOption } from './SettingsOption'

type Props = {
  rules: ContentHideRule[]
  revealedRuleIds: string[]
  onChange: (rules: ContentHideRule[]) => void
  onRevealedChange: (revealedRuleIds: string[]) => void
}

export default function ContentHideRulesEditor({
  rules,
  revealedRuleIds,
  onChange,
  onRevealedChange,
}: Props) {
  const { data: allTags = [] } = useQuery({ queryKey: ['tags'], queryFn: fetchTags })
  const revealedSet = useMemo(() => new Set(revealedRuleIds), [revealedRuleIds])
  const anyRevealed = rules.some((r) => revealedSet.has(r.id))
  // Expanded when empty; collapsed by default once any rules exist.
  const [listOpen, setListOpen] = useState(() => rules.length === 0)
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (rules.length === 0) setListOpen(true)
  }, [rules.length])

  const updateRule = (id: string, patch: Partial<ContentHideRule>) => {
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  const removeRule = (id: string) => {
    onChange(rules.filter((r) => r.id !== id))
    if (revealedSet.has(id)) {
      onRevealedChange(revealedRuleIds.filter((x) => x !== id))
    }
    setOpenIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const addRule = () => {
    const id = newContentHideRuleId()
    const label = defaultContentHideRuleLabel(rules.length + 1)
    onChange([...rules, { id, label, tag_names: [], message: '' }])
    setListOpen(true)
    setOpenIds((prev) => new Set(prev).add(id))
  }

  const hideRuleAgain = (id: string) => {
    onRevealedChange(revealedRuleIds.filter((x) => x !== id))
  }

  const hideAllAgain = () => {
    onRevealedChange([])
  }

  const toggleOpen = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const listSummary =
    rules.length === 0
      ? 'No rules'
      : `${rules.length} rule${rules.length === 1 ? '' : 's'}`

  return (
    <div className="content-hide-rules-editor">
      {anyRevealed && (
        <div className="content-hide-rules-actions">
          <button type="button" className="btn btn-small" onClick={hideAllAgain}>
            Hide all content again
          </button>
          <span className="settings-hint">Clears every one-time unlock and re-blurs matching media.</span>
        </div>
      )}

      <div className={`content-hide-rules-list${listOpen ? '' : ' content-hide-rules-list-collapsed'}`}>
        <button
          type="button"
          className="content-hide-rules-list-toggle"
          onClick={() => setListOpen((v) => !v)}
          aria-expanded={listOpen}
        >
          <span className="panel-collapse-toggle" aria-hidden="true">
            {listOpen ? '^' : 'v'}
          </span>
          <span className="content-hide-rule-summary">Rules · {listSummary}</span>
        </button>

        {listOpen && (
          <div className="content-hide-rules-list-body">
            {rules.length === 0 && (
              <p className="settings-hint">
                No hide rules yet. Add a rule with one or more tags to blur matching media.
              </p>
            )}
            {rules.map((rule, index) => (
              <ContentHideRuleRow
                key={rule.id}
                rule={rule}
                index={index}
                allTags={allTags}
                revealed={revealedSet.has(rule.id)}
                open={openIds.has(rule.id)}
                onToggle={() => toggleOpen(rule.id)}
                onChange={(patch) => updateRule(rule.id, patch)}
                onRemove={() => removeRule(rule.id)}
                onHideAgain={() => hideRuleAgain(rule.id)}
              />
            ))}
          </div>
        )}
        <button type="button" className="btn btn-small" onClick={addRule}>
          Add rule
        </button>
      </div>
    </div>
  )
}

function ContentHideRuleRow({
  rule,
  index,
  allTags,
  revealed,
  open,
  onToggle,
  onChange,
  onRemove,
  onHideAgain,
}: {
  rule: ContentHideRule
  index: number
  allTags: Tag[]
  revealed: boolean
  open: boolean
  onToggle: () => void
  onChange: (patch: Partial<ContentHideRule>) => void
  onRemove: () => void
  onHideAgain: () => void
}) {
  const fallbackLabel = defaultContentHideRuleLabel(index + 1)
  const displayLabel = rule.label.trim() || fallbackLabel

  const selectedIds = useMemo(
    () => allTags.filter((t) => rule.tag_names.includes(t.name)).map((t) => t.id),
    [allTags, rule.tag_names],
  )

  const selectedTags = useMemo(
    () => allTags.filter((t) => rule.tag_names.includes(t.name)),
    [allTags, rule.tag_names],
  )

  const [messageDraft, setMessageDraft] = useState(rule.message)
  const [messageFocused, setMessageFocused] = useState(false)
  const [labelDraft, setLabelDraft] = useState(displayLabel)
  const [labelFocused, setLabelFocused] = useState(false)

  useEffect(() => {
    if (!messageFocused) setMessageDraft(rule.message)
  }, [rule.message, messageFocused])

  useEffect(() => {
    if (!labelFocused) setLabelDraft(displayLabel)
  }, [displayLabel, labelFocused])

  const commitMessage = () => {
    setMessageFocused(false)
    if (messageDraft === rule.message) return
    onChange({ message: messageDraft })
  }

  const commitLabel = () => {
    setLabelFocused(false)
    const next = labelDraft.trim() || fallbackLabel
    setLabelDraft(next)
    if (next === displayLabel) return
    onChange({ label: next })
  }

  return (
    <div
      className={`content-hide-rule${revealed ? ' content-hide-rule-revealed' : ''}${
        open ? '' : ' content-hide-rule-collapsed'
      }`}
    >
      <div className="content-hide-rule-header">
        <button
          type="button"
          className="content-hide-rule-toggle"
          onClick={onToggle}
          aria-expanded={open}
        >
          <span className="panel-collapse-toggle" aria-hidden="true">
            {open ? '^' : 'v'}
          </span>
          <span className="content-hide-rule-summary">
            {displayLabel}
            {revealed ? ' · revealed' : ''}
          </span>
        </button>
        <div className="content-hide-rule-header-actions">
          {revealed && (
            <button type="button" className="btn btn-small" onClick={onHideAgain}>
              Hide again
            </button>
          )}
          <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
      {open && (
        <div className="content-hide-rule-body">
          <SettingsOption label="Name">
            <input
              type="text"
              value={labelDraft}
              placeholder={fallbackLabel}
              onFocus={() => setLabelFocused(true)}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
          </SettingsOption>
          <span className="settings-hint">Tags (any match blurs)</span>
          {selectedTags.length > 0 && (
            <div className="content-hide-rule-tags" aria-label="Selected tags">
              {selectedTags.map((tag) => (
                <TagChip
                  key={tag.id}
                  tag={{
                    name: tag.name,
                    color: tag.color,
                    group: tag.group,
                    is_manual: false,
                  }}
                  active
                  onClick={() =>
                    onChange({
                      tag_names: rule.tag_names.filter((n) => n !== tag.name),
                    })
                  }
                />
              ))}
            </div>
          )}
          <SearchableTagMultiSelect
            tags={allTags}
            selectedIds={selectedIds}
            showSelectedPanel={false}
            searchPlaceholder="Add tags to this rule…"
            onChange={(ids) => {
              const names = ids
                .map((id) => allTags.find((t) => t.id === id)?.name)
                .filter((name): name is string => Boolean(name))
              onChange({ tag_names: names })
            }}
          />
          <SettingsOption label="Reveal message (optional)">
            <input
              type="text"
              value={messageDraft}
              placeholder="e.g. Are you older than 18?"
              onFocus={() => setMessageFocused(true)}
              onChange={(e) => setMessageDraft(e.target.value)}
              onBlur={commitMessage}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
          </SettingsOption>
        </div>
      )}
    </div>
  )
}
