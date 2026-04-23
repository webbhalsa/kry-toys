import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock tauriAPI before the store imports it — the store has a module-level
// subscribe that calls saveSession; we don't want real IPC in unit tests.
vi.mock('../tauriAPI', () => ({
  saveSession: vi.fn(),
}))

// Mock @tauri-apps/api/* so the module can be imported in jsdom
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))

import {
  useWorkspaceStore,
  getFirstTerminalId,
  collectTerminalIds,
  matchesShortcut,
  registerTerminalFocus,
  unregisterTerminalFocus,
  focusPane,
} from './workspaceStore'
import type { TerminalPaneNode, SplitPaneNode, PaneNode } from '../types'

// ── Helpers ───────────────────────────────────────────────────────────────────

const terminal = (id: string, number = 1): TerminalPaneNode =>
  ({ type: 'terminal', id, number })

const split = (id: string, dir: 'horizontal' | 'vertical', left: PaneNode, right: PaneNode): SplitPaneNode =>
  ({ type: 'split', id, direction: dir, children: [left, right] })

function makeKeyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    key: '',
    ...overrides,
  } as KeyboardEvent
}

// Reset store to a known baseline before each test
beforeEach(() => {
  const rootPane = terminal('root-1', 1)
  const tab = {
    id: 'tab-1',
    name: 'Tab 1',
    rootPane,
    nextTerminalNumber: 2,
    paneStates: {} as Record<string, { cwd: string; hadClaude: boolean }>,
  }
  useWorkspaceStore.setState({
    name: 'Workspace',
    rootPane,
    nextTerminalNumber: 2,
    accentColor: undefined,
    paneStates: {},
    focusedPaneId: null,
    tabs: [tab],
    activeTabId: 'tab-1',
  })
})

// ── getFirstTerminalId ────────────────────────────────────────────────────────

describe('getFirstTerminalId', () => {
  it('returns the id of a single terminal', () => {
    expect(getFirstTerminalId(terminal('t1'))).toBe('t1')
  })

  it('returns the leftmost terminal in a split', () => {
    const tree = split('s1', 'horizontal', terminal('left'), terminal('right'))
    expect(getFirstTerminalId(tree)).toBe('left')
  })

  it('recurses into deeply nested splits', () => {
    const inner = split('s2', 'vertical', terminal('deep-left'), terminal('deep-right'))
    const outer = split('s1', 'horizontal', inner, terminal('far-right'))
    expect(getFirstTerminalId(outer)).toBe('deep-left')
  })
})

// ── collectTerminalIds ────────────────────────────────────────────────────────

describe('collectTerminalIds', () => {
  it('returns a single-element array for a lone terminal', () => {
    expect(collectTerminalIds(terminal('only'))).toEqual(['only'])
  })

  it('returns [left, right] for a simple split', () => {
    const tree = split('s1', 'horizontal', terminal('a'), terminal('b'))
    expect(collectTerminalIds(tree)).toEqual(['a', 'b'])
  })

  it('returns all terminals in left-to-right, top-to-bottom order', () => {
    // (a | b) above (c | d)
    const top    = split('s-top', 'horizontal', terminal('a'), terminal('b'))
    const bottom = split('s-bot', 'horizontal', terminal('c'), terminal('d'))
    const root   = split('s-root', 'vertical', top, bottom)
    expect(collectTerminalIds(root)).toEqual(['a', 'b', 'c', 'd'])
  })
})

// ── matchesShortcut ───────────────────────────────────────────────────────────

describe('matchesShortcut', () => {
  it('returns true for an exact ctrl match', () => {
    const e = makeKeyEvent({ ctrlKey: true, key: 's' })
    expect(matchesShortcut(e, 'ctrl+s')).toBe(true)
  })

  it('returns false when the key is wrong', () => {
    const e = makeKeyEvent({ ctrlKey: true, key: 'x' })
    expect(matchesShortcut(e, 'ctrl+s')).toBe(false)
  })

  it('returns false when a required modifier is missing', () => {
    const e = makeKeyEvent({ ctrlKey: false, key: 's' })
    expect(matchesShortcut(e, 'ctrl+s')).toBe(false)
  })

  it('returns false when an extra modifier is held', () => {
    const e = makeKeyEvent({ ctrlKey: true, shiftKey: true, key: 's' })
    expect(matchesShortcut(e, 'ctrl+s')).toBe(false)
  })

  it('returns false for an empty shortcut string', () => {
    const e = makeKeyEvent({ ctrlKey: true, key: 's' })
    expect(matchesShortcut(e, '')).toBe(false)
  })

  it('is case-insensitive for the key', () => {
    const e = makeKeyEvent({ ctrlKey: true, key: 'S' })
    expect(matchesShortcut(e, 'ctrl+s')).toBe(true)
  })

  it('handles meta modifier', () => {
    const e = makeKeyEvent({ metaKey: true, key: 'k' })
    expect(matchesShortcut(e, 'meta+k')).toBe(true)
  })

  it('handles multiple modifiers', () => {
    const e = makeKeyEvent({ ctrlKey: true, shiftKey: true, key: 'tab' })
    expect(matchesShortcut(e, 'ctrl+shift+tab')).toBe(true)
  })

  it('handles alt modifier', () => {
    const e = makeKeyEvent({ altKey: true, key: 'arrowleft' })
    expect(matchesShortcut(e, 'alt+ArrowLeft')).toBe(true)
  })
})

// ── Terminal focus registry ───────────────────────────────────────────────────

describe('registerTerminalFocus / unregisterTerminalFocus / focusPane', () => {
  it('calls the registered focus function', () => {
    const fn = vi.fn()
    registerTerminalFocus('p1', fn)
    focusPane('p1')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('does nothing when focusPane is called for an unknown id', () => {
    // Should not throw
    expect(() => focusPane('unknown')).not.toThrow()
  })

  it('unregistered focus function is not called', () => {
    const fn = vi.fn()
    registerTerminalFocus('p1', fn)
    unregisterTerminalFocus('p1')
    focusPane('p1')
    expect(fn).not.toHaveBeenCalled()
  })

  it('replaces an existing registration for the same id', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    registerTerminalFocus('p1', fn1)
    registerTerminalFocus('p1', fn2)
    focusPane('p1')
    expect(fn1).not.toHaveBeenCalled()
    expect(fn2).toHaveBeenCalledOnce()
  })
})

// ── Store: setName ────────────────────────────────────────────────────────────

describe('store.setName', () => {
  it('updates the workspace name', () => {
    useWorkspaceStore.getState().setName('My Project')
    expect(useWorkspaceStore.getState().name).toBe('My Project')
  })
})

// ── Store: setAccentColor ─────────────────────────────────────────────────────

describe('store.setAccentColor', () => {
  it('updates accent color', () => {
    useWorkspaceStore.getState().setAccentColor('#1e3a5f')
    expect(useWorkspaceStore.getState().accentColor).toBe('#1e3a5f')
  })

  it('clears accent color when undefined is passed', () => {
    useWorkspaceStore.getState().setAccentColor('#1e3a5f')
    useWorkspaceStore.getState().setAccentColor(undefined)
    expect(useWorkspaceStore.getState().accentColor).toBeUndefined()
  })
})

// ── Store: setFocusedPane ─────────────────────────────────────────────────────

describe('store.setFocusedPane', () => {
  it('sets the focused pane ID', () => {
    useWorkspaceStore.getState().setFocusedPane('pane-42')
    expect(useWorkspaceStore.getState().focusedPaneId).toBe('pane-42')
  })
})

// ── Store: splitPane ─────────────────────────────────────────────────────────

describe('store.splitPane', () => {
  it('converts a terminal into a split with two children', () => {
    const { rootPane } = useWorkspaceStore.getState()
    const rootId = (rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'horizontal')
    const { rootPane: newRoot } = useWorkspaceStore.getState()
    expect(newRoot.type).toBe('split')
    const sp = newRoot as SplitPaneNode
    expect(sp.direction).toBe('horizontal')
    expect(sp.children[0].type).toBe('terminal')
    expect(sp.children[1].type).toBe('terminal')
  })

  it('increments nextTerminalNumber', () => {
    const before = useWorkspaceStore.getState().nextTerminalNumber
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'vertical')
    expect(useWorkspaceStore.getState().nextTerminalNumber).toBe(before + 1)
  })

  it('splits vertical correctly', () => {
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'vertical')
    const sp = useWorkspaceStore.getState().rootPane as SplitPaneNode
    expect(sp.direction).toBe('vertical')
  })

  it('is a no-op when paneId is not in the tree', () => {
    const { rootPane: before } = useWorkspaceStore.getState()
    useWorkspaceStore.getState().splitPane('nonexistent', 'horizontal')
    expect(useWorkspaceStore.getState().rootPane).toEqual(before)
  })

  it('assigns sequential terminal numbers', () => {
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'horizontal')
    const sp = useWorkspaceStore.getState().rootPane as SplitPaneNode
    const left  = sp.children[0] as TerminalPaneNode
    const right = sp.children[1] as TerminalPaneNode
    expect(left.number).toBe(1)
    expect(right.number).toBe(2)
  })

  it('recursively splits a pane nested inside an existing split (covers splitPaneInTree split branch)', () => {
    // Create root = split[root-1, new-2]
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'horizontal')
    const sp1 = useWorkspaceStore.getState().rootPane as SplitPaneNode
    const rightId = (sp1.children[1] as TerminalPaneNode).id
    // Now split the nested right pane — this forces splitPaneInTree to recurse through the root split
    useWorkspaceStore.getState().splitPane(rightId, 'vertical')
    const sp2 = useWorkspaceStore.getState().rootPane as SplitPaneNode
    // Left child is still a terminal; right child is now a split
    expect(sp2.children[0].type).toBe('terminal')
    expect(sp2.children[1].type).toBe('split')
    expect((sp2.children[1] as SplitPaneNode).direction).toBe('vertical')
  })
})

// ── Store: closePane ──────────────────────────────────────────────────────────

describe('store.closePane', () => {
  it('removes a pane from a split (sibling promoted to root)', () => {
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'horizontal')
    const sp = useWorkspaceStore.getState().rootPane as SplitPaneNode
    const rightId = (sp.children[1] as TerminalPaneNode).id
    useWorkspaceStore.getState().closePane(rightId)
    // Root should be a single terminal again
    expect(useWorkspaceStore.getState().rootPane.type).toBe('terminal')
  })

  it('removes the pane state when closing', () => {
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'horizontal')
    const sp = useWorkspaceStore.getState().rootPane as SplitPaneNode
    const rightId = (sp.children[1] as TerminalPaneNode).id
    // Give the pane a state
    useWorkspaceStore.getState().updatePaneState(rightId, { cwd: '/tmp', hadClaude: false })
    useWorkspaceStore.getState().closePane(rightId)
    expect(useWorkspaceStore.getState().paneStates[rightId]).toBeUndefined()
  })

  it('does not close the last remaining terminal', () => {
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().closePane(rootId)
    // Root must still be the same terminal (cannot close last pane)
    expect((useWorkspaceStore.getState().rootPane as TerminalPaneNode).id).toBe(rootId)
  })

  it('preserves both branches when closing a deeply-nested pane (covers closePaneInTree both-children branch)', () => {
    // Build: root = split[split[a, b], c]
    // Closing b should yield: root = split[a, c]
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'horizontal')
    const sp1 = useWorkspaceStore.getState().rootPane as SplitPaneNode
    const leftId = (sp1.children[0] as TerminalPaneNode).id
    // Split the left child to create split[split[left, new], rightOriginal]
    useWorkspaceStore.getState().splitPane(leftId, 'vertical')
    const sp2 = useWorkspaceStore.getState().rootPane as SplitPaneNode
    const innerSplit = sp2.children[0] as SplitPaneNode
    const innerRightId = (innerSplit.children[1] as TerminalPaneNode).id
    const outerRightId = (sp2.children[1] as TerminalPaneNode).id
    // Close the inner-right pane; both outer branches (inner-left and outer-right) remain
    useWorkspaceStore.getState().closePane(innerRightId)
    const sp3 = useWorkspaceStore.getState().rootPane as SplitPaneNode
    // Root is still a split with two terminal children
    expect(sp3.type).toBe('split')
    expect(sp3.children[0].type).toBe('terminal')
    expect(sp3.children[1].type).toBe('terminal')
    expect((sp3.children[1] as TerminalPaneNode).id).toBe(outerRightId)
  })

  it('recalculates nextTerminalNumber after close', () => {
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'horizontal')
    const sp = useWorkspaceStore.getState().rootPane as SplitPaneNode
    const rightId = (sp.children[1] as TerminalPaneNode).id
    useWorkspaceStore.getState().closePane(rightId)
    // Only terminal 1 remains → nextTerminalNumber should be 2
    expect(useWorkspaceStore.getState().nextTerminalNumber).toBe(2)
  })
})

// ── Store: renamePane ─────────────────────────────────────────────────────────

describe('store.renamePane', () => {
  it('sets a custom label on a terminal pane', () => {
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().renamePane(rootId, 'Custom Label')
    const root = useWorkspaceStore.getState().rootPane as TerminalPaneNode
    expect(root.label).toBe('Custom Label')
  })

  it('clears a label when empty string is passed', () => {
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().renamePane(rootId, 'Labeled')
    useWorkspaceStore.getState().renamePane(rootId, '')
    const root = useWorkspaceStore.getState().rootPane as TerminalPaneNode
    expect(root.label).toBeUndefined()
  })

  it('is a no-op for unknown pane id', () => {
    const { rootPane: before } = useWorkspaceStore.getState()
    useWorkspaceStore.getState().renamePane('ghost', 'Nope')
    expect(useWorkspaceStore.getState().rootPane).toEqual(before)
  })

  it('renames a pane nested inside a split (covers renamePaneInTree split branch)', () => {
    // Create root = split[root-1, new-2]
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'horizontal')
    const sp = useWorkspaceStore.getState().rootPane as SplitPaneNode
    const rightId = (sp.children[1] as TerminalPaneNode).id
    // Rename the right (nested) pane — forces renamePaneInTree to recurse through the split
    useWorkspaceStore.getState().renamePane(rightId, 'Right Pane')
    const sp2 = useWorkspaceStore.getState().rootPane as SplitPaneNode
    expect((sp2.children[0] as TerminalPaneNode).label).toBeUndefined()
    expect((sp2.children[1] as TerminalPaneNode).label).toBe('Right Pane')
  })
})

// ── Store: updatePaneState / clearPaneState ───────────────────────────────────

describe('store.updatePaneState / clearPaneState', () => {
  it('stores pane state', () => {
    useWorkspaceStore.getState().updatePaneState('p1', {
      cwd: '/home/user',
      hadClaude: true,
      claudeSessionId: 'sess-1',
    })
    expect(useWorkspaceStore.getState().paneStates['p1']).toMatchObject({
      cwd: '/home/user',
      hadClaude: true,
      claudeSessionId: 'sess-1',
    })
  })

  it('overwrites existing pane state', () => {
    useWorkspaceStore.getState().updatePaneState('p1', { cwd: '/a', hadClaude: false })
    useWorkspaceStore.getState().updatePaneState('p1', { cwd: '/b', hadClaude: true })
    expect(useWorkspaceStore.getState().paneStates['p1'].cwd).toBe('/b')
  })

  it('clearPaneState removes the entry', () => {
    useWorkspaceStore.getState().updatePaneState('p1', { cwd: '/tmp', hadClaude: false })
    useWorkspaceStore.getState().clearPaneState('p1')
    expect(useWorkspaceStore.getState().paneStates['p1']).toBeUndefined()
  })

  it('clearPaneState on unknown id is a no-op', () => {
    useWorkspaceStore.getState().clearPaneState('unknown')
    expect(useWorkspaceStore.getState().paneStates).toEqual({})
  })

  it('does not affect other pane states when clearing one', () => {
    useWorkspaceStore.getState().updatePaneState('p1', { cwd: '/a', hadClaude: false })
    useWorkspaceStore.getState().updatePaneState('p2', { cwd: '/b', hadClaude: true })
    useWorkspaceStore.getState().clearPaneState('p1')
    expect(useWorkspaceStore.getState().paneStates['p2']).toBeDefined()
  })
})

// ── Store: restore ────────────────────────────────────────────────────────────

describe('store.restore', () => {
  it('replaces workspace state from a saved session', () => {
    const session = {
      name: 'Restored WS',
      rootPane: terminal('restored-root', 3),
      accentColor: '#2d1b4e',
      paneStates: { 'restored-root': { cwd: '/srv', hadClaude: false } },
    }
    useWorkspaceStore.getState().restore(session)
    const state = useWorkspaceStore.getState()
    expect(state.name).toBe('Restored WS')
    expect((state.rootPane as TerminalPaneNode).id).toBe('restored-root')
    expect(state.accentColor).toBe('#2d1b4e')
    expect(state.paneStates['restored-root']?.cwd).toBe('/srv')
  })

  it('recalculates nextTerminalNumber from restored tree', () => {
    const tree = split('sp', 'horizontal', terminal('a', 3), terminal('b', 7))
    useWorkspaceStore.getState().restore({ name: 'R', rootPane: tree })
    // maxTerminalNumber of the tree is 7, so next should be 8
    expect(useWorkspaceStore.getState().nextTerminalNumber).toBe(8)
  })

  it('restores empty paneStates when not provided', () => {
    useWorkspaceStore.getState().updatePaneState('old', { cwd: '/x', hadClaude: true })
    useWorkspaceStore.getState().restore({ name: 'Fresh', rootPane: terminal('t') })
    expect(useWorkspaceStore.getState().paneStates).toEqual({})
  })
})

// ── Store: resetWorkspace ─────────────────────────────────────────────────────

describe('store.resetWorkspace', () => {
  it('replaces rootPane with a single fresh terminal', () => {
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'horizontal')
    useWorkspaceStore.getState().resetWorkspace()
    expect(useWorkspaceStore.getState().rootPane.type).toBe('terminal')
  })

  it('resets nextTerminalNumber to 2', () => {
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'horizontal')
    useWorkspaceStore.getState().resetWorkspace()
    expect(useWorkspaceStore.getState().nextTerminalNumber).toBe(2)
  })

  it('preserves name and accentColor', () => {
    useWorkspaceStore.getState().setName('Keep Me')
    useWorkspaceStore.getState().setAccentColor('#red')
    useWorkspaceStore.getState().resetWorkspace()
    expect(useWorkspaceStore.getState().name).toBe('Keep Me')
    expect(useWorkspaceStore.getState().accentColor).toBe('#red')
  })
})

// ── deriveFromTab fallback (invalid activeTabId) ──────────────────────────────

describe('deriveFromTab fallback', () => {
  it('returns fallback state when activeTabId does not match any tab', () => {
    // Force state into an inconsistent scenario where activeTabId is invalid
    useWorkspaceStore.setState({
      ...useWorkspaceStore.getState(),
      activeTabId: 'nonexistent-tab-id',
    })
    // Calling setActiveTab with the same invalid id triggers deriveFromTab
    useWorkspaceStore.getState().setActiveTab('nonexistent-tab-id')
    const state = useWorkspaceStore.getState()
    expect((state.rootPane as TerminalPaneNode).id).toBe('fallback')
    expect(state.nextTerminalNumber).toBe(2)
    expect(state.paneStates).toEqual({})
  })
})

// ── Store: addTab ─────────────────────────────────────────────────────────────

describe('store.addTab', () => {
  it('adds a new tab and makes it active', () => {
    useWorkspaceStore.getState().addTab()
    const { tabs, activeTabId } = useWorkspaceStore.getState()
    expect(tabs).toHaveLength(2)
    expect(tabs[1].name).toBe('Tab 2')
    expect(activeTabId).toBe(tabs[1].id)
  })

  it('new tab has a single terminal pane', () => {
    useWorkspaceStore.getState().addTab()
    const { rootPane } = useWorkspaceStore.getState()
    expect(rootPane.type).toBe('terminal')
    expect((rootPane as TerminalPaneNode).number).toBe(1)
  })

  it('new tab starts with nextTerminalNumber = 2', () => {
    useWorkspaceStore.getState().addTab()
    expect(useWorkspaceStore.getState().nextTerminalNumber).toBe(2)
  })

  it('new tab starts with empty paneStates', () => {
    useWorkspaceStore.getState().addTab()
    expect(useWorkspaceStore.getState().paneStates).toEqual({})
  })

  it('tab name uses length+1 for naming', () => {
    useWorkspaceStore.getState().addTab()
    useWorkspaceStore.getState().addTab()
    const { tabs } = useWorkspaceStore.getState()
    expect(tabs[2].name).toBe('Tab 3')
  })
})

// ── Store: closeTab ───────────────────────────────────────────────────────────

describe('store.closeTab', () => {
  it('does not close the last tab', () => {
    const { tabs } = useWorkspaceStore.getState()
    useWorkspaceStore.getState().closeTab(tabs[0].id)
    expect(useWorkspaceStore.getState().tabs).toHaveLength(1)
  })

  it('removes a tab when more than one exist', () => {
    useWorkspaceStore.getState().addTab()
    const { tabs } = useWorkspaceStore.getState()
    const firstTabId = tabs[0].id
    useWorkspaceStore.getState().closeTab(firstTabId)
    expect(useWorkspaceStore.getState().tabs).toHaveLength(1)
    expect(useWorkspaceStore.getState().tabs[0].id).not.toBe(firstTabId)
  })

  it('switches to previous tab when active tab is closed', () => {
    useWorkspaceStore.getState().addTab()
    const { tabs } = useWorkspaceStore.getState()
    const firstTabId = tabs[0].id
    const secondTabId = tabs[1].id
    // Active is second tab; close it → should switch to first
    useWorkspaceStore.getState().closeTab(secondTabId)
    expect(useWorkspaceStore.getState().activeTabId).toBe(firstTabId)
  })

  it('switches to first tab when first tab is closed and it was active', () => {
    useWorkspaceStore.getState().addTab()
    const { tabs } = useWorkspaceStore.getState()
    const firstTabId = tabs[0].id
    const secondTabId = tabs[1].id
    // Make first tab active, then close it
    useWorkspaceStore.getState().setActiveTab(firstTabId)
    useWorkspaceStore.getState().closeTab(firstTabId)
    // Only second tab remains; it should be active
    expect(useWorkspaceStore.getState().activeTabId).toBe(secondTabId)
  })

  it('keeps activeTabId unchanged when a non-active tab is closed', () => {
    useWorkspaceStore.getState().addTab()
    const { tabs } = useWorkspaceStore.getState()
    const secondTabId = tabs[1].id // currently active
    const firstTabId = tabs[0].id
    useWorkspaceStore.getState().closeTab(firstTabId)
    expect(useWorkspaceStore.getState().activeTabId).toBe(secondTabId)
  })

  it('is a no-op for unknown tabId', () => {
    useWorkspaceStore.getState().addTab()
    const before = useWorkspaceStore.getState().tabs.length
    useWorkspaceStore.getState().closeTab('nonexistent')
    expect(useWorkspaceStore.getState().tabs).toHaveLength(before)
  })

  it('updates derived state when switching tabs on close', () => {
    useWorkspaceStore.getState().addTab()
    const { tabs } = useWorkspaceStore.getState()
    const secondTabId = tabs[1].id
    // Modify the second tab's state (currently active)
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'horizontal')
    // Switch to first tab, close second tab
    useWorkspaceStore.getState().setActiveTab(tabs[0].id)
    useWorkspaceStore.getState().closeTab(secondTabId)
    // rootPane should reflect first tab's single terminal
    expect(useWorkspaceStore.getState().rootPane.type).toBe('terminal')
  })
})

// ── Store: renameTab ──────────────────────────────────────────────────────────

describe('store.renameTab', () => {
  it('renames a tab by id', () => {
    const { tabs } = useWorkspaceStore.getState()
    useWorkspaceStore.getState().renameTab(tabs[0].id, 'My Tab')
    expect(useWorkspaceStore.getState().tabs[0].name).toBe('My Tab')
  })

  it('is a no-op for unknown tabId', () => {
    useWorkspaceStore.getState().renameTab('ghost', 'Nope')
    expect(useWorkspaceStore.getState().tabs[0].name).toBe('Tab 1')
  })
})

// ── Store: setActiveTab ───────────────────────────────────────────────────────

describe('store.setActiveTab', () => {
  it('switches the active tab and updates derived state', () => {
    useWorkspaceStore.getState().addTab()
    const { tabs } = useWorkspaceStore.getState()
    // Second tab is active; switch to first
    useWorkspaceStore.getState().setActiveTab(tabs[0].id)
    expect(useWorkspaceStore.getState().activeTabId).toBe(tabs[0].id)
  })

  it('derived rootPane reflects the switched tab', () => {
    // Tab 1 has single terminal; add tab 2 and split it
    useWorkspaceStore.getState().addTab()
    const { tabs } = useWorkspaceStore.getState()
    // Currently on tab 2; split it
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().splitPane(rootId, 'horizontal')
    expect(useWorkspaceStore.getState().rootPane.type).toBe('split')
    // Switch to tab 1 → should be a single terminal
    useWorkspaceStore.getState().setActiveTab(tabs[0].id)
    expect(useWorkspaceStore.getState().rootPane.type).toBe('terminal')
  })

  it('paneStates are isolated per tab', () => {
    useWorkspaceStore.getState().addTab()
    const { tabs } = useWorkspaceStore.getState()
    // On tab 2, update pane state
    const rootId = (useWorkspaceStore.getState().rootPane as TerminalPaneNode).id
    useWorkspaceStore.getState().updatePaneState(rootId, { cwd: '/tab2', hadClaude: true })
    // Switch to tab 1 — its paneStates should be empty
    useWorkspaceStore.getState().setActiveTab(tabs[0].id)
    expect(Object.keys(useWorkspaceStore.getState().paneStates)).toHaveLength(0)
  })
})
