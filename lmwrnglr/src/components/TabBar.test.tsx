import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('../tauriAPI', () => ({ saveSession: vi.fn() }))

// We use a mutable state object that vi.fn() selectors can read from.
const mockState = {
  tabs: [
    { id: 'tab-1', name: 'Tab 1', rootPane: { type: 'terminal', id: 'p1', number: 1 }, nextTerminalNumber: 2, paneStates: {} },
  ] as Array<{ id: string; name: string; rootPane: unknown; nextTerminalNumber: number; paneStates: Record<string, unknown> }>,
  activeTabId: 'tab-1',
  addTab: vi.fn(),
  closeTab: vi.fn(),
  renameTab: vi.fn(),
  setActiveTab: vi.fn(),
}

vi.mock('../store/workspaceStore', () => ({
  useWorkspaceStore: vi.fn((selector?: (s: typeof mockState) => unknown) =>
    selector ? selector(mockState) : mockState
  ),
}))

import { TabBar } from './TabBar'

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  // Reset to single tab
  mockState.tabs = [
    { id: 'tab-1', name: 'Tab 1', rootPane: { type: 'terminal', id: 'p1', number: 1 }, nextTerminalNumber: 2, paneStates: {} },
  ]
  mockState.activeTabId = 'tab-1'
})

function renderTabBar() {
  return render(<TabBar />)
}

// ── Single tab rendering ──────────────────────────────────────────────────────

describe('single tab', () => {
  it('renders the tab name', () => {
    renderTabBar()
    expect(screen.getByText('Tab 1')).toBeInTheDocument()
  })

  it('does not show the close button for the only tab', () => {
    renderTabBar()
    expect(screen.queryByTitle('Close tab')).not.toBeInTheDocument()
  })

  it('renders the + add button', () => {
    renderTabBar()
    expect(screen.getByTitle('New tab')).toBeInTheDocument()
  })

  it('tab has active class when it is the active tab', () => {
    renderTabBar()
    const tab = screen.getByText('Tab 1').closest('.tab')
    expect(tab).toHaveClass('tab--active')
  })
})

// ── Multiple tabs ─────────────────────────────────────────────────────────────

describe('multiple tabs', () => {
  beforeEach(() => {
    mockState.tabs = [
      { id: 'tab-1', name: 'Tab 1', rootPane: {}, nextTerminalNumber: 2, paneStates: {} },
      { id: 'tab-2', name: 'Tab 2', rootPane: {}, nextTerminalNumber: 2, paneStates: {} },
    ]
    mockState.activeTabId = 'tab-2'
  })

  it('renders all tab names', () => {
    renderTabBar()
    expect(screen.getByText('Tab 1')).toBeInTheDocument()
    expect(screen.getByText('Tab 2')).toBeInTheDocument()
  })

  it('shows close buttons for each tab', () => {
    renderTabBar()
    const closeButtons = screen.getAllByTitle('Close tab')
    expect(closeButtons).toHaveLength(2)
  })

  it('active tab has tab--active class', () => {
    renderTabBar()
    const tab2 = screen.getByText('Tab 2').closest('.tab')
    const tab1 = screen.getByText('Tab 1').closest('.tab')
    expect(tab2).toHaveClass('tab--active')
    expect(tab1).not.toHaveClass('tab--active')
  })

  it('clicking a tab calls setActiveTab with the tab id', async () => {
    renderTabBar()
    await userEvent.click(screen.getByText('Tab 1').closest('.tab')!)
    expect(mockState.setActiveTab).toHaveBeenCalledWith('tab-1')
  })

  it('clicking the close button on a tab calls closeTab with the tab id', async () => {
    renderTabBar()
    const closeButtons = screen.getAllByTitle('Close tab')
    await userEvent.click(closeButtons[0])
    expect(mockState.closeTab).toHaveBeenCalledWith('tab-1')
  })

  it('close button click does not also trigger setActiveTab', async () => {
    renderTabBar()
    const closeButtons = screen.getAllByTitle('Close tab')
    await userEvent.click(closeButtons[0])
    expect(mockState.setActiveTab).not.toHaveBeenCalled()
  })
})

// ── Add tab ───────────────────────────────────────────────────────────────────

describe('add tab button', () => {
  it('clicking + calls addTab', async () => {
    renderTabBar()
    await userEvent.click(screen.getByTitle('New tab'))
    expect(mockState.addTab).toHaveBeenCalledOnce()
  })
})

// ── Rename tab (double-click inline edit) ─────────────────────────────────────

describe('rename tab', () => {
  it('double-clicking a tab name shows an input', async () => {
    renderTabBar()
    await userEvent.dblClick(screen.getByText('Tab 1'))
    expect(screen.getByDisplayValue('Tab 1')).toBeInTheDocument()
  })

  it('clicking the input after rename start does not call setActiveTab again', async () => {
    renderTabBar()
    await userEvent.dblClick(screen.getByText('Tab 1'))
    const callsBefore = mockState.setActiveTab.mock.calls.length
    const input = screen.getByDisplayValue('Tab 1')
    await userEvent.click(input)
    // No additional calls after entering the input
    expect(mockState.setActiveTab).toHaveBeenCalledTimes(callsBefore)
  })

  it('pressing Enter commits the rename', async () => {
    renderTabBar()
    await userEvent.dblClick(screen.getByText('Tab 1'))
    const input = screen.getByDisplayValue('Tab 1')
    await userEvent.clear(input)
    await userEvent.type(input, 'My Tab')
    await userEvent.keyboard('{Enter}')
    expect(mockState.renameTab).toHaveBeenCalledWith('tab-1', 'My Tab')
    expect(screen.queryByDisplayValue('My Tab')).not.toBeInTheDocument()
  })

  it('pressing Escape cancels edit without renaming', async () => {
    renderTabBar()
    await userEvent.dblClick(screen.getByText('Tab 1'))
    await userEvent.keyboard('{Escape}')
    expect(mockState.renameTab).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('blurring the input commits the rename', async () => {
    renderTabBar()
    await userEvent.dblClick(screen.getByText('Tab 1'))
    const input = screen.getByDisplayValue('Tab 1')
    await userEvent.clear(input)
    await userEvent.type(input, 'Blur Name')
    fireEvent.blur(input)
    expect(mockState.renameTab).toHaveBeenCalledWith('tab-1', 'Blur Name')
  })

  it('does not call renameTab when new name is empty (whitespace only)', async () => {
    renderTabBar()
    await userEvent.dblClick(screen.getByText('Tab 1'))
    const input = screen.getByDisplayValue('Tab 1')
    await userEvent.clear(input)
    fireEvent.blur(input)
    expect(mockState.renameTab).not.toHaveBeenCalled()
  })

  it('double-clicking a non-active tab still activates it (tab div click fires first)', async () => {
    mockState.tabs = [
      { id: 'tab-1', name: 'Tab 1', rootPane: {}, nextTerminalNumber: 2, paneStates: {} },
      { id: 'tab-2', name: 'Tab 2', rootPane: {}, nextTerminalNumber: 2, paneStates: {} },
    ]
    mockState.activeTabId = 'tab-2'
    renderTabBar()
    await userEvent.dblClick(screen.getByText('Tab 1'))
    // The tab div onClick fires on the first click of the dblclick sequence
    expect(mockState.setActiveTab).toHaveBeenCalledWith('tab-1')
    // And the rename input should appear
    expect(screen.getByDisplayValue('Tab 1')).toBeInTheDocument()
  })
})
