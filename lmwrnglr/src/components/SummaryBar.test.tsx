import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('../tauriAPI', () => ({ saveSession: vi.fn() }))

// ── Store mock ────────────────────────────────────────────────────────────────

const mockState = {
  paneStates: {} as Record<string, { cwd: string; hadClaude: boolean; activityLog?: { activity: string; branch?: string | null; ts: number }[] }>,
  rootPane: { type: 'terminal', id: 'p1', number: 1 },
}

vi.mock('../store/workspaceStore', () => ({
  useWorkspaceStore: vi.fn((selector?: (s: typeof mockState) => unknown) =>
    selector ? selector(mockState) : mockState
  ),
  collectTerminalIds: vi.fn((node: { type: string; id: string }) => [node.id]),
}))

import { SummaryBar } from './SummaryBar'

beforeEach(() => {
  vi.clearAllMocks()
  mockState.paneStates = {}
  mockState.rootPane = { type: 'terminal', id: 'p1', number: 1 }
})

// ── Empty state ───────────────────────────────────────────────────────────────

describe('empty state', () => {
  it('shows the hint when no activity log entries exist', () => {
    render(<SummaryBar />)
    expect(screen.getByText(/No activity yet/)).toBeInTheDocument()
  })

  it('shows the hint when pane states have empty activity logs', () => {
    mockState.paneStates = { p1: { cwd: '~', hadClaude: false, activityLog: [] } }
    render(<SummaryBar />)
    expect(screen.getByText(/No activity yet/)).toBeInTheDocument()
  })
})

// ── Entry rendering ───────────────────────────────────────────────────────────

describe('activity entries', () => {
  it('renders activity text for each entry', () => {
    mockState.paneStates = {
      p1: {
        cwd: '~', hadClaude: true,
        activityLog: [
          { activity: 'Editing src/index.ts', branch: 'main', ts: Date.now() - 60_000 },
        ],
      },
    }
    render(<SummaryBar />)
    expect(screen.getByText('Editing src/index.ts')).toBeInTheDocument()
  })

  it('renders the branch badge when branch is present', () => {
    mockState.paneStates = {
      p1: {
        cwd: '~', hadClaude: true,
        activityLog: [{ activity: '$ git push', branch: 'feat/x', ts: Date.now() }],
      },
    }
    render(<SummaryBar />)
    expect(screen.getByText('feat/x')).toBeInTheDocument()
  })

  it('omits the branch badge when branch is null', () => {
    mockState.paneStates = {
      p1: {
        cwd: '~', hadClaude: true,
        activityLog: [{ activity: 'Reading foo.txt', branch: null, ts: Date.now() }],
      },
    }
    render(<SummaryBar />)
    expect(screen.queryByText('null')).not.toBeInTheDocument()
  })
})

// ── Sort order ────────────────────────────────────────────────────────────────

describe('sort order', () => {
  it('shows newest entries first', () => {
    const now = Date.now()
    mockState.paneStates = {
      p1: {
        cwd: '~', hadClaude: true,
        activityLog: [
          { activity: 'Old task', ts: now - 120_000 },
          { activity: 'New task', ts: now - 10_000 },
        ],
      },
    }
    render(<SummaryBar />)
    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('New task')
    expect(items[1]).toHaveTextContent('Old task')
  })

  it('merges and sorts entries across multiple panes newest first', async () => {
    const now = Date.now()
    mockState.rootPane = {
      type: 'split', id: 's1', direction: 'horizontal',
      children: [
        { type: 'terminal', id: 'p1', number: 1 },
        { type: 'terminal', id: 'p2', number: 2 },
      ],
    } as unknown as typeof mockState.rootPane

    // collectTerminalIds needs to return both pane IDs
    const { collectTerminalIds } = await import('../store/workspaceStore')
    vi.mocked(collectTerminalIds).mockReturnValue(['p1', 'p2'])

    mockState.paneStates = {
      p1: { cwd: '~', hadClaude: true, activityLog: [{ activity: 'Task A', ts: now - 5_000 }] },
      p2: { cwd: '~', hadClaude: true, activityLog: [{ activity: 'Task B', ts: now - 1_000 }] },
    }
    render(<SummaryBar />)
    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Task B')
    expect(items[1]).toHaveTextContent('Task A')
  })
})

// ── Active pane filtering ─────────────────────────────────────────────────────

describe('active pane filtering', () => {
  it('excludes entries from panes not in the rootPane tree', async () => {
    // collectTerminalIds returns only p1, not p2
    const { collectTerminalIds } = await import('../store/workspaceStore')
    vi.mocked(collectTerminalIds).mockReturnValue(['p1'])

    mockState.paneStates = {
      p1: { cwd: '~', hadClaude: true, activityLog: [{ activity: 'Active pane task', ts: Date.now() }] },
      p2: { cwd: '~', hadClaude: true, activityLog: [{ activity: 'Closed pane task', ts: Date.now() }] },
    }
    render(<SummaryBar />)
    expect(screen.getByText('Active pane task')).toBeInTheDocument()
    expect(screen.queryByText('Closed pane task')).not.toBeInTheDocument()
  })
})

// ── Collapse / expand ─────────────────────────────────────────────────────────

describe('collapse / expand', () => {
  it('hides entries when collapsed', async () => {
    mockState.paneStates = {
      p1: { cwd: '~', hadClaude: true, activityLog: [{ activity: 'Some task', ts: Date.now() }] },
    }
    render(<SummaryBar />)
    await userEvent.click(screen.getByTitle('Collapse'))
    expect(screen.queryByText('Some task')).not.toBeInTheDocument()
  })

  it('shows entries again after expanding', async () => {
    mockState.paneStates = {
      p1: { cwd: '~', hadClaude: true, activityLog: [{ activity: 'Some task', ts: Date.now() }] },
    }
    render(<SummaryBar />)
    await userEvent.click(screen.getByTitle('Collapse'))
    await userEvent.click(screen.getByTitle('Expand'))
    expect(screen.getByText('Some task')).toBeInTheDocument()
  })
})
