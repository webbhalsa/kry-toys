import { useRef, useState, useEffect } from 'react'
import { useWorkspaceStore } from '../store/workspaceStore'
import { SessionsPanel } from './SessionsPanel'
import * as api from '../tauriAPI'

const ACCENT_COLORS = [
  { label: 'Default', value: undefined },
  { label: 'Blue',    value: '#1e3a5f' },
  { label: 'Purple',  value: '#2d1b4e' },
  { label: 'Green',   value: '#1a3a2a' },
  { label: 'Red',     value: '#3a1a1a' },
  { label: 'Orange',  value: '#3a2a10' },
  { label: 'Teal',    value: '#0d2d2d' },
]

interface Props {
  onOpenPrefs: () => void
  onRestoreHere: (session: api.WorkspaceSession) => void
}

export function Toolbar({ onOpenPrefs, onRestoreHere }: Props) {
  const { name, setName, resetWorkspace, accentColor, setAccentColor } = useWorkspaceStore()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [showColors, setShowColors] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const colorPickerRef = useRef<HTMLDivElement>(null)
  const sessionsRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setDraft(name) }, [name])

  useEffect(() => {
    if (!showColors) return
    const handler = (e: MouseEvent) => {
      if (!colorPickerRef.current?.contains(e.target as Node)) setShowColors(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showColors])

  useEffect(() => {
    if (!showSessions) return
    const handler = (e: MouseEvent) => {
      if (!sessionsRef.current?.contains(e.target as Node)) setShowSessions(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showSessions])

  const commitName = () => {
    const trimmed = draft.trim() || 'Workspace'
    setName(trimmed)
    api.setWindowTitle(trimmed)
    setEditing(false)
  }

  const startEditing = () => {
    setDraft(name)
    setEditing(true)
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select() }, 0)
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // Don't intercept clicks on interactive children
    if ((e.target as HTMLElement).closest('button, input')) return
    // Explicit Rust command for drag — avoids needing window capability
    // permissions; works whether or not the window already has focus.
    api.startDragging()
  }

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Let the workspace name's own double-click (rename) handler take priority
    if ((e.target as HTMLElement).closest('button, input, .toolbar-name')) return
    api.toggleMaximize()
  }

  return (
    <div className="toolbar" onMouseDown={handleMouseDown} onDoubleClick={handleDoubleClick} style={accentColor ? { background: accentColor } : undefined}>
      <div className="toolbar-title">
        {editing ? (
          <input
            ref={inputRef}
            className="toolbar-name-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName()
              if (e.key === 'Escape') { setDraft(name); setEditing(false) }
            }}
          />
        ) : (
          <span
            className="toolbar-name"
            onDoubleClick={startEditing}
            title="Double-click to rename"
          >
            {name}
          </span>
        )}
      </div>
      <div className="toolbar-actions">
        <div className="color-picker-wrapper" ref={colorPickerRef}>
          <button
            className="toolbar-btn toolbar-btn--icon toolbar-btn--color"
            title="Workspace color"
            onClick={() => setShowColors(v => !v)}
          >
            <span className="color-dot" style={{ background: accentColor ?? '#45475a' }} />
          </button>
          {showColors && (
            <div className="color-swatches">
              {ACCENT_COLORS.map(({ label, value }) => (
                <button
                  key={label}
                  className={`color-swatch${accentColor === value ? ' color-swatch--active' : ''}`}
                  title={label}
                  style={{ background: value ?? '#1e1e2e' }}
                  onClick={() => { setAccentColor(value); setShowColors(false) }}
                />
              ))}
            </div>
          )}
        </div>
        <div className="sessions-wrapper" ref={sessionsRef}>
          <button
            className={`toolbar-btn${showSessions ? ' toolbar-btn--active' : ''}`}
            title="Sessions"
            onClick={() => setShowSessions(v => !v)}
          >
            Sessions
          </button>
          {showSessions && (
            <SessionsPanel
              onClose={() => setShowSessions(false)}
              onRestoreHere={onRestoreHere}
            />
          )}
        </div>
        <button className="toolbar-btn" onClick={() => api.openNewWindow()} title="Open a new workspace window">
          + New Workspace
        </button>
        <button
          className="toolbar-btn toolbar-btn--icon"
          title="Reset workspace"
          onClick={async () => {
            const hasRunning = await api.windowHasSubprocess()
            if (hasRunning) {
              const ok = window.confirm(
                'Some terminals have running processes. Reset the workspace? All processes will be killed.'
              )
              if (!ok) return
            }
            resetWorkspace()
          }}
        >
          ↺
        </button>
        <button className="toolbar-btn toolbar-btn--icon" onClick={onOpenPrefs} title="Preferences">
          ⚙
        </button>
      </div>
    </div>
  )
}
