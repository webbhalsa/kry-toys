/** tauriAPI — Tauri IPC bindings for the lmwrnglr frontend. */

import { invoke, Channel } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type ClaudeStatus = {
  state: 'working' | 'idle'
  cwd?: string
  cwdDisplay?: string
  branch?: string | null
  tool?: string
  activity?: string | null
  sessionId?: string | null
  ts: number
}

export type SummaryResult =
  | { summary: string; error?: never }
  | { error: string; summary?: never }

export type Prefs = {
  startingPath: string
  apiKeyFromEnv: boolean
  hasApiKey: boolean
  shiftEnterNewline: boolean
  cycleShortcut: string
  cycleWindowShortcut: string
}

export type WorkspaceSession = {
  name: string
  rootPane: unknown
  accentColor?: string
  paneStates?: Record<string, { cwd: string; hadClaude: boolean; claudeSessionId?: string }>
}

export type RestoreableSession = {
  wid: string
  session: WorkspaceSession
}

export type SavedSession = {
  id: string
  session: WorkspaceSession
}

// ── PTY ───────────────────────────────────────────────────────────────────────

export const createPty = (options: { shell?: string; cwd?: string }): Promise<string> => {
  // Use Tauri v2 Channels for reliable streaming from background threads.
  // Global app_handle.emit() can fail silently from non-async Rust threads;
  // Channel.send() is a direct callback and works from any thread.
  const onData = new Channel<PtyDataPayload>()
  onData.onmessage = (p) => _ptyDataCbs.forEach((cb) => cb(p.ptyId, p.data))
  const onExit = new Channel<string>()
  onExit.onmessage = (ptyId) => _ptyExitCbs.forEach((cb) => cb(ptyId))
  return invoke('create_pty', { options, onData, onExit })
}

export const writePty = (ptyId: string, data: string): void => {
  invoke('write_pty', { ptyId, data }).catch(() => {})
}

export const resizePty = (ptyId: string, cols: number, rows: number): void => {
  invoke('resize_pty', { ptyId, cols, rows }).catch(() => {})
}

export const killPty = (ptyId: string): void => {
  invoke('kill_pty', { ptyId }).catch(() => {})
}

export const killAllPtys = (): Promise<void> =>
  invoke('kill_all_ptys')

export const ptyHasSubprocess = (ptyId: string): Promise<boolean> =>
  invoke('pty_has_subprocess', { ptyId })

export const windowHasSubprocess = (): Promise<boolean> =>
  invoke('window_has_subprocess')

// ── PTY events ────────────────────────────────────────────────────────────────
//
// PTY data and exit are delivered via Tauri v2 Channels (created in createPty),
// not via the global event bus — Channel.send() is reliable from any Rust thread.
// Claude status updates still use listen() since they come from a file watcher
// that uses app_handle.emit() (no per-PTY channel available there).

type PtyDataPayload = { ptyId: string; data: string }
type ClaudeStatusPayload = { ptyId: string; status: ClaudeStatus | null }

const _ptyDataCbs = new Set<(ptyId: string, data: string) => void>()
const _ptyExitCbs = new Set<(ptyId: string) => void>()
const _claudeStatusCbs = new Set<(ptyId: string, status: ClaudeStatus | null) => void>()

listen<ClaudeStatusPayload>('claude-status-update', (e) =>
  _claudeStatusCbs.forEach((cb) => cb(e.payload.ptyId, e.payload.status))
)

export const onPtyData = (
  callback: (ptyId: string, data: string) => void
): (() => void) => {
  _ptyDataCbs.add(callback)
  return () => _ptyDataCbs.delete(callback)
}

export const onPtyExit = (
  callback: (ptyId: string) => void
): (() => void) => {
  _ptyExitCbs.add(callback)
  return () => _ptyExitCbs.delete(callback)
}

// ── Claude Code status ────────────────────────────────────────────────────────

export const getClaudeStatus = (ptyId: string): Promise<ClaudeStatus | null> =>
  invoke('get_claude_status', { ptyId })

export const onClaudeStatus = (
  callback: (ptyId: string, status: ClaudeStatus | null) => void
): (() => void) => {
  _claudeStatusCbs.add(callback)
  return () => _claudeStatusCbs.delete(callback)
}

// ── Window ────────────────────────────────────────────────────────────────────

export const startDragging = (): void => {
  invoke('start_dragging').catch(() => {})
}

export const toggleMaximize = (): void => {
  invoke('toggle_maximize').catch(() => {})
}

export const setWindowTitle = (title: string): void => {
  invoke('set_window_title', { title }).catch(() => {})
}

export const openNewWindow = (): void => {
  invoke('open_new_window').catch(() => {})
}

export const openWindowWithWid = (wid: string): void => {
  invoke('open_window_with_wid', { wid }).catch(() => {})
}

export const openSavedSessionInNewWindow = (id: string): void => {
  invoke('open_saved_session_in_new_window', { id }).catch(() => {})
}

/** Returns all WIDs that currently have an open window. */
export const listOpenWorkspaces = (): Promise<string[]> =>
  invoke('list_open_workspaces')

/** Focus the window that owns the given WID. */
export const focusWorkspace = (wid: string): void => {
  invoke('focus_workspace', { wid }).catch(() => {})
}

export const openUrl = (url: string): void => {
  invoke('open_url', { url }).catch(() => {})
}

export const openInVSCode = (path: string): void => {
  invoke('open_in_vscode', { path }).catch(() => {})
}

// ── Config / Preferences ──────────────────────────────────────────────────────

export const getPrefs = (): Promise<Prefs> => invoke('get_prefs')

export const setPrefs = (prefs: {
  startingPath?: string
  apiKey?: string
  shiftEnterNewline?: boolean
  cycleShortcut?: string
  cycleWindowShortcut?: string
}): Promise<void> => invoke('set_prefs', { prefs })

export const hasApiKey = (): Promise<boolean> => invoke('has_api_key')

export const setApiKey = (key: string): Promise<void> =>
  invoke('set_api_key', { key })

export const pickFolder = (): Promise<string | null> => invoke('pick_folder')

// ── Session ───────────────────────────────────────────────────────────────────

/** Tell the backend this window owns the given WID (must be called on startup). */
export const registerWorkspace = (wid: string): void => {
  invoke('register_workspace', { wid }).catch(() => {})
}

export const loadSession = (wid: string): Promise<WorkspaceSession | null> =>
  invoke('load_session', { wid })

export const saveSession = (wid: string, session: WorkspaceSession): void => {
  invoke('save_session', { wid, session }).catch(() => {})
}

/** Returns workspace sessions that are not currently open in any window. */
export const getRestoreableSessions = (): Promise<RestoreableSession[]> =>
  invoke('get_restoreable_sessions')

/** Returns workspace sessions for all currently open windows. */
export const getOpenSessions = (): Promise<RestoreableSession[]> =>
  invoke('get_open_sessions')

/** Delete an auto-saved workspace session. */
export const deleteWorkspaceSession = (wid: string): Promise<void> =>
  invoke('delete_workspace_session', { wid })

/** Save the current workspace as a named session. Returns the new session ID. */
export const saveNamedSession = (session: WorkspaceSession): Promise<string> =>
  invoke('save_named_session', { session })

/** Rename a named saved session. */
export const renameSavedSession = (id: string, name: string): Promise<void> =>
  invoke('rename_saved_session', { id, name })

/** Returns all named saved sessions. */
export const listSavedSessions = (): Promise<SavedSession[]> =>
  invoke('list_saved_sessions')

/** Delete a named saved session permanently. */
export const deleteSavedSession = (id: string): Promise<void> =>
  invoke('delete_saved_session', { id })

// ── Auto-update ───────────────────────────────────────────────────────────────

export type UpdateInfo = {
  available: boolean
  currentVersion: string
  latestVersion: string | null
  releaseNotes: string | null
}

export const checkForUpdates = (): Promise<UpdateInfo> =>
  invoke('check_for_updates')

export const installUpdate = (): Promise<void> =>
  invoke('install_update')

// ── Summary ───────────────────────────────────────────────────────────────────

export const generateSummary = (workspaceName: string): Promise<SummaryResult> =>
  invoke('generate_summary', { workspaceName })
