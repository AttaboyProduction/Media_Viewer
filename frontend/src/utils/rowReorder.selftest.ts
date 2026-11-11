/**
 * Frontend mirror of the order-island moves, through the helpers TagsPage and
 * TagGroupsPage actually call. Keep aligned with tests/test_order_islands.py.
 *
 * Run via scripts/run_order_tests.bat or:
 *   npx --yes tsx frontend/src/utils/rowReorder.selftest.ts
 */

import {
  applyDenseMoveSortOrder,
  applySparseMoveSortOrder,
  reorderIdsWithPlacement,
  sortOrderForDrop,
} from './rowReorder.ts'

type Row = { id: number; sort_order: number; group_id?: number | null }

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`)
}

function orders(rows: Row[]) {
  return rows.map((r) => r.sort_order).sort((a, b) => a - b)
}

function idsInOrder(rows: Row[]) {
  return [...rows].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map((r) => r.id)
}

/** Fails unless every order forms a single gap-free, duplicate-free run. */
function expectOneIsland(rows: Row[], label: string) {
  const values = orders(rows)
  const dense = values[values.length - 1] - values[0] + 1 === values.length
  if (!dense || new Set(values).size !== values.length) {
    throw new Error(`${label}: expected one dense island, got ${JSON.stringify(values)}`)
  }
}

// TagsPage scopes moves to the dragged tag's group (sameTagGroup).
const sameGroup = (row: Row, moved: Row) => (row.group_id ?? null) === (moved.group_id ?? null)

const cases: Array<{ name: string; run: () => void }> = [
  {
    name: 'groups: drop before a late island joins at start-1',
    run: () => {
      const rows: Row[] = [
        { id: 1, sort_order: 10 },
        { id: 2, sort_order: 9998 },
        { id: 3, sort_order: 9999 },
      ]
      const next = applySparseMoveSortOrder(rows, 1, sortOrderForDrop(9998, 'before'))
      eq(orders(next), [9997, 9998, 9999], 'orders')
      eq(idsInOrder(next), [1, 2, 3], 'sequence')
      expectOneIsland(next, 'islands')
    },
  },
  {
    name: 'groups: move after last row stays one dense island',
    run: () => {
      const rows: Row[] = [
        { id: 1, sort_order: 1 },
        { id: 2, sort_order: 2 },
        { id: 3, sort_order: 3 },
        { id: 4, sort_order: 4 },
      ]
      const next = applySparseMoveSortOrder(rows, 3, sortOrderForDrop(4, 'after'))
      eq(orders(next), [1, 2, 3, 4], 'orders')
      eq(idsInOrder(next), [1, 2, 4, 3], 'sequence')
      expectOneIsland(next, 'islands')
    },
  },
  {
    name: 'groups: typing into a 1-slot gap joins the next island',
    run: () => {
      const rows: Row[] = [
        { id: 1, sort_order: 996 },
        { id: 2, sort_order: 998 },
        { id: 3, sort_order: 999 },
      ]
      const next = applySparseMoveSortOrder(rows, 1, 997)
      eq(orders(next), [997, 998, 999], 'orders')
      expectOneIsland(next, 'islands')
    },
  },
  {
    name: 'groups: insert into the joined island has no duplicate or +10 bump',
    run: () => {
      const rows: Row[] = [
        { id: 0, sort_order: 10 },
        { id: 1, sort_order: 997 },
        { id: 2, sort_order: 998 },
        { id: 3, sort_order: 999 },
      ]
      const next = applySparseMoveSortOrder(rows, 0, sortOrderForDrop(997, 'after'))
      eq(orders(next), [997, 998, 999, 1000], 'orders')
      eq(idsInOrder(next), [1, 0, 2, 3], 'sequence')
      expectOneIsland(next, 'islands')
    },
  },
  {
    name: 'groups: unrelated later island is not pulled down',
    run: () => {
      const rows: Row[] = [
        { id: 1, sort_order: 1 },
        { id: 2, sort_order: 2 },
        { id: 3, sort_order: 3 },
        { id: 9, sort_order: 999 },
      ]
      const next = applySparseMoveSortOrder(rows, 1, sortOrderForDrop(3, 'after'))
      eq(next.find((r) => r.id === 9)!.sort_order, 999, 'late row untouched')
      eq(idsInOrder(next), [2, 3, 1, 9], 'sequence')
    },
  },
  {
    name: 'tags: move is scoped to the dragged tag group',
    run: () => {
      const rows: Row[] = [
        { id: 1, sort_order: 10, group_id: 1 },
        { id: 2, sort_order: 9998, group_id: 1 },
        { id: 3, sort_order: 9999, group_id: 1 },
        { id: 4, sort_order: 9998, group_id: 2 },
        { id: 5, sort_order: 9999, group_id: 2 },
      ]
      const next = applyDenseMoveSortOrder(rows, 1, sortOrderForDrop(9998, 'before'), sameGroup)
      const first = next.filter((r) => r.group_id === 1)
      const second = next.filter((r) => r.group_id === 2)
      eq(orders(first), [9997, 9998, 9999], 'moved group orders')
      eq(orders(second), [9998, 9999], 'other group untouched')
    },
  },
  {
    name: 'groups: growing an island pushes the neighbour instead of overlapping',
    run: () => {
      const rows: Row[] = [
        { id: 1, sort_order: 1 },
        { id: 2, sort_order: 2 },
        { id: 3, sort_order: 4 },
        { id: 4, sort_order: 5 },
        { id: 5, sort_order: 30 },
      ]
      const next = applySparseMoveSortOrder(rows, 5, 2)
      eq(orders(next), [1, 2, 3, 14, 15], 'orders')
      const unique = new Set(next.map((r) => r.sort_order))
      if (unique.size !== next.length) throw new Error('duplicate sort_order after push')
    },
  },
  {
    name: 'preview: reorderIdsWithPlacement matches before/after drops',
    run: () => {
      eq(reorderIdsWithPlacement([1, 2, 3, 4], 3, 1, 'before'), [3, 1, 2, 4], 'before')
      eq(reorderIdsWithPlacement([1, 2, 3, 4], 1, 4, 'after'), [2, 3, 4, 1], 'after')
      eq(reorderIdsWithPlacement([1, 2, 3], 2, 2, 'before'), [1, 2, 3], 'self drop')
    },
  },
  {
    name: 'drop target: sortOrderForDrop keeps before/after semantics',
    run: () => {
      eq(sortOrderForDrop(5, 'before'), 5, 'before')
      eq(sortOrderForDrop(5, 'after'), 6, 'after')
    },
  },
]

let failed = 0
for (const testCase of cases) {
  try {
    testCase.run()
    console.log(`  ok   ${testCase.name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${testCase.name}\n       ${(error as Error).message}`)
  }
}

if (failed > 0) {
  // Throwing keeps this file free of Node typings while still failing the runner.
  throw new Error(`rowReorder.selftest: ${failed} of ${cases.length} cases failed`)
}
console.log(`rowReorder.selftest: ${cases.length} passed`)
