import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { fetchDuplicates } from '../api/client'
import { usePageClamp } from '../hooks/usePageClamp'
import { paginationTotalPages } from '../utils/pagination'
import DuplicateGroupCard from './DuplicateGroupCard'
import PaginationBar from './list/PaginationBar'

const PAGE_SIZE = 5

export default function DuplicatesPanel() {
  const [expanded, setExpanded] = useState(false)
  const [page, setPage] = useState(1)
  const { data, isLoading, error } = useQuery({
    queryKey: ['duplicates'],
    queryFn: fetchDuplicates,
    enabled: expanded,
  })

  const identical = data?.identical ?? []
  const similar = data?.similar ?? []
  const groups = [
    ...identical.map((group) => ({ group, kind: 'identical' as const })),
    ...similar.map((group) => ({ group, kind: 'similar' as const })),
  ]
  const totalPages = paginationTotalPages(groups.length, PAGE_SIZE)
  usePageClamp(page, totalPages, setPage)
  const pageGroups = groups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div className="panel panel-collapsible">
      <button
        type="button"
        className="panel-collapse-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <h2>Similar files</h2>
        <span className="panel-collapse-toggle" aria-hidden="true">
          {expanded ? '^' : 'v'}
        </span>
      </button>
      {expanded && (
        <div className="panel-collapse-body">
          <p className="hint">
            Identical files look like the same picture or the same video (including different resolution).
            Similar files are close picture matches such as crops or watermarks. Exact byte matches
            were skipped while scraping.
          </p>
          {isLoading && <div className="empty">Loading...</div>}
          {error && <div className="error">Failed to load duplicates</div>}
          {groups.length === 0 && !isLoading && (
            <div className="empty">No similar files to review.</div>
          )}
          {pageGroups.some(({ kind }) => kind === 'identical') && <h3>Identical</h3>}
          {pageGroups
            .filter(({ kind }) => kind === 'identical')
            .map(({ group }) => (
              <DuplicateGroupCard key={`i-${group.primary_id}`} group={group} kind="identical" />
            ))}
          {pageGroups.some(({ kind }) => kind === 'similar') && <h3>Similar</h3>}
          {pageGroups
            .filter(({ kind }) => kind === 'similar')
            .map(({ group }) => (
              <DuplicateGroupCard key={`s-${group.primary_id}`} group={group} kind="similar" />
            ))}
          {groups.length > 0 && (
            <PaginationBar
              page={page}
              totalPages={totalPages}
              shown={pageGroups.length}
              total={groups.length}
              noun="groups"
              onPageChange={setPage}
            />
          )}
        </div>
      )}
    </div>
  )
}
