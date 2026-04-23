import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))

const mockWorkspaceState = {
  name: 'Test Workspace',
  rootPane: { type: 'terminal', id: 'p1', number: 1 },
  accentColor: undefined as string | undefined,
  paneStates: {} as Record<string, { cwd: string; hadClaude: boolean }>,
}

vi.mock('../store/workspaceStore', () => ({
  useWorkspaceStore: vi.fn((selector?: (s: typeof mockWorkspaceState) => unknown) =>
    selector ? selector(mockWorkspaceState) : mockWorkspaceState
  ),
}))

vi.mock('../tauriAPI', () => ({
  getRestoreableSessions: vi.fn(),
  listSavedSessions: vi.fn(),
  deleteWorkspaceSession: vi.fn(),
  deleteSavedSession: vi.fn(),
  saveNamedSession: vi.fn(),
  renameSavedSession: vi.fn(),
  openWindowWithWid: vi.fn(),
  openSavedSessionInNewWindow: vi.fn(),
}))

import * as api from '../tauriAPI'
import { SessionsPanel } from './SessionsPanel'

// ── Helpers ───────────────────────────────────────────────────────────────────

const restoreableSession = (wid: string, name: string) => ({
  wid,
  session: { name, rootPane: {}, accentColor: undefined, paneStates: {} },
})

const savedSession = (id: string, name: string) => ({
  id,
  session: { name, rootPane: {}, accentColor: undefined, paneStates: {} },
})

const onClose = vi.fn()
const onRestoreHere = vi.fn()

function renderPanel() {
  return render(<SessionsPanel onClose={onClose} onRestoreHere={onRestoreHere} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getRestoreableSessions).mockResolvedValue([])
  vi.mocked(api.listSavedSessions).mockResolvedValue([])
  vi.mocked(api.deleteWorkspaceSession).mockResolvedValue(undefined)
  vi.mocked(api.deleteSavedSession).mockResolvedValue(undefined)
  vi.mocked(api.saveNamedSession).mockResolvedValue('saved-new')
  vi.mocked(api.renameSavedSession).mockResolvedValue(undefined)
})

// ── Loading state ─────────────────────────────────────────────────────────────

describe('loading state', () => {
  it('shows "Loading…" while fetching', () => {
    // Never-resolving promises so loading stays visible
    vi.mocked(api.getRestoreableSessions).mockReturnValue(new Promise(() => {}))
    vi.mocked(api.listSavedSessions).mockReturnValue(new Promise(() => {}))
    renderPanel()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })
})

// ── Empty state ───────────────────────────────────────────────────────────────

describe('empty state', () => {
  it('shows empty message when there are no sessions', async () => {
    renderPanel()
    await waitFor(() => {
      expect(screen.getByText('No saved sessions yet.')).toBeInTheDocument()
    })
  })

  it('does not show section headings when both lists are empty', async () => {
    renderPanel()
    await waitFor(() => screen.getByText('No saved sessions yet.'))
    expect(screen.queryByText('Recent Workspaces')).not.toBeInTheDocument()
    expect(screen.queryByText('Saved Sessions')).not.toBeInTheDocument()
  })
})

// ── Recent Workspaces section ─────────────────────────────────────────────────

describe('Recent Workspaces', () => {
  it('renders restoreable sessions', async () => {
    vi.mocked(api.getRestoreableSessions).mockResolvedValue([
      restoreableSession('wid-1', 'Backend'),
      restoreableSession('wid-2', 'Frontend'),
    ])
    renderPanel()
    await waitFor(() => {
      expect(screen.getByText('Backend')).toBeInTheDocument()
      expect(screen.getByText('Frontend')).toBeInTheDocument()
    })
    expect(screen.getByText('Recent Workspaces')).toBeInTheDocument()
  })

  it('shows Replace and Open buttons for each session', async () => {
    vi.mocked(api.getRestoreableSessions).mockResolvedValue([
      restoreableSession('wid-1', 'My WS'),
    ])
    renderPanel()
    await waitFor(() => screen.getByText('My WS'))
    const row = screen.getByText('My WS').closest('.session-row')!
    expect(within(row).getByText('Replace')).toBeInTheDocument()
    expect(within(row).getByText('Open')).toBeInTheDocument()
    expect(within(row).getByText('✕')).toBeInTheDocument()
  })

  it('delete removes session from the list', async () => {
    vi.mocked(api.getRestoreableSessions).mockResolvedValue([
      restoreableSession('wid-del', 'To Delete'),
    ])
    renderPanel()
    await waitFor(() => screen.getByText('To Delete'))
    const row = screen.getByText('To Delete').closest('.session-row')!
    await userEvent.click(within(row).getByText('✕'))
    expect(api.deleteWorkspaceSession).toHaveBeenCalledWith('wid-del')
    await waitFor(() => {
      expect(screen.queryByText('To Delete')).not.toBeInTheDocument()
    })
  })

  it('"Replace" calls onRestoreHere, deletes workspace session, and closes panel', async () => {
    const session = restoreableSession('wid-r', 'Replace Me')
    vi.mocked(api.getRestoreableSessions).mockResolvedValue([session])
    renderPanel()
    await waitFor(() => screen.getByText('Replace Me'))
    const row = screen.getByText('Replace Me').closest('.session-row')!
    await userEvent.click(within(row).getByText('Replace'))
    expect(onRestoreHere).toHaveBeenCalledWith(session.session)
    expect(api.deleteWorkspaceSession).toHaveBeenCalledWith('wid-r')
    expect(onClose).toHaveBeenCalled()
  })

  it('"Open" calls openWindowWithWid and closes panel', async () => {
    vi.mocked(api.getRestoreableSessions).mockResolvedValue([
      restoreableSession('wid-open', 'Open Me'),
    ])
    renderPanel()
    await waitFor(() => screen.getByText('Open Me'))
    const row = screen.getByText('Open Me').closest('.session-row')!
    await userEvent.click(within(row).getByText('Open'))
    expect(api.openWindowWithWid).toHaveBeenCalledWith('wid-open')
    expect(onClose).toHaveBeenCalled()
  })
})

// ── Saved Sessions section ────────────────────────────────────────────────────

describe('Saved Sessions', () => {
  it('renders saved sessions with a star prefix', async () => {
    vi.mocked(api.listSavedSessions).mockResolvedValue([
      savedSession('s1', 'My Setup'),
    ])
    renderPanel()
    await waitFor(() => {
      expect(screen.getByText('★ My Setup')).toBeInTheDocument()
    })
    expect(screen.getByText('Saved Sessions')).toBeInTheDocument()
  })

  it('delete removes saved session from the list', async () => {
    vi.mocked(api.listSavedSessions).mockResolvedValue([
      savedSession('s1', 'Delete Me'),
    ])
    renderPanel()
    await waitFor(() => screen.getByText('★ Delete Me'))
    const row = screen.getByText('★ Delete Me').closest('.session-row')!
    await userEvent.click(within(row).getByText('✕'))
    expect(api.deleteSavedSession).toHaveBeenCalledWith('s1')
    await waitFor(() => {
      expect(screen.queryByText('★ Delete Me')).not.toBeInTheDocument()
    })
  })

  it('"Replace" for saved calls onRestoreHere and closes panel', async () => {
    const session = savedSession('s1', 'Saved WS')
    vi.mocked(api.listSavedSessions).mockResolvedValue([session])
    renderPanel()
    await waitFor(() => screen.getByText('★ Saved WS'))
    const row = screen.getByText('★ Saved WS').closest('.session-row')!
    await userEvent.click(within(row).getByText('Replace'))
    expect(onRestoreHere).toHaveBeenCalledWith(session.session)
    expect(onClose).toHaveBeenCalled()
  })

  it('"Replace" for saved does NOT call deleteWorkspaceSession', async () => {
    vi.mocked(api.listSavedSessions).mockResolvedValue([savedSession('s1', 'Saved WS')])
    renderPanel()
    await waitFor(() => screen.getByText('★ Saved WS'))
    const row = screen.getByText('★ Saved WS').closest('.session-row')!
    await userEvent.click(within(row).getByText('Replace'))
    expect(api.deleteWorkspaceSession).not.toHaveBeenCalled()
  })

  it('"Open" calls openSavedSessionInNewWindow and closes panel', async () => {
    vi.mocked(api.listSavedSessions).mockResolvedValue([savedSession('s1', 'Open Me')])
    renderPanel()
    await waitFor(() => screen.getByText('★ Open Me'))
    const row = screen.getByText('★ Open Me').closest('.session-row')!
    await userEvent.click(within(row).getByText('Open'))
    expect(api.openSavedSessionInNewWindow).toHaveBeenCalledWith('s1')
    expect(onClose).toHaveBeenCalled()
  })

  it('double-click shows rename input', async () => {
    vi.mocked(api.listSavedSessions).mockResolvedValue([savedSession('s1', 'Old Name')])
    renderPanel()
    await waitFor(() => screen.getByText('★ Old Name'))
    await userEvent.dblClick(screen.getByText('★ Old Name'))
    expect(screen.getByDisplayValue('Old Name')).toBeInTheDocument()
  })

  it('rename input submits on Enter and calls renameSavedSession', async () => {
    vi.mocked(api.listSavedSessions).mockResolvedValue([savedSession('s1', 'Old')])
    renderPanel()
    await waitFor(() => screen.getByText('★ Old'))
    await userEvent.dblClick(screen.getByText('★ Old'))
    const input = screen.getByDisplayValue('Old')
    await userEvent.clear(input)
    await userEvent.type(input, 'New Name')
    await userEvent.keyboard('{Enter}')
    expect(api.renameSavedSession).toHaveBeenCalledWith('s1', 'New Name')
    await waitFor(() => {
      expect(screen.getByText('★ New Name')).toBeInTheDocument()
    })
  })

  it('rename input cancels on Escape', async () => {
    vi.mocked(api.listSavedSessions).mockResolvedValue([savedSession('s1', 'Keep')])
    renderPanel()
    await waitFor(() => screen.getByText('★ Keep'))
    await userEvent.dblClick(screen.getByText('★ Keep'))
    await userEvent.keyboard('{Escape}')
    expect(screen.getByText('★ Keep')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('Keep')).not.toBeInTheDocument()
  })

  it('rename input submits on blur', async () => {
    vi.mocked(api.listSavedSessions).mockResolvedValue([savedSession('s1', 'Blur Test')])
    renderPanel()
    await waitFor(() => screen.getByText('★ Blur Test'))
    await userEvent.dblClick(screen.getByText('★ Blur Test'))
    const input = screen.getByDisplayValue('Blur Test')
    await userEvent.clear(input)
    await userEvent.type(input, 'After Blur')
    fireEvent.blur(input)
    expect(api.renameSavedSession).toHaveBeenCalledWith('s1', 'After Blur')
  })
})

// ── Both sections visible ─────────────────────────────────────────────────────

describe('both sections visible', () => {
  it('renders both Recent and Saved sections when both have data', async () => {
    vi.mocked(api.getRestoreableSessions).mockResolvedValue([
      restoreableSession('w1', 'Recent WS'),
    ])
    vi.mocked(api.listSavedSessions).mockResolvedValue([
      savedSession('s1', 'Saved WS'),
    ])
    renderPanel()
    await waitFor(() => {
      expect(screen.getByText('Recent Workspaces')).toBeInTheDocument()
      expect(screen.getByText('Saved Sessions')).toBeInTheDocument()
      expect(screen.getByText('Recent WS')).toBeInTheDocument()
      expect(screen.getByText('★ Saved WS')).toBeInTheDocument()
    })
  })
})

// ── Save current workspace ────────────────────────────────────────────────────

describe('Save current workspace as…', () => {
  it('shows the trigger button', async () => {
    renderPanel()
    await waitFor(() => {
      expect(screen.getByText('+ Save current workspace as…')).toBeInTheDocument()
    })
  })

  it('clicking the trigger shows the name input pre-filled with current name', async () => {
    renderPanel()
    await waitFor(() => screen.getByText('+ Save current workspace as…'))
    await userEvent.click(screen.getByText('+ Save current workspace as…'))
    // Input should be visible and pre-filled with "Test Workspace" (from mock)
    expect(screen.getByPlaceholderText('Session name')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Test Workspace')).toBeInTheDocument()
  })

  it('submitting save form calls saveNamedSession and refreshes list', async () => {
    vi.mocked(api.saveNamedSession).mockResolvedValue('saved-new')
    vi.mocked(api.listSavedSessions)
      .mockResolvedValueOnce([])           // initial load
      .mockResolvedValue([savedSession('saved-new', 'My Config')]) // after save
    renderPanel()
    await waitFor(() => screen.getByText('+ Save current workspace as…'))
    await userEvent.click(screen.getByText('+ Save current workspace as…'))
    const input = screen.getByPlaceholderText('Session name')
    // Use fireEvent.change to atomically set the value; userEvent.type fires
    // individual key events that trigger the component's useEffect select() on
    // each savingName change, clobbering the typed text mid-sequence.
    fireEvent.change(input, { target: { value: 'My Config' } })
    await userEvent.click(screen.getByText('Save'))
    expect(api.saveNamedSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My Config' })
    )
    await waitFor(() => {
      expect(screen.getByText('★ My Config')).toBeInTheDocument()
    })
  })

  it('submitting save form via Enter key works', async () => {
    renderPanel()
    await waitFor(() => screen.getByText('+ Save current workspace as…'))
    await userEvent.click(screen.getByText('+ Save current workspace as…'))
    await userEvent.keyboard('{Enter}')
    expect(api.saveNamedSession).toHaveBeenCalled()
  })

  it('pressing Escape cancels the save form', async () => {
    renderPanel()
    await waitFor(() => screen.getByText('+ Save current workspace as…'))
    await userEvent.click(screen.getByText('+ Save current workspace as…'))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByPlaceholderText('Session name')).not.toBeInTheDocument()
    expect(screen.getByText('+ Save current workspace as…')).toBeInTheDocument()
  })

  it('clicking the ✕ cancel button hides the form', async () => {
    renderPanel()
    await waitFor(() => screen.getByText('+ Save current workspace as…'))
    await userEvent.click(screen.getByText('+ Save current workspace as…'))
    // Find the cancel button next to the save form
    const cancelBtn = screen.getByTitle ? screen.getAllByText('✕').at(-1)! : screen.getAllByText('✕')[0]
    await userEvent.click(cancelBtn)
    expect(screen.queryByPlaceholderText('Session name')).not.toBeInTheDocument()
  })
})

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('empty save name falls back to current workspace name', async () => {
    renderPanel()
    await waitFor(() => screen.getByText('+ Save current workspace as…'))
    await userEvent.click(screen.getByText('+ Save current workspace as…'))
    const input = screen.getByPlaceholderText('Session name')
    await userEvent.clear(input)
    // Submit with empty name
    await userEvent.click(screen.getByText('Save'))
    // saveNamedSession should be called with the workspace name as fallback
    expect(api.saveNamedSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Test Workspace' })
    )
  })

  it('rename with empty string is not submitted', async () => {
    vi.mocked(api.listSavedSessions).mockResolvedValue([savedSession('s1', 'Name')])
    renderPanel()
    await waitFor(() => screen.getByText('★ Name'))
    await userEvent.dblClick(screen.getByText('★ Name'))
    const input = screen.getByDisplayValue('Name')
    await userEvent.clear(input)
    // Submit with empty value
    fireEvent.blur(input)
    expect(api.renameSavedSession).not.toHaveBeenCalled()
  })

  it('shows no empty message when save form is visible but sessions are empty', async () => {
    renderPanel()
    await waitFor(() => screen.getByText('+ Save current workspace as…'))
    await userEvent.click(screen.getByText('+ Save current workspace as…'))
    // "No saved sessions yet." should be hidden once form is showing
    // (form is in save area, empty msg is controlled by isEmpty && savingName === null)
    expect(screen.queryByText('No saved sessions yet.')).not.toBeInTheDocument()
  })

  it('deleting all sessions shows empty message', async () => {
    vi.mocked(api.getRestoreableSessions).mockResolvedValue([
      restoreableSession('w1', 'Solo'),
    ])
    renderPanel()
    await waitFor(() => screen.getByText('Solo'))
    const row = screen.getByText('Solo').closest('.session-row')!
    await userEvent.click(within(row).getByText('✕'))
    await waitFor(() => {
      expect(screen.getByText('No saved sessions yet.')).toBeInTheDocument()
    })
  })
})
