import { useRef, useState } from 'react'
import { useWorkspaceStore } from '../store/workspaceStore'

export function TabBar() {
  const { tabs, activeTabId, addTab, closeTab, renameTab, setActiveTab } = useWorkspaceStore()
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const startEditing = (tabId: string, currentName: string) => {
    setEditingTabId(tabId)
    setDraft(currentName)
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select() }, 0)
  }

  const commitEdit = () => {
    const trimmed = draft.trim()
    if (trimmed) renameTab(editingTabId!, trimmed)
    setEditingTabId(null)
  }

  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab${tab.id === activeTabId ? ' tab--active' : ''}`}
          onClick={() => setActiveTab(tab.id)}
        >
          {editingTabId === tab.id ? (
            <input
              ref={inputRef}
              className="tab-name-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitEdit}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitEdit()
                if (e.key === 'Escape') setEditingTabId(null)
              }}
            />
          ) : (
            <span
              className="tab-name"
              onDoubleClick={(e) => { e.stopPropagation(); startEditing(tab.id, tab.name) }}
            >
              {tab.name}
            </span>
          )}
          {tabs.length > 1 && (
            <button
              className="tab-close"
              title="Close tab"
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <button className="tab-add" title="New tab" onClick={addTab}>
        +
      </button>
    </div>
  )
}
