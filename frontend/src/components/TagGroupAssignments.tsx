import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { Tag, TagGroup } from '../types'
import { registerEscapeHandler } from '../utils/escapeStack'
import GroupChip from './GroupChip'

interface Props {
  tag: Tag
  allGroups: TagGroup[]
  onAddGroup: (groupId: number) => void
  onRemoveGroup: (groupId: number) => void
  onReplaceGroup: (fromGroupId: number, toGroupId: number) => void
}

type MenuMode = { kind: 'add' } | { kind: 'replace'; fromId: number }

export default function TagGroupAssignments({
  tag,
  allGroups,
  onAddGroup,
  onRemoveGroup,
  onReplaceGroup,
}: Props) {
  const [menu, setMenu] = useState<MenuMode | null>(null)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({})
  const wrapRef = useRef<HTMLDivElement>(null)
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const chipRefs = useRef<Map<number, HTMLElement>>(new Map())
  const menuRef = useRef<HTMLDivElement>(null)

  const groups = tag.groups ?? (tag.group ? [tag.group] : [])
  const assignedIds = new Set(groups.map((g) => g.id))
  const availableForAdd = allGroups.filter((g) => !assignedIds.has(g.id) && g.key !== 'unknown')

  const availableForReplace =
    menu?.kind === 'replace'
      ? allGroups.filter((g) => g.id !== menu.fromId && !assignedIds.has(g.id) && g.key !== 'unknown')
      : []

  const options = menu?.kind === 'add' ? availableForAdd : availableForReplace

  useLayoutEffect(() => {
    if (!menu) return

    const anchor =
      menu.kind === 'add' ? addBtnRef.current : chipRefs.current.get(menu.fromId) ?? null
    if (!anchor) return

    const rect = anchor.getBoundingClientRect()
    const margin = 4
    const maxWidth = Math.min(448, window.innerWidth - 16)
    let left = Math.min(rect.left, window.innerWidth - maxWidth - 8)
    left = Math.max(8, left)

    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const showAbove = spaceBelow < 96 && spaceAbove > spaceBelow

    setMenuStyle({
      position: 'fixed',
      left,
      top: showAbove ? rect.top - margin : rect.bottom + margin,
      transform: showAbove ? 'translateY(-100%)' : undefined,
      maxWidth,
      zIndex: 1000,
    })
  }, [menu, options.length])

  useEffect(() => {
    if (!menu) return

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setMenu(null)
    }

    document.addEventListener('mousedown', onPointerDown)
    const unregisterEsc = registerEscapeHandler(() => setMenu(null))
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      unregisterEsc()
    }
  }, [menu])

  return (
    <div className="tag-group-assignments" ref={wrapRef}>
      {groups.map((group) => (
        <span
          key={group.id}
          ref={(el) => {
            if (el) chipRefs.current.set(group.id, el)
            else chipRefs.current.delete(group.id)
          }}
          className="tag-group-chip-wrap"
        >
          <GroupChip
            group={group}
            small
            clickable
            title="Click to change group"
            onClick={() =>
              setMenu((current) =>
                current?.kind === 'replace' && current.fromId === group.id
                  ? null
                  : { kind: 'replace', fromId: group.id },
              )
            }
            onRemove={groups.length > 1 ? () => onRemoveGroup(group.id) : undefined}
          />
        </span>
      ))}
      {availableForAdd.length > 0 && (
        <div className="tag-group-add-wrap">
          <button
            ref={addBtnRef}
            type="button"
            className="btn btn-small tag-group-add-btn"
            onClick={() =>
              setMenu((current) => (current?.kind === 'add' ? null : { kind: 'add' }))
            }
            aria-label="Add tag group"
            aria-expanded={menu?.kind === 'add'}
          >
            +
          </button>
        </div>
      )}
      {menu && options.length > 0 && (
        <div ref={menuRef} className="tag-group-add-menu" style={menuStyle}>
          {menu.kind === 'replace' && (
            <div className="tag-group-menu-hint">Replace with</div>
          )}
          {options.map((group) => (
            <button
              key={group.id}
              type="button"
              className="tag-group-add-option"
              onClick={() => {
                if (menu.kind === 'add') onAddGroup(group.id)
                else onReplaceGroup(menu.fromId, group.id)
                setMenu(null)
              }}
            >
              <GroupChip group={group} small />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
