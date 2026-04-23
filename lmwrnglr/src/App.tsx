import { useEffect, useRef, useState } from 'react'
import { Toolbar } from './components/Toolbar'
import { TabBar } from './components/TabBar'
import { SplitContainer } from './components/SplitContainer'
import { SummaryBar } from './components/SummaryBar'
import { PreferencesModal } from './components/PreferencesModal'
import { useWorkspaceStore, collectTerminalIds, matchesShortcut, focusPane } from './store/workspaceStore'
import * as api from './tauriAPI'

// Stable workspace ID for this window — from URL param, or 'main' for the initial window.
const wid = new URLSearchParams(window.location.search).get('wid') ?? 'main'

export function App() {
  const { rootPane, restore, setActiveTab } = useWorkspaceStore()
  const [showPrefs, setShowPrefs] = useState(false)
  // Defer rendering terminals until after the startup sequence (kill zombies →
  // load session → restore layout) so no PTY is created before the kill runs.
  const [ready, setReady] = useState(false)
  const cycleShortcutRef = useRef('ctrl+s')
  const cycleWindowShortcutRef = useRef('ctrl+shift+w')

  // Restore a session into this window (used by SessionsPanel).
  const handleRestoreHere = (session: api.WorkspaceSession) => {
    restore(session as Parameters<typeof restore>[0])
    api.setWindowTitle((session as { name: string }).name)
  }

  useEffect(() => {
    const refreshPrefs = () => {
      api.getPrefs().then((prefs) => {
        cycleShortcutRef.current = prefs.cycleShortcut || 'ctrl+s'
        cycleWindowShortcutRef.current = prefs.cycleWindowShortcut || 'ctrl+shift+w'
      })
    }
    refreshPrefs()
    window.addEventListener('prefs-changed', refreshPrefs)

    const onKeyDown = (e: KeyboardEvent) => {
      // Block Cmd/Ctrl+R — prevents accidental WebView page reloads
      if ((e.metaKey || e.ctrlKey) && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        return
      }
      // Cycle windows
      if (matchesShortcut(e, cycleWindowShortcutRef.current)) {
        e.preventDefault()
        api.listOpenWorkspaces().then((wids) => {
          if (wids.length < 2) return
          const sorted = [...wids].sort()
          const currentIdx = sorted.indexOf(wid)
          const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % sorted.length
          api.focusWorkspace(sorted[nextIdx])
        }).catch(() => {})
        return
      }
      // Cycle tabs (Ctrl+T)
      if (e.ctrlKey && e.key === 't') {
        e.preventDefault()
        const { tabs, activeTabId } = useWorkspaceStore.getState()
        if (tabs.length < 2) return
        const currentIdx = tabs.findIndex(t => t.id === activeTabId)
        const nextIdx = (currentIdx + 1) % tabs.length
        setActiveTab(tabs[nextIdx].id)
        return
      }
      // Cycle terminals
      if (matchesShortcut(e, cycleShortcutRef.current)) {
        e.preventDefault()
        const { rootPane, focusedPaneId } = useWorkspaceStore.getState()
        const ids = collectTerminalIds(rootPane)
        if (ids.length < 2) return
        const currentIdx = ids.indexOf(focusedPaneId ?? '')
        const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % ids.length
        focusPane(ids[nextIdx])
      }
    }
    window.addEventListener('keydown', onKeyDown)

    // 1. Kill zombie PTYs + load saved session in parallel (independent operations).
    // 2. Register this window's WID with the backend.
    // 3. Restore session layout if one exists.
    // 4. Only then flip `ready` so TerminalPanes mount and create fresh PTYs.
    Promise.all([api.killAllPtys(), api.loadSession(wid)])
      .then(([, session]) => {
        api.registerWorkspace(wid)
        if (session) {
          restore(session as Parameters<typeof restore>[0])
          api.setWindowTitle(session.name as string)
        }
      })
      .catch((e) => console.error('startup error:', e))
      .finally(() => setReady(true))

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('prefs-changed', refreshPrefs)
    }
  }, [])

  return (
    <div className="app">
      <Toolbar onOpenPrefs={() => setShowPrefs(true)} onRestoreHere={handleRestoreHere} />
      <TabBar />
      <SummaryBar />
      <div className="workspace">
        {ready && <SplitContainer node={rootPane} />}
      </div>
      {showPrefs && <PreferencesModal onClose={() => setShowPrefs(false)} />}
    </div>
  )
}
