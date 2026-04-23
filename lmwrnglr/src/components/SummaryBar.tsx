import { useState, useEffect, useMemo } from 'react'
import { useWorkspaceStore, collectTerminalIds } from '../store/workspaceStore'
import type { ActivityEntry, PaneState } from '../types'

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function SummaryBar() {
  const [expanded, setExpanded] = useState(true)
  // Tick every 30 s so relative timestamps stay fresh without any API cost
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const paneStates = useWorkspaceStore(s => s.paneStates)
  const rootPane = useWorkspaceStore(s => s.rootPane)

  // Aggregate entries from all currently active panes, newest first
  const entries: ActivityEntry[] = useMemo(() => {
    const activeIds = new Set(collectTerminalIds(rootPane))
    const all: ActivityEntry[] = []
    for (const [paneId, state] of Object.entries(paneStates) as [string, PaneState][]) {
      if (activeIds.has(paneId) && state.activityLog) {
        all.push(...state.activityLog)
      }
    }
    return all.sort((a, b) => b.ts - a.ts).slice(0, 15)
  }, [paneStates, rootPane])

  return (
    <div className={`summary-bar${expanded ? ' summary-bar--expanded' : ''}`}>
      <div className="summary-header">
        <span className="summary-title">✦ Activity</span>
        <button
          className="summary-btn"
          onClick={() => setExpanded(v => !v)}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▲' : '▼'}
        </button>
      </div>

      {expanded && (
        <div className="summary-body">
          {entries.length === 0 ? (
            <span className="summary-hint">
              No activity yet — click <strong>✦ claude</strong> in a terminal to get started
            </span>
          ) : (
            <ul className="activity-list">
              {entries.map((entry, i) => (
                <li key={i} className="activity-entry">
                  <span className="activity-text">{entry.activity}</span>
                  {entry.branch && (
                    <span className="activity-branch">{entry.branch}</span>
                  )}
                  <span className="activity-time">{timeAgo(entry.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
