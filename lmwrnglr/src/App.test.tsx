import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))

// Mock all child components so App renders without deep dependencies.
// Toolbar exposes both onOpenPrefs and onRestoreHere for full coverage.
vi.mock('./components/Toolbar', () => ({
  Toolbar: ({
    onOpenPrefs,
    onRestoreHere,
  }: {
    onOpenPrefs: () => void
    onRestoreHere: (session: unknown) => void
  }) => (
    <>
      <button data-testid="toolbar-prefs" onClick={onOpenPrefs}>Prefs</button>
      <button
        data-testid="toolbar-restore"
        onClick={() => onRestoreHere({ name: 'Restored', rootPane: {}, paneStates: {} })}
      >
        Restore
      </button>
    </>
  ),
}))
vi.mock('./components/TabBar', () => ({
  TabBar: () => <div data-testid="tab-bar" />,
}))
vi.mock('./components/SplitContainer', () => ({
  SplitContainer: () => <div data-testid="split-container" />,
}))
vi.mock('./components/SummaryBar', () => ({
  SummaryBar: () => <div data-testid="summary-bar" />,
}))
vi.mock('./components/PreferencesModal', () => ({
  PreferencesModal: ({ onClose }: { onClose: () => void }) => (
    <button data-testid="prefs-modal-close" onClick={onClose}>Close</button>
  ),
}))

vi.mock('./tauriAPI', () => ({
  getPrefs: vi.fn(),
  killAllPtys: vi.fn(),
  loadSession: vi.fn(),
  registerWorkspace: vi.fn(),
  setWindowTitle: vi.fn(),
  listOpenWorkspaces: vi.fn(),
  focusWorkspace: vi.fn(),
}))

// The workspaceStore mock is shared but we need to be able to swap state
// per-test. Use mutable refs so beforeEach can reset them.
let _mockRootPane: unknown = { type: 'terminal', id: 'root-1', number: 1 }
const _mockRestore = vi.fn()
const _mockSetActiveTab = vi.fn()
let _mockTabs: unknown[] = [{ id: 'tab-1', name: 'Tab 1' }]
let _mockActiveTabId = 'tab-1'
const _mockFocusedPaneId: string | null = null

vi.mock('./store/workspaceStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store/workspaceStore')>()
  return {
    ...actual,
    focusPane: vi.fn(),
    useWorkspaceStore: Object.assign(
      (selector: (s: unknown) => unknown) => {
        const state = {
          rootPane: _mockRootPane,
          restore: _mockRestore,
          setActiveTab: _mockSetActiveTab,
          tabs: _mockTabs,
          activeTabId: _mockActiveTabId,
        }
        return selector ? selector(state) : state
      },
      {
        getState: vi.fn(() => ({
          rootPane: _mockRootPane,
          focusedPaneId: _mockFocusedPaneId,
          tabs: _mockTabs,
          activeTabId: _mockActiveTabId,
        })),
        subscribe: vi.fn(() => () => {}),
        setState: vi.fn(),
      }
    ),
  }
})

import * as api from './tauriAPI'
import { App } from './App'

const mockedApi = vi.mocked(api)

beforeEach(() => {
  vi.clearAllMocks()
  _mockRootPane = { type: 'terminal', id: 'root-1', number: 1 }
  _mockTabs = [{ id: 'tab-1', name: 'Tab 1' }]
  _mockActiveTabId = 'tab-1'
  mockedApi.getPrefs.mockResolvedValue({
    startingPath: '/home/user',
    apiKeyFromEnv: false,
    hasApiKey: false,
    shiftEnterNewline: false,
    cycleShortcut: 'ctrl+s',
    cycleWindowShortcut: 'ctrl+shift+w',
  })
  mockedApi.killAllPtys.mockResolvedValue(undefined)
  mockedApi.loadSession.mockResolvedValue(null)
  mockedApi.listOpenWorkspaces.mockResolvedValue([])
})

// ── Mount / startup sequence ──────────────────────────────────────────────────

describe('App startup', () => {
  it('renders without crashing', async () => {
    const { getByTestId } = render(<App />)
    await waitFor(() => expect(mockedApi.killAllPtys).toHaveBeenCalled())
    expect(getByTestId('summary-bar')).toBeInTheDocument()
  })

  it('renders the tab bar', async () => {
    const { getByTestId } = render(<App />)
    await waitFor(() => expect(mockedApi.killAllPtys).toHaveBeenCalled())
    expect(getByTestId('tab-bar')).toBeInTheDocument()
  })

  it('calls killAllPtys and loadSession on mount', async () => {
    render(<App />)
    await waitFor(() => expect(mockedApi.killAllPtys).toHaveBeenCalled())
    expect(mockedApi.loadSession).toHaveBeenCalled()
  })

  it('calls registerWorkspace after kill+load', async () => {
    render(<App />)
    await waitFor(() => expect(mockedApi.registerWorkspace).toHaveBeenCalled())
  })

  it('restores session and sets window title when loadSession returns data', async () => {
    const session = { name: 'My WS', rootPane: {}, paneStates: {} }
    mockedApi.loadSession.mockResolvedValueOnce(session)
    render(<App />)
    await waitFor(() => expect(mockedApi.setWindowTitle).toHaveBeenCalledWith('My WS'))
    expect(_mockRestore).toHaveBeenCalledWith(expect.objectContaining({ name: 'My WS' }))
  })

  it('calls getPrefs on mount', async () => {
    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())
  })

  it('shows SplitContainer once ready', async () => {
    const { getByTestId } = render(<App />)
    await waitFor(() => expect(mockedApi.registerWorkspace).toHaveBeenCalled())
    await waitFor(() => expect(getByTestId('split-container')).toBeInTheDocument())
  })
})

// ── handleRestoreHere ─────────────────────────────────────────────────────────

describe('handleRestoreHere', () => {
  it('calls restore and setWindowTitle when session is restored via toolbar', async () => {
    const { getByTestId } = render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())
    fireEvent.click(getByTestId('toolbar-restore'))
    expect(_mockRestore).toHaveBeenCalledWith(expect.objectContaining({ name: 'Restored' }))
    expect(mockedApi.setWindowTitle).toHaveBeenCalledWith('Restored')
  })
})

// ── Keyboard handler: Ctrl+R block ────────────────────────────────────────────

describe('keyboard: block Ctrl+R', () => {
  it('prevents default on Ctrl+R', async () => {
    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())
    const event = new KeyboardEvent('keydown', {
      key: 'r',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => { window.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
  })

  it('prevents default on Cmd+R', async () => {
    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())
    const event = new KeyboardEvent('keydown', {
      key: 'R',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => { window.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
  })
})

// ── Keyboard handler: Ctrl+W cycle windows ────────────────────────────────────

describe('keyboard: Ctrl+Shift+W cycle windows', () => {
  it('is a no-op when only one window is open', async () => {
    mockedApi.listOpenWorkspaces.mockResolvedValue(['main'])
    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    const event = new KeyboardEvent('keydown', {
      key: 'w',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => { window.dispatchEvent(event) })
    await waitFor(() => expect(mockedApi.listOpenWorkspaces).toHaveBeenCalled())
    expect(mockedApi.focusWorkspace).not.toHaveBeenCalled()
  })

  it('cycles to the next window when multiple are open', async () => {
    // wid is 'main' (from URL in jsdom with no query param)
    mockedApi.listOpenWorkspaces.mockResolvedValue(['wid-zzz', 'main', 'wid-aaa'])
    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    const event = new KeyboardEvent('keydown', {
      key: 'w',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => { window.dispatchEvent(event) })
    await waitFor(() => expect(mockedApi.listOpenWorkspaces).toHaveBeenCalled())
    // sorted: ['main', 'wid-aaa', 'wid-zzz'] — current is 'main' at index 0, next is 'wid-aaa'
    await waitFor(() => expect(mockedApi.focusWorkspace).toHaveBeenCalledWith('wid-aaa'))
  })

  it('wraps around from last to first in sort order', async () => {
    // sorted: ['main', 'wid-zzz'] — 'main' is index 0, next is 'wid-zzz'
    mockedApi.listOpenWorkspaces.mockResolvedValue(['wid-zzz', 'main'])
    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    const event = new KeyboardEvent('keydown', {
      key: 'w',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => { window.dispatchEvent(event) })
    await waitFor(() => expect(mockedApi.listOpenWorkspaces).toHaveBeenCalled())
    await waitFor(() => expect(mockedApi.focusWorkspace).toHaveBeenCalledWith('wid-zzz'))
  })

  it('wraps from last back to first', async () => {
    // Put 'main' last in sorted order: ['aaa', 'bbb', 'main']
    mockedApi.listOpenWorkspaces.mockResolvedValue(['aaa', 'main', 'bbb'])
    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    // sorted: ['aaa', 'bbb', 'main'] — current 'main' at index 2 (last), next wraps to index 0 = 'aaa'
    const event = new KeyboardEvent('keydown', {
      key: 'w',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => { window.dispatchEvent(event) })
    await waitFor(() => expect(mockedApi.listOpenWorkspaces).toHaveBeenCalled())
    await waitFor(() => expect(mockedApi.focusWorkspace).toHaveBeenCalledWith('aaa'))
  })

  it('focuses first window when current wid is not in the list', async () => {
    mockedApi.listOpenWorkspaces.mockResolvedValue(['wid-aaa', 'wid-bbb'])
    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    const event = new KeyboardEvent('keydown', {
      key: 'w',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => { window.dispatchEvent(event) })
    await waitFor(() => expect(mockedApi.listOpenWorkspaces).toHaveBeenCalled())
    // currentIdx === -1 → nextIdx = 0 → sorted[0] = 'wid-aaa'
    await waitFor(() => expect(mockedApi.focusWorkspace).toHaveBeenCalledWith('wid-aaa'))
  })

  it('prevents default on Ctrl+Shift+W', async () => {
    mockedApi.listOpenWorkspaces.mockResolvedValue(['main'])
    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    const event = new KeyboardEvent('keydown', {
      key: 'w',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => { window.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
  })

  it('handles listOpenWorkspaces rejection gracefully', async () => {
    mockedApi.listOpenWorkspaces.mockRejectedValue(new Error('IPC error'))
    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    const event = new KeyboardEvent('keydown', {
      key: 'w',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    // Should not throw
    expect(() => act(() => { window.dispatchEvent(event) })).not.toThrow()
    await waitFor(() => expect(mockedApi.listOpenWorkspaces).toHaveBeenCalled())
  })
})

// ── Keyboard handler: Ctrl+T cycle tabs ───────────────────────────────────────

describe('keyboard: Ctrl+T cycle tabs', () => {
  it('is a no-op when only one tab exists', async () => {
    _mockTabs = [{ id: 'tab-1', name: 'Tab 1' }]
    _mockActiveTabId = 'tab-1'
    const { useWorkspaceStore } = await import('./store/workspaceStore')
    vi.mocked(useWorkspaceStore.getState).mockReturnValue({
      rootPane: _mockRootPane,
      focusedPaneId: _mockFocusedPaneId,
      tabs: _mockTabs,
      activeTabId: _mockActiveTabId,
    } as ReturnType<typeof useWorkspaceStore.getState>)

    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    const event = new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => { window.dispatchEvent(event) })
    expect(_mockSetActiveTab).not.toHaveBeenCalled()
  })

  it('cycles to the next tab when multiple tabs exist', async () => {
    const tabs = [
      { id: 'tab-1', name: 'Tab 1' },
      { id: 'tab-2', name: 'Tab 2' },
      { id: 'tab-3', name: 'Tab 3' },
    ]
    _mockTabs = tabs
    _mockActiveTabId = 'tab-1'
    const { useWorkspaceStore } = await import('./store/workspaceStore')
    vi.mocked(useWorkspaceStore.getState).mockReturnValue({
      rootPane: _mockRootPane,
      focusedPaneId: _mockFocusedPaneId,
      tabs,
      activeTabId: 'tab-1',
    } as ReturnType<typeof useWorkspaceStore.getState>)

    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    const event = new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => { window.dispatchEvent(event) })
    expect(_mockSetActiveTab).toHaveBeenCalledWith('tab-2')
  })

  it('wraps from last tab back to first', async () => {
    const tabs = [
      { id: 'tab-1', name: 'Tab 1' },
      { id: 'tab-2', name: 'Tab 2' },
    ]
    _mockTabs = tabs
    _mockActiveTabId = 'tab-2'
    const { useWorkspaceStore } = await import('./store/workspaceStore')
    vi.mocked(useWorkspaceStore.getState).mockReturnValue({
      rootPane: _mockRootPane,
      focusedPaneId: _mockFocusedPaneId,
      tabs,
      activeTabId: 'tab-2',
    } as ReturnType<typeof useWorkspaceStore.getState>)

    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    const event = new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => { window.dispatchEvent(event) })
    expect(_mockSetActiveTab).toHaveBeenCalledWith('tab-1')
  })

  it('prevents default on Ctrl+T', async () => {
    _mockTabs = [{ id: 'tab-1', name: 'Tab 1' }, { id: 'tab-2', name: 'Tab 2' }]
    _mockActiveTabId = 'tab-1'
    const { useWorkspaceStore } = await import('./store/workspaceStore')
    vi.mocked(useWorkspaceStore.getState).mockReturnValue({
      rootPane: _mockRootPane,
      focusedPaneId: _mockFocusedPaneId,
      tabs: _mockTabs,
      activeTabId: 'tab-1',
    } as ReturnType<typeof useWorkspaceStore.getState>)

    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    const event = new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true, cancelable: true })
    act(() => { window.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
  })
})

// ── Keyboard handler: cycle terminals ────────────────────────────────────────

describe('keyboard: cycle terminals', () => {
  it('does nothing when only one terminal exists', async () => {
    // _mockRootPane is a single terminal — ids.length < 2 → early return
    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())
    const event = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => { window.dispatchEvent(event) })
    // No crash; focusWorkspace (windows) not called
    expect(mockedApi.focusWorkspace).not.toHaveBeenCalled()
  })

  it('does not crash when pressing a key that does not match any shortcut', async () => {
    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())
    const event = new KeyboardEvent('keydown', {
      key: 'x',
      bubbles: true,
      cancelable: true,
    })
    // Should not throw; no shortcut is triggered
    expect(() => act(() => { window.dispatchEvent(event) })).not.toThrow()
    expect(event.defaultPrevented).toBe(false)
  })

  it('cycles to the next terminal when multiple exist (focusedPaneId in list)', async () => {
    _mockRootPane = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      children: [
        { type: 'terminal', id: 'term-a', number: 1 },
        { type: 'terminal', id: 'term-b', number: 2 },
      ],
    }
    const { useWorkspaceStore } = await import('./store/workspaceStore')
    vi.mocked(useWorkspaceStore.getState).mockReturnValue({
      rootPane: _mockRootPane as Parameters<typeof useWorkspaceStore.getState>[0],
      focusedPaneId: 'term-a',
      tabs: _mockTabs,
      activeTabId: _mockActiveTabId,
    } as ReturnType<typeof useWorkspaceStore.getState>)

    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    const { focusPane } = await import('./store/workspaceStore')
    const event = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => { window.dispatchEvent(event) })
    expect(focusPane).toHaveBeenCalledWith('term-b')
  })

  it('cycles to first terminal when focusedPaneId is not in the list', async () => {
    _mockRootPane = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      children: [
        { type: 'terminal', id: 'term-a', number: 1 },
        { type: 'terminal', id: 'term-b', number: 2 },
      ],
    }
    const { useWorkspaceStore } = await import('./store/workspaceStore')
    vi.mocked(useWorkspaceStore.getState).mockReturnValue({
      rootPane: _mockRootPane as Parameters<typeof useWorkspaceStore.getState>[0],
      focusedPaneId: null,
      tabs: _mockTabs,
      activeTabId: _mockActiveTabId,
    } as ReturnType<typeof useWorkspaceStore.getState>)

    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    const { focusPane } = await import('./store/workspaceStore')
    const event = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => { window.dispatchEvent(event) })
    expect(focusPane).toHaveBeenCalledWith('term-a')
  })

  it('uses fallback ctrl+s shortcut when cycleShortcut is empty', async () => {
    mockedApi.getPrefs.mockResolvedValueOnce({
      startingPath: '/home/user',
      apiKeyFromEnv: false,
      hasApiKey: false,
      shiftEnterNewline: false,
      cycleShortcut: '',
      cycleWindowShortcut: 'ctrl+shift+w',
    })
    _mockRootPane = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      children: [
        { type: 'terminal', id: 'term-a', number: 1 },
        { type: 'terminal', id: 'term-b', number: 2 },
      ],
    }
    const { useWorkspaceStore } = await import('./store/workspaceStore')
    vi.mocked(useWorkspaceStore.getState).mockReturnValue({
      rootPane: _mockRootPane as Parameters<typeof useWorkspaceStore.getState>[0],
      focusedPaneId: 'term-a',
      tabs: _mockTabs,
      activeTabId: _mockActiveTabId,
    } as ReturnType<typeof useWorkspaceStore.getState>)

    render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())

    const { focusPane } = await import('./store/workspaceStore')
    const event = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => { window.dispatchEvent(event) })
    expect(focusPane).toHaveBeenCalledWith('term-b')
  })
})

// ── Startup error handling ────────────────────────────────────────────────────

describe('startup error handling', () => {
  it('logs error and still flips ready when startup fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockedApi.killAllPtys.mockRejectedValueOnce(new Error('pty error'))
    const { getByTestId } = render(<App />)
    await waitFor(() => expect(getByTestId('split-container')).toBeInTheDocument())
    consoleSpy.mockRestore()
  })
})

// ── Preferences modal ─────────────────────────────────────────────────────────

describe('preferences modal', () => {
  it('opens PreferencesModal when toolbar prefs button is clicked', async () => {
    const { getByTestId } = render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())
    fireEvent.click(getByTestId('toolbar-prefs'))
    await waitFor(() => expect(getByTestId('prefs-modal-close')).toBeInTheDocument())
  })

  it('closes PreferencesModal when onClose is called', async () => {
    const { getByTestId, queryByTestId } = render(<App />)
    await waitFor(() => expect(mockedApi.getPrefs).toHaveBeenCalled())
    fireEvent.click(getByTestId('toolbar-prefs'))
    await waitFor(() => expect(getByTestId('prefs-modal-close')).toBeInTheDocument())
    fireEvent.click(getByTestId('prefs-modal-close'))
    await waitFor(() => expect(queryByTestId('prefs-modal-close')).not.toBeInTheDocument())
  })
})
