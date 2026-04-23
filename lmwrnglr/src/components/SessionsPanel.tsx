import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../tauriAPI'
import { useWorkspaceStore } from '../store/workspaceStore'

interface Props {
  onClose: () => void
  onRestoreHere: (session: api.WorkspaceSession) => void
}

const currentWid = new URLSearchParams(window.location.search).get('wid') ?? 'main'

export function SessionsPanel({ onClose, onRestoreHere }: Props) {
  const [openSessions, setOpenSessions] = useState<api.RestoreableSession[]>([])
  const [restoreable, setRestoreable] = useState<api.RestoreableSession[]>([])
  const [saved, setSaved] = useState<api.SavedSession[]>([])
  const [loading, setLoading] = useState(true)
  const [savingName, setSavingName] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const saveInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const { name, rootPane, accentColor, paneStates } = useWorkspaceStore()

  const refresh = useCallback(async () => {
    const [o, r, s] = await Promise.all([
      api.getOpenSessions(),
      api.getRestoreableSessions(),
      api.listSavedSessions(),
    ])
    setOpenSessions(o.filter(({ wid }) => wid !== currentWid))
    setRestoreable(r)
    setSaved(s)
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Focus the save input when it appears (only when the form transitions from
  // hidden to visible — not on every keystroke as savingName changes)
  const saveFormVisible = savingName !== null
  useEffect(() => {
    if (saveFormVisible) {
      setTimeout(() => { saveInputRef.current?.focus(); saveInputRef.current?.select() }, 0)
    }
  }, [saveFormVisible])

  // Focus the rename input when it appears
  useEffect(() => {
    if (renamingId !== null) {
      setTimeout(() => { renameInputRef.current?.focus(); renameInputRef.current?.select() }, 0)
    }
  }, [renamingId])

  const handleDeleteWorkspace = async (wid: string) => {
    await api.deleteWorkspaceSession(wid)
    setRestoreable(prev => prev.filter(r => r.wid !== wid))
  }

  const handleDeleteSaved = async (id: string) => {
    await api.deleteSavedSession(id)
    setSaved(prev => prev.filter(s => s.id !== id))
  }

  const handleRestoreHere = async (session: api.WorkspaceSession, wid?: string) => {
    onRestoreHere(session)
    // Remove from the restoreable list — it's been absorbed into this window
    if (wid) {
      await api.deleteWorkspaceSession(wid)
      setRestoreable(prev => prev.filter(r => r.wid !== wid))
    }
    onClose()
  }

  const handleSave = async () => {
    if (savingName === null) return
    const trimmed = savingName.trim() || name
    const session: api.WorkspaceSession = {
      name: trimmed,
      rootPane,
      accentColor,
      paneStates,
    }
    await api.saveNamedSession(session)
    setSavingName(null)
    await refresh()
  }

  const startRename = (id: string, currentName: string) => {
    setRenamingId(id)
    setRenameDraft(currentName)
  }

  const commitRename = async (id: string) => {
    const trimmed = renameDraft.trim()
    if (trimmed) {
      await api.renameSavedSession(id, trimmed)
      setSaved(prev =>
        prev.map(s => s.id === id ? { ...s, session: { ...s.session, name: trimmed } } : s)
      )
    }
    setRenamingId(null)
  }

  const isEmpty = openSessions.length === 0 && restoreable.length === 0 && saved.length === 0

  return (
    <div className="sessions-panel">
      {loading ? (
        <div className="sessions-empty">Loading…</div>
      ) : (
        <>
          {isEmpty && savingName === null && (
            <div className="sessions-empty">No saved sessions yet.</div>
          )}

          {openSessions.length > 0 && (
            <div className="sessions-section">
              <div className="sessions-section-title">Open Windows</div>
              {openSessions.map(({ wid, session }) => (
                <div key={wid} className="session-row">
                  <span className="session-row-name" title={session.name as string}>
                    {session.name as string}
                  </span>
                  <div className="session-row-actions">
                    <button
                      className="session-btn"
                      title="Switch to this window"
                      onClick={() => { api.focusWorkspace(wid); onClose() }}
                    >
                      Switch
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {restoreable.length > 0 && (
            <div className="sessions-section">
              <div className="sessions-section-title">Recent Workspaces</div>
              {restoreable.map(({ wid, session }) => (
                <div key={wid} className="session-row">
                  <span className="session-row-name" title={session.name as string}>
                    {session.name as string}
                  </span>
                  <div className="session-row-actions">
                    <button
                      className="session-btn"
                      title="Restore in this window"
                      onClick={() => handleRestoreHere(session, wid)}
                    >
                      Replace
                    </button>
                    <button
                      className="session-btn"
                      title="Open in a new window"
                      onClick={() => { api.openWindowWithWid(wid); onClose() }}
                    >
                      Open
                    </button>
                    <button
                      className="session-btn session-btn--danger"
                      title="Delete this session"
                      onClick={() => handleDeleteWorkspace(wid)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {saved.length > 0 && (
            <div className="sessions-section">
              <div className="sessions-section-title">Saved Sessions</div>
              {saved.map(({ id, session }) => (
                <div key={id} className="session-row">
                  {renamingId === id ? (
                    <input
                      ref={renameInputRef}
                      className="session-rename-input"
                      value={renameDraft}
                      onChange={e => setRenameDraft(e.target.value)}
                      onBlur={() => commitRename(id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename(id)
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                    />
                  ) : (
                    <span
                      className="session-row-name session-row-name--saved"
                      title="Double-click to rename"
                      onDoubleClick={() => startRename(id, session.name as string)}
                    >
                      ★ {session.name as string}
                    </span>
                  )}
                  <div className="session-row-actions">
                    <button
                      className="session-btn"
                      title="Restore in this window"
                      onClick={() => { handleRestoreHere(session); onClose() }}
                    >
                      Replace
                    </button>
                    <button
                      className="session-btn"
                      title="Open in a new window"
                      onClick={() => { api.openSavedSessionInNewWindow(id); onClose() }}
                    >
                      Open
                    </button>
                    <button
                      className="session-btn session-btn--danger"
                      title="Delete this session"
                      onClick={() => handleDeleteSaved(id)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="sessions-save-area">
            {savingName === null ? (
              <button
                className="sessions-save-trigger"
                onClick={() => setSavingName(name)}
              >
                + Save current workspace as…
              </button>
            ) : (
              <div className="sessions-save-form">
                <input
                  ref={saveInputRef}
                  className="sessions-save-input"
                  value={savingName}
                  placeholder="Session name"
                  onChange={e => setSavingName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleSave()
                    if (e.key === 'Escape') setSavingName(null)
                  }}
                />
                <button className="sessions-save-btn" onClick={handleSave}>Save</button>
                <button className="sessions-cancel-btn" onClick={() => setSavingName(null)}>✕</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
