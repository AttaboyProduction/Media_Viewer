import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'

const DRAG_THRESHOLD_PX = 4

function idsBetween(orderedIds: number[], fromId: number, toId: number): number[] {
  const fromIdx = orderedIds.indexOf(fromId)
  const toIdx = orderedIds.indexOf(toId)
  if (fromIdx < 0 || toIdx < 0) return [toId]
  const [a, b] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx]
  return orderedIds.slice(a, b + 1)
}

/** Checkbox selection for a media grid: click, Shift-range, and drag. Cards need `data-select-id`. */
export function useMediaMultiSelect(pageIds: number[], options?: { startSelected?: boolean }) {
  const [selectMode, setSelectMode] = useState(Boolean(options?.startSelected))
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [anchorId, setAnchorId] = useState<number | null>(null)
  const [anchorMode, setAnchorMode] = useState<'select' | 'deselect'>('select')
  const dragRef = useRef<{
    startX: number
    startY: number
    startId: number
    shiftKey: boolean
    moved: boolean
    mode: 'select' | 'deselect'
    touched: Set<number>
  } | null>(null)
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds
  const anchorIdRef = useRef(anchorId)
  anchorIdRef.current = anchorId
  const anchorModeRef = useRef(anchorMode)
  anchorModeRef.current = anchorMode
  const pageIdsRef = useRef(pageIds)
  pageIdsRef.current = pageIds
  const selectModeRef = useRef(selectMode)
  selectModeRef.current = selectMode

  const clearSelection = useCallback(() => {
    setSelectedIds([])
    setAnchorId(null)
    setAnchorMode('select')
  }, [])

  const exitSelectMode = useCallback(() => {
    setSelectMode(false)
    setSelectedIds([])
    setAnchorId(null)
    setAnchorMode('select')
  }, [])

  const enterSelectMode = useCallback(() => {
    setSelectMode(true)
    setSelectedIds([])
    setAnchorId(null)
    setAnchorMode('select')
  }, [])

  const toggleSelectMode = useCallback(() => {
    setSelectMode((on) => {
      setSelectedIds([])
      setAnchorId(null)
      setAnchorMode('select')
      return !on
    })
  }, [])

  const applyDragTouch = (id: number, mode: 'select' | 'deselect') => {
    setSelectedIds((prev) => {
      const has = prev.includes(id)
      if (mode === 'select' && !has) return [...prev, id]
      if (mode === 'deselect' && has) return prev.filter((x) => x !== id)
      return prev
    })
  }

  const finishSelectClick = (id: number, shiftKey: boolean) => {
    const anchor = anchorIdRef.current
    const mode = anchorModeRef.current
    if (shiftKey && anchor != null) {
      const range = idsBetween(pageIdsRef.current, anchor, id)
      if (mode === 'deselect') {
        setSelectedIds((prev) => prev.filter((x) => !range.includes(x)))
      } else {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          for (const rangeId of range) next.add(rangeId)
          return [...next]
        })
      }
      return
    }
    const wasSelected = selectedIdsRef.current.includes(id)
    if (wasSelected) {
      setSelectedIds((prev) => prev.filter((x) => x !== id))
      setAnchorId(id)
      setAnchorMode('deselect')
    } else {
      setSelectedIds((prev) => [...prev, id])
      setAnchorId(id)
      setAnchorMode('select')
    }
  }

  const onSelectPointerDown = (e: ReactMouseEvent, id: number) => {
    if (!selectModeRef.current || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    window.getSelection()?.removeAllRanges()
    const wasSelected = selectedIdsRef.current.includes(id)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startId: id,
      shiftKey: e.shiftKey,
      moved: false,
      mode: wasSelected ? 'deselect' : 'select',
      touched: new Set([id]),
    }
  }

  useEffect(() => {
    if (!selectMode) return

    const idFromPoint = (x: number, y: number): number | null => {
      const el = document.elementFromPoint(x, y)
      const card = el?.closest?.('[data-select-id]') as HTMLElement | null
      if (!card) return null
      const raw = card.getAttribute('data-select-id')
      const id = raw ? Number(raw) : NaN
      return Number.isFinite(id) ? id : null
    }

    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!drag.moved && dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return
      if (!drag.moved) {
        drag.moved = true
        applyDragTouch(drag.startId, drag.mode)
      }
      e.preventDefault()
      window.getSelection()?.removeAllRanges()
      const id = idFromPoint(e.clientX, e.clientY)
      if (id == null || drag.touched.has(id)) return
      drag.touched.add(id)
      applyDragTouch(id, drag.mode)
      setAnchorId(id)
    }

    const onUp = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      if (!drag.moved) {
        finishSelectClick(drag.startId, drag.shiftKey || e.shiftKey)
      } else {
        const touched = [...drag.touched]
        setAnchorId(touched[touched.length - 1] ?? drag.startId)
        setAnchorMode(drag.mode)
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [selectMode])

  return {
    selectMode,
    selectedIds,
    setSelectedIds,
    toggleSelectMode,
    onSelectPointerDown,
    clearSelection,
    enterSelectMode,
    exitSelectMode,
  }
}
