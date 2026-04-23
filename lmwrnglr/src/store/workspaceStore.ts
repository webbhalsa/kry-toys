import { create } from 'zustand'
import { PaneNode, PaneState, SplitPaneNode, Tab, TerminalPaneNode, WorkspaceSession } from '../types'
import * as api from '../tauriAPI'

function generateId(): string {
  return Math.random().toString(36).slice(2, 9)
}

/** Returns the pane ID of the top-left (leftmost leaf) terminal in the tree. */
export function getFirstTerminalId(node: PaneNode): string {
  if (node.type === 'terminal') return node.id
  return getFirstTerminalId(node.children[0])
}

/** Returns all terminal pane IDs in left-to-right, top-to-bottom order. */
export function collectTerminalIds(node: PaneNode): string[] {
  if (node.type === 'terminal') return [node.id]
  return [...collectTerminalIds(node.children[0]), ...collectTerminalIds(node.children[1])]
}

/** Returns true if the keyboard event matches a shortcut string like "ctrl+s" or "alt+tab". */
export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false
  const parts = shortcut.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  return (
    e.ctrlKey === parts.includes('ctrl') &&
    e.altKey === parts.includes('alt') &&
    e.metaKey === parts.includes('meta') &&
    e.shiftKey === parts.includes('shift') &&
    e.key.toLowerCase() === key
  )
}

// ── Terminal focus registry ────────────────────────────────────────────────────
// Maps pane IDs to their terminal's focus function. Lives outside the Zustand
// store because it holds live imperative references, not serialisable state.

const _termFocusFns = new Map<string, () => void>()

export const registerTerminalFocus = (paneId: string, fn: () => void) =>
  _termFocusFns.set(paneId, fn)

export const unregisterTerminalFocus = (paneId: string) =>
  _termFocusFns.delete(paneId)

export const focusPane = (paneId: string) =>
  _termFocusFns.get(paneId)?.()

function maxTerminalNumber(node: PaneNode): number {
  if (node.type === 'terminal') return node.number ?? 1
  return Math.max(maxTerminalNumber(node.children[0]), maxTerminalNumber(node.children[1]))
}

function splitPaneInTree(
  node: PaneNode,
  targetId: string,
  direction: 'horizontal' | 'vertical',
  newId: string,
  newNumber: number
): PaneNode {
  if (node.type === 'terminal') {
    if (node.id === targetId) {
      return {
        type: 'split',
        id: generateId(),
        direction,
        children: [node, { type: 'terminal', id: newId, number: newNumber } satisfies TerminalPaneNode],
      } satisfies SplitPaneNode
    }
    return node
  }
  return {
    ...node,
    children: [
      splitPaneInTree(node.children[0], targetId, direction, newId, newNumber),
      splitPaneInTree(node.children[1], targetId, direction, newId, newNumber),
    ] as [PaneNode, PaneNode],
  }
}

function closePaneInTree(node: PaneNode, targetId: string): PaneNode | null {
  if (node.type === 'terminal') return node.id === targetId ? null : node
  const left = closePaneInTree(node.children[0], targetId)
  const right = closePaneInTree(node.children[1], targetId)
  if (left === null) return right
  if (right === null) return left
  return { ...node, children: [left, right] as [PaneNode, PaneNode] }
}

function renamePaneInTree(node: PaneNode, targetId: string, label: string): PaneNode {
  if (node.type === 'terminal') {
    return node.id === targetId ? { ...node, label: label || undefined } : node
  }
  return {
    ...node,
    children: [
      renamePaneInTree(node.children[0], targetId, label),
      renamePaneInTree(node.children[1], targetId, label),
    ] as [PaneNode, PaneNode],
  }
}

function makeTab(name: string): Tab {
  return {
    id: generateId(),
    name,
    rootPane: { type: 'terminal', id: generateId(), number: 1 } satisfies TerminalPaneNode,
    nextTerminalNumber: 2,
    paneStates: {},
  }
}

/** Derive the flat state fields (rootPane, nextTerminalNumber, paneStates) from active tab. */
function deriveFromTab(tabs: Tab[], activeTabId: string): {
  rootPane: PaneNode
  nextTerminalNumber: number
  paneStates: Record<string, PaneState>
} {
  const tab = tabs.find(t => t.id === activeTabId)
  if (!tab) {
    const fallback: TerminalPaneNode = { type: 'terminal', id: 'fallback', number: 1 }
    return { rootPane: fallback, nextTerminalNumber: 2, paneStates: {} }
  }
  return { rootPane: tab.rootPane, nextTerminalNumber: tab.nextTerminalNumber, paneStates: tab.paneStates }
}

function updateActiveTab(
  tabs: Tab[],
  activeTabId: string,
  updater: (tab: Tab) => Tab
): Tab[] {
  return tabs.map(t => t.id === activeTabId ? updater(t) : t)
}

type WorkspaceStore = {
  name: string
  rootPane: PaneNode
  nextTerminalNumber: number
  accentColor: string | undefined
  paneStates: Record<string, PaneState>
  focusedPaneId: string | null
  tabs: Tab[]
  activeTabId: string

  setName: (name: string) => void
  setAccentColor: (color: string | undefined) => void
  setFocusedPane: (id: string) => void
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical') => void
  closePane: (paneId: string) => void
  renamePane: (paneId: string, label: string) => void
  updatePaneState: (paneId: string, state: PaneState) => void
  clearPaneState: (paneId: string) => void
  restore: (session: WorkspaceSession) => void
  resetWorkspace: () => void

  addTab: () => void
  closeTab: (tabId: string) => void
  renameTab: (tabId: string, name: string) => void
  setActiveTab: (tabId: string) => void
}

const initialTab = makeTab('Tab 1')

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  name: 'Workspace',
  ...deriveFromTab([initialTab], initialTab.id),
  accentColor: undefined,
  focusedPaneId: null,
  tabs: [initialTab],
  activeTabId: initialTab.id,

  setName: (name) => set({ name }),
  setAccentColor: (accentColor) => set({ accentColor }),
  setFocusedPane: (id) => set({ focusedPaneId: id }),

  splitPane: (paneId, direction) => {
    const newId = generateId()
    set((state) => {
      const newTabs = updateActiveTab(state.tabs, state.activeTabId, (tab) => ({
        ...tab,
        rootPane: splitPaneInTree(tab.rootPane, paneId, direction, newId, tab.nextTerminalNumber),
        nextTerminalNumber: tab.nextTerminalNumber + 1,
      }))
      return { tabs: newTabs, ...deriveFromTab(newTabs, state.activeTabId) }
    })
  },

  closePane: (paneId) => {
    set((state) => {
      const activeTab = state.tabs.find(t => t.id === state.activeTabId)
      if (!activeTab) return state
      const newRoot = closePaneInTree(activeTab.rootPane, paneId)
      if (newRoot === null) return state
      const { [paneId]: _, ...restPaneStates } = activeTab.paneStates
      const newTabs = updateActiveTab(state.tabs, state.activeTabId, (tab) => ({
        ...tab,
        rootPane: newRoot,
        nextTerminalNumber: maxTerminalNumber(newRoot) + 1,
        paneStates: restPaneStates,
      }))
      return { tabs: newTabs, ...deriveFromTab(newTabs, state.activeTabId) }
    })
  },

  renamePane: (paneId, label) => {
    set((state) => {
      const newTabs = updateActiveTab(state.tabs, state.activeTabId, (tab) => ({
        ...tab,
        rootPane: renamePaneInTree(tab.rootPane, paneId, label),
      }))
      return { tabs: newTabs, ...deriveFromTab(newTabs, state.activeTabId) }
    })
  },

  updatePaneState: (paneId, paneState) =>
    set((state) => {
      const newTabs = updateActiveTab(state.tabs, state.activeTabId, (tab) => ({
        ...tab,
        paneStates: { ...tab.paneStates, [paneId]: paneState },
      }))
      return { tabs: newTabs, ...deriveFromTab(newTabs, state.activeTabId) }
    }),

  clearPaneState: (paneId) =>
    set((state) => {
      const newTabs = updateActiveTab(state.tabs, state.activeTabId, (tab) => {
        const { [paneId]: _, ...rest } = tab.paneStates
        return { ...tab, paneStates: rest }
      })
      return { tabs: newTabs, ...deriveFromTab(newTabs, state.activeTabId) }
    }),

  restore: (session) => set((state) => {
    const newRootPane = session.rootPane
    const newTabs = updateActiveTab(state.tabs, state.activeTabId, (tab) => ({
      ...tab,
      rootPane: newRootPane,
      nextTerminalNumber: maxTerminalNumber(newRootPane) + 1,
      paneStates: session.paneStates ?? {},
    }))
    return {
      name: session.name,
      accentColor: session.accentColor,
      tabs: newTabs,
      ...deriveFromTab(newTabs, state.activeTabId),
    }
  }),

  resetWorkspace: () => set((state) => {
    const newTabs = updateActiveTab(state.tabs, state.activeTabId, (tab) => ({
      ...tab,
      rootPane: { type: 'terminal', id: generateId(), number: 1 } satisfies TerminalPaneNode,
      nextTerminalNumber: 2,
    }))
    return { tabs: newTabs, ...deriveFromTab(newTabs, state.activeTabId) }
  }),

  addTab: () => {
    const { tabs } = get()
    const tabNumber = tabs.length + 1
    const newTab = makeTab(`Tab ${tabNumber}`)
    const newTabs = [...tabs, newTab]
    set({ tabs: newTabs, activeTabId: newTab.id, ...deriveFromTab(newTabs, newTab.id) })
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get()
    if (tabs.length <= 1) return
    const idx = tabs.findIndex(t => t.id === tabId)
    if (idx === -1) return
    const newTabs = tabs.filter(t => t.id !== tabId)
    const newActiveTabId = activeTabId === tabId
      ? newTabs[Math.max(0, idx - 1)].id
      : activeTabId
    set({ tabs: newTabs, activeTabId: newActiveTabId, ...deriveFromTab(newTabs, newActiveTabId) })
  },

  renameTab: (tabId, name) => {
    set((state) => ({
      tabs: state.tabs.map(t => t.id === tabId ? { ...t, name } : t),
    }))
  },

  setActiveTab: (tabId) => {
    set((state) => ({
      activeTabId: tabId,
      ...deriveFromTab(state.tabs, tabId),
    }))
  },
}))

// Stable workspace ID for this window, derived from the URL on first load.
// The URL never changes for the lifetime of the window, so this is safe to
// capture once at module init.
const _wid = new URLSearchParams(window.location.search).get('wid') ?? 'main'

// Auto-save whenever state changes (save active tab's pane layout, as before)
useWorkspaceStore.subscribe((state) => {
  api.saveSession(_wid, {
    name: state.name,
    rootPane: state.rootPane,
    accentColor: state.accentColor,
    paneStates: state.paneStates,
  })
})
