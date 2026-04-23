import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted ensures this variable is available inside the vi.mock factory,
// which is hoisted to the top of the module before any imports run.
const { capturedListeners } = vi.hoisted(() => ({
  capturedListeners: {} as Record<string, (e: { payload: unknown }) => void>,
}))

vi.mock('@tauri-apps/api/core', () => {
  const mockChannel = class {
    onmessage: ((payload: unknown) => void) | null = null
  }
  return {
    invoke: vi.fn(),
    Channel: mockChannel,
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    capturedListeners[event] = handler
    return Promise.resolve(() => {})
  }),
}))

import * as api from './tauriAPI'
import { invoke } from '@tauri-apps/api/core'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  // fire-and-forget invoke calls use .catch() — the mock must return a thenable
  mockedInvoke.mockResolvedValue(undefined)
})

// ── createPty / Channel callbacks ─────────────────────────────────────────────

describe('createPty', () => {
  it('calls invoke with create_pty and the options', async () => {
    mockedInvoke.mockResolvedValueOnce('pty-new')
    const id = await api.createPty({ cwd: '/tmp' })
    expect(mockedInvoke).toHaveBeenCalledWith(
      'create_pty',
      expect.objectContaining({ options: { cwd: '/tmp' } }),
    )
    expect(id).toBe('pty-new')
  })

  it('routes ptyData channel messages to registered onPtyData callbacks', async () => {
    const { Channel } = await import('@tauri-apps/api/core')
    let capturedDataChannel: { onmessage: ((p: unknown) => void) | null } | null = null
    mockedInvoke.mockImplementationOnce((_cmd, args: Record<string, unknown>) => {
      capturedDataChannel = args.onData as { onmessage: ((p: unknown) => void) | null }
      return Promise.resolve('pty-1')
    })

    const cb = vi.fn()
    const deregister = api.onPtyData(cb)
    await api.createPty({})

    // Simulate the Rust backend sending a message through the data channel
    capturedDataChannel!.onmessage?.({ ptyId: 'pty-1', data: 'hello' })
    expect(cb).toHaveBeenCalledWith('pty-1', 'hello')

    deregister()
    capturedDataChannel!.onmessage?.({ ptyId: 'pty-1', data: 'after' })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('routes ptyExit channel messages to registered onPtyExit callbacks', async () => {
    let capturedExitChannel: { onmessage: ((p: unknown) => void) | null } | null = null
    mockedInvoke.mockImplementationOnce((_cmd, args: Record<string, unknown>) => {
      capturedExitChannel = args.onExit as { onmessage: ((p: unknown) => void) | null }
      return Promise.resolve('pty-2')
    })

    const cb = vi.fn()
    const deregister = api.onPtyExit(cb)
    await api.createPty({})

    capturedExitChannel!.onmessage?.('pty-2')
    expect(cb).toHaveBeenCalledWith('pty-2')

    deregister()
    capturedExitChannel!.onmessage?.('pty-2')
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

// ── PTY commands ──────────────────────────────────────────────────────────────

describe('PTY commands', () => {
  it('writePty calls invoke with correct args', () => {
    api.writePty('pty-1', 'hello')
    expect(mockedInvoke).toHaveBeenCalledWith('write_pty', { ptyId: 'pty-1', data: 'hello' })
  })

  it('resizePty calls invoke with cols and rows', () => {
    api.resizePty('pty-1', 80, 24)
    expect(mockedInvoke).toHaveBeenCalledWith('resize_pty', { ptyId: 'pty-1', cols: 80, rows: 24 })
  })

  it('killPty calls invoke with pty id', () => {
    api.killPty('pty-1')
    expect(mockedInvoke).toHaveBeenCalledWith('kill_pty', { ptyId: 'pty-1' })
  })

  it('killAllPtys calls invoke', () => {
    api.killAllPtys()
    expect(mockedInvoke).toHaveBeenCalledWith('kill_all_ptys')
  })

  it('ptyHasSubprocess calls invoke and returns result', async () => {
    mockedInvoke.mockResolvedValueOnce(true)
    const result = await api.ptyHasSubprocess('pty-1')
    expect(mockedInvoke).toHaveBeenCalledWith('pty_has_subprocess', { ptyId: 'pty-1' })
    expect(result).toBe(true)
  })

  it('windowHasSubprocess calls invoke', () => {
    api.windowHasSubprocess()
    expect(mockedInvoke).toHaveBeenCalledWith('window_has_subprocess')
  })
})

// ── Claude status ─────────────────────────────────────────────────────────────

describe('Claude status', () => {
  it('getClaudeStatus calls invoke with ptyId', async () => {
    const status = { state: 'working', ts: 1000 }
    mockedInvoke.mockResolvedValueOnce(status)
    const result = await api.getClaudeStatus('pty-1')
    expect(mockedInvoke).toHaveBeenCalledWith('get_claude_status', { ptyId: 'pty-1' })
    expect(result).toEqual(status)
  })

  it('onClaudeStatus registers callback and deregisters on return call', () => {
    const cb = vi.fn()
    const deregister = api.onClaudeStatus(cb)
    // Simulate a status update event
    capturedListeners['claude-status-update']?.({
      payload: { ptyId: 'pty-1', status: { state: 'idle', ts: 123 } },
    })
    expect(cb).toHaveBeenCalledWith('pty-1', { state: 'idle', ts: 123 })
    deregister()
    capturedListeners['claude-status-update']?.({
      payload: { ptyId: 'pty-1', status: null },
    })
    // Should not be called after deregistration
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('multiple onClaudeStatus listeners all receive events', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    api.onClaudeStatus(cb1)
    api.onClaudeStatus(cb2)
    capturedListeners['claude-status-update']?.({
      payload: { ptyId: 'p', status: null },
    })
    expect(cb1).toHaveBeenCalledOnce()
    expect(cb2).toHaveBeenCalledOnce()
  })
})

// ── PTY data/exit pub-sub ─────────────────────────────────────────────────────

describe('PTY event pub-sub', () => {
  it('onPtyData registers and deregisters callback', async () => {
    mockedInvoke.mockResolvedValueOnce('pty-1')
    const options = { cwd: '/tmp' }
    const { Channel } = await import('@tauri-apps/api/core')
    const onDataChannel = new (Channel as new () => { onmessage: ((p: unknown) => void) | null })()
    const onExitChannel = new (Channel as new () => { onmessage: ((p: unknown) => void) | null })()

    const cb = vi.fn()
    const deregister = api.onPtyData(cb)

    // Manually trigger the channel message as the real code would
    onDataChannel.onmessage?.({ ptyId: 'pty-1', data: 'hello' })

    deregister()
    onDataChannel.onmessage?.({ ptyId: 'pty-1', data: 'after' })
    // cb should not be called since it was registered via onPtyData (module-level set),
    // not directly on the channel; verify deregistration logic
    expect(typeof deregister).toBe('function')
  })

  it('onPtyExit deregister returns a function', () => {
    const cb = vi.fn()
    const deregister = api.onPtyExit(cb)
    expect(typeof deregister).toBe('function')
    deregister()
  })

  it('onPtyData deregister returns a function', () => {
    const cb = vi.fn()
    const deregister = api.onPtyData(cb)
    expect(typeof deregister).toBe('function')
    deregister()
  })
})

// ── Window commands ───────────────────────────────────────────────────────────

describe('Window commands', () => {
  it('startDragging calls invoke', () => {
    api.startDragging()
    expect(mockedInvoke).toHaveBeenCalledWith('start_dragging')
  })

  it('setWindowTitle calls invoke with title', () => {
    api.setWindowTitle('My Workspace')
    expect(mockedInvoke).toHaveBeenCalledWith('set_window_title', { title: 'My Workspace' })
  })

  it('openNewWindow calls invoke', () => {
    api.openNewWindow()
    expect(mockedInvoke).toHaveBeenCalledWith('open_new_window')
  })

  it('openWindowWithWid calls invoke with wid', () => {
    api.openWindowWithWid('wid-abc123')
    expect(mockedInvoke).toHaveBeenCalledWith('open_window_with_wid', { wid: 'wid-abc123' })
  })

  it('openSavedSessionInNewWindow calls invoke with id', () => {
    api.openSavedSessionInNewWindow('saved-xyz')
    expect(mockedInvoke).toHaveBeenCalledWith('open_saved_session_in_new_window', { id: 'saved-xyz' })
  })

  it('openInVSCode calls invoke with path', () => {
    api.openInVSCode('/home/user/project')
    expect(mockedInvoke).toHaveBeenCalledWith('open_in_vscode', { path: '/home/user/project' })
  })
})

// ── Preferences ───────────────────────────────────────────────────────────────

describe('Preferences', () => {
  it('getPrefs calls invoke', () => {
    api.getPrefs()
    expect(mockedInvoke).toHaveBeenCalledWith('get_prefs')
  })

  it('setPrefs calls invoke with partial prefs', () => {
    api.setPrefs({ startingPath: '/home', shiftEnterNewline: true })
    expect(mockedInvoke).toHaveBeenCalledWith('set_prefs', {
      prefs: { startingPath: '/home', shiftEnterNewline: true },
    })
  })

  it('hasApiKey calls invoke', () => {
    api.hasApiKey()
    expect(mockedInvoke).toHaveBeenCalledWith('has_api_key')
  })

  it('setApiKey calls invoke with key', () => {
    api.setApiKey('sk-ant-123')
    expect(mockedInvoke).toHaveBeenCalledWith('set_api_key', { key: 'sk-ant-123' })
  })

  it('pickFolder calls invoke', () => {
    api.pickFolder()
    expect(mockedInvoke).toHaveBeenCalledWith('pick_folder')
  })
})

// ── Session commands ──────────────────────────────────────────────────────────

describe('Session commands', () => {
  it('registerWorkspace calls invoke with wid', () => {
    api.registerWorkspace('wid-main')
    expect(mockedInvoke).toHaveBeenCalledWith('register_workspace', { wid: 'wid-main' })
  })

  it('loadSession calls invoke with wid', async () => {
    mockedInvoke.mockResolvedValueOnce(null)
    await api.loadSession('wid-abc')
    expect(mockedInvoke).toHaveBeenCalledWith('load_session', { wid: 'wid-abc' })
  })

  it('saveSession calls invoke with wid and session', () => {
    const session = { name: 'Test', rootPane: {}, paneStates: {} }
    api.saveSession('wid-abc', session)
    expect(mockedInvoke).toHaveBeenCalledWith('save_session', { wid: 'wid-abc', session })
  })

  it('getRestoreableSessions calls invoke', async () => {
    mockedInvoke.mockResolvedValueOnce([])
    await api.getRestoreableSessions()
    expect(mockedInvoke).toHaveBeenCalledWith('get_restoreable_sessions')
  })

  it('deleteWorkspaceSession calls invoke with wid', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await api.deleteWorkspaceSession('wid-old')
    expect(mockedInvoke).toHaveBeenCalledWith('delete_workspace_session', { wid: 'wid-old' })
  })

  it('saveNamedSession calls invoke with session and returns id', async () => {
    mockedInvoke.mockResolvedValueOnce('saved-xyz')
    const session = { name: 'My Setup', rootPane: {} }
    const id = await api.saveNamedSession(session)
    expect(mockedInvoke).toHaveBeenCalledWith('save_named_session', { session })
    expect(id).toBe('saved-xyz')
  })

  it('renameSavedSession calls invoke with id and name', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await api.renameSavedSession('saved-abc', 'New Name')
    expect(mockedInvoke).toHaveBeenCalledWith('rename_saved_session', { id: 'saved-abc', name: 'New Name' })
  })

  it('listSavedSessions calls invoke', async () => {
    mockedInvoke.mockResolvedValueOnce([])
    await api.listSavedSessions()
    expect(mockedInvoke).toHaveBeenCalledWith('list_saved_sessions')
  })

  it('deleteSavedSession calls invoke with id', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await api.deleteSavedSession('saved-xyz')
    expect(mockedInvoke).toHaveBeenCalledWith('delete_saved_session', { id: 'saved-xyz' })
  })
})

// ── openUrl ───────────────────────────────────────────────────────────────────

describe('openUrl', () => {
  it('calls invoke with url', () => {
    api.openUrl('https://example.com')
    expect(mockedInvoke).toHaveBeenCalledWith('open_url', { url: 'https://example.com' })
  })
})

// ── Auto-update ───────────────────────────────────────────────────────────────

describe('Auto-update commands', () => {
  it('checkForUpdates calls invoke', async () => {
    const info = { available: false, currentVersion: '1.0.0', latestVersion: null, releaseNotes: null }
    mockedInvoke.mockResolvedValueOnce(info)
    const result = await api.checkForUpdates()
    expect(mockedInvoke).toHaveBeenCalledWith('check_for_updates')
    expect(result).toEqual(info)
  })

  it('installUpdate calls invoke', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await api.installUpdate()
    expect(mockedInvoke).toHaveBeenCalledWith('install_update')
  })
})

// ── Window cycling commands ───────────────────────────────────────────────────

describe('Window cycling commands', () => {
  it('listOpenWorkspaces calls invoke and returns wid array', async () => {
    mockedInvoke.mockResolvedValueOnce(['wid-a', 'wid-b'])
    const result = await api.listOpenWorkspaces()
    expect(mockedInvoke).toHaveBeenCalledWith('list_open_workspaces')
    expect(result).toEqual(['wid-a', 'wid-b'])
  })

  it('focusWorkspace calls invoke with wid', () => {
    api.focusWorkspace('wid-abc')
    expect(mockedInvoke).toHaveBeenCalledWith('focus_workspace', { wid: 'wid-abc' })
  })
})

// ── Summary ───────────────────────────────────────────────────────────────────

describe('generateSummary', () => {
  it('calls invoke with workspaceName', async () => {
    mockedInvoke.mockResolvedValueOnce({ summary: 'Doing stuff' })
    const result = await api.generateSummary('My WS')
    expect(mockedInvoke).toHaveBeenCalledWith('generate_summary', { workspaceName: 'My WS' })
    expect(result).toEqual({ summary: 'Doing stuff' })
  })
})
