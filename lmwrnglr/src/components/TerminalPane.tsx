import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import * as api from '../tauriAPI'
import type { ClaudeStatus } from '../tauriAPI'
import {
  useWorkspaceStore,
  getFirstTerminalId,
  matchesShortcut,
  registerTerminalFocus,
  unregisterTerminalFocus,
} from '../store/workspaceStore'
import type { ActivityEntry, PaneNode } from '../types'

function isPaneInTree(node: PaneNode, targetId: string): boolean {
  if (node.type === 'terminal') return node.id === targetId
  return isPaneInTree(node.children[0], targetId) || isPaneInTree(node.children[1], targetId)
}

// Module-level maps: paneId → state
// Lives outside React so state survives component unmount/remount cycles (e.g. on pane split)
const livePtyIds = new Map<string, string>()
const livePtyOscTitles = new Map<string, string>()   // persists oscTitle across splits
const livePtyStatuses = new Map<string, ClaudeStatus | null>() // persists claudeStatus across splits

interface Props {
  paneId: string
  number: number
  label?: string
  onSplit: (direction: 'horizontal' | 'vertical') => void
  onClose: () => void
  onRename: (label: string) => void
}

export function TerminalPane({ paneId, number, label, onSplit, onClose, onRename }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Initialize from module-level caches so state survives a split-induced remount
  const [oscTitle, setOscTitle] = useState(() => livePtyOscTitles.get(paneId) ?? '')
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  const labelInputRef = useRef<HTMLInputElement>(null)

  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(
    () => livePtyStatuses.get(paneId) ?? null
  )
  // Debounced display status for header layout: updates immediately on 'working',
  // waits 2 s on idle/null to prevent layout flicker during context compaction
  // (compaction briefly fires the Stop hook before restarting with compacted context,
  // which would otherwise flash the "✦ claude" button and trigger a scroll jump).
  const [displayStatus, setDisplayStatus] = useState<ClaudeStatus | null>(
    () => livePtyStatuses.get(paneId) ?? null
  )
  const [exited, setExited] = useState(false)
  const [restartKey, setRestartKey] = useState(0)
  // True when this pane was restored from a previous session that had Claude running
  const [showResume, setShowResume] = useState(false)
  const isFocused = useWorkspaceStore(s => s.focusedPaneId === paneId)
  const claudeSessionName = useWorkspaceStore(s => s.paneStates[paneId]?.claudeSessionName)
  const ptyIdRef = useRef<string | null>(null)
  const shiftEnterRef = useRef(true)
  const cycleShortcutRef = useRef('ctrl+s')
  const cycleWindowShortcutRef = useRef('ctrl+shift+w')
  const closingRef = useRef(false)
  const restartingRef = useRef(false)
  const exitedRef = useRef(false)
  // For activity log: track previous claude state and last working activity
  const prevClaudeStateRef = useRef<string | null>(null)
  const lastWorkingActivityRef = useRef<ActivityEntry | null>(null)

  const defaultName = `Terminal ${number}`
  const displayName = label || defaultName

  // Keep persisted pane state in sync so it's available on the next restore.
  // claudeStatus.cwd is always a real filesystem path (written by Claude Code hooks).
  // oscTitle is only reliable when set by our ZDOTDIR shim (starts with / or ~).
  // Reject OSC titles that look like shell prompt strings (e.g. "user@host:~") or
  // Claude task descriptions — only accept strings that start with a valid path prefix.
  useEffect(() => {
    const isPath = (s: string) => s.startsWith('/') || s.startsWith('~/') || s === '~'
    const cwd = claudeStatus?.cwd ?? (isPath(oscTitle) ? oscTitle : undefined)
    if (cwd) {
      const currentState = useWorkspaceStore.getState().paneStates[paneId]
      // Capture session ID when Claude stops (idle state). Preserve the last known
      // ID across status transitions so it survives until the next restart.
      const claudeSessionId =
        claudeStatus?.state === 'idle' && claudeStatus.sessionId
          ? claudeStatus.sessionId
          : currentState?.claudeSessionId
      // Derive a human-readable name from the cwd basename when Claude first
      // reaches idle and we capture a session ID. Preserved across transitions.
      const claudeSessionName =
        claudeStatus?.state === 'idle' && claudeStatus.sessionId && cwd
          ? (cwd.split('/').filter(Boolean).pop() ?? currentState?.claudeSessionName)
          : currentState?.claudeSessionName
      useWorkspaceStore.getState().updatePaneState(paneId, {
        cwd,
        hadClaude: claudeStatus !== null,
        claudeSessionId,
        claudeSessionName,
        activityLog: currentState?.activityLog,
      })
    }
  }, [paneId, oscTitle, claudeStatus])

  // Track working → idle (or null) transitions to append an activity log entry.
  // Captures the last non-null activity seen while Claude was working, so the
  // log records "what was the last thing Claude did?" for each session.
  useEffect(() => {
    if (claudeStatus?.state === 'working' && claudeStatus.activity) {
      lastWorkingActivityRef.current = {
        activity: claudeStatus.activity,
        cwd: claudeStatus.cwdDisplay || claudeStatus.cwd,
        branch: claudeStatus.branch,
        ts: 0, // placeholder; replaced on transition
      }
    }
    const prevState = prevClaudeStateRef.current
    prevClaudeStateRef.current = claudeStatus?.state ?? null
    if (prevState === 'working' && (claudeStatus?.state === 'idle' || claudeStatus === null)) {
      const last = lastWorkingActivityRef.current
      if (last) {
        lastWorkingActivityRef.current = null
        const entry: ActivityEntry = { ...last, ts: Date.now() }
        const currentState = useWorkspaceStore.getState().paneStates[paneId]
        const existing = currentState?.activityLog ?? []
        useWorkspaceStore.getState().updatePaneState(paneId, {
          ...(currentState ?? { cwd: '', hadClaude: true }),
          activityLog: [entry, ...existing].slice(0, 30),
        })
      }
    }
  }, [paneId, claudeStatus])

  useEffect(() => {
    if (claudeStatus?.state === 'working') {
      setDisplayStatus(claudeStatus)
      return
    }
    const t = setTimeout(() => setDisplayStatus(claudeStatus), 2000)
    return () => clearTimeout(t)
  }, [claudeStatus])

  const startEditing = () => {
    setLabelDraft(label ?? '')
    setEditingLabel(true)
    setTimeout(() => { labelInputRef.current?.focus(); labelInputRef.current?.select() }, 0)
  }

  const commitLabel = () => {
    onRename(labelDraft.trim())
    setEditingLabel(false)
  }

  const handleReset = async () => {
    const currentPtyId = ptyIdRef.current
    if (currentPtyId) {
      const hasChild = await api.ptyHasSubprocess(currentPtyId)
      if (hasChild) {
        const ok = window.confirm(`${displayName} has a running process. Kill it and restart the terminal?`)
        if (!ok) return
      }
    }
    setShowResume(false)
    restartingRef.current = true
    setRestartKey(k => k + 1)
  }

  const handleClose = () => {
    closingRef.current = true
    onClose()
  }

  // Re-read preferences whenever the user saves changes in the Preferences modal.
  useEffect(() => {
    const refresh = () => {
      api.getPrefs().then((prefs) => {
        shiftEnterRef.current = prefs.shiftEnterNewline
        cycleShortcutRef.current = prefs.cycleShortcut || 'ctrl+s'
        cycleWindowShortcutRef.current = prefs.cycleWindowShortcut || 'ctrl+shift+w'
      })
    }
    window.addEventListener('prefs-changed', refresh)
    return () => window.removeEventListener('prefs-changed', refresh)
  }, [])

  const handleRunClaude = () => {
    if (ptyIdRef.current) {
      api.writePty(ptyIdRef.current, 'claude\n')
    }
  }

  const handleResumeClaude = () => {
    setShowResume(false)
    // Give the shell a moment to show its prompt before sending the command
    setTimeout(() => {
      if (ptyIdRef.current) {
        const sessionId = useWorkspaceStore.getState().paneStates[paneId]?.claudeSessionId
        // Use --resume <id> when we have a specific session, otherwise --continue
        // (which picks up the most recently active session for this directory)
        const cmd = sessionId ? `claude --resume ${sessionId}` : 'claude --continue'
        api.writePty(ptyIdRef.current, cmd + '\n')
      }
    }, 600)
  }

  useEffect(() => {
    if (!containerRef.current) return

    setExited(false)
    exitedRef.current = false
    ptyIdRef.current = null
    closingRef.current = false
    restartingRef.current = false

    // Check for an existing PTY (split-induced remount) before reading restored state
    const existingPtyId = livePtyIds.get(paneId)

    // On a fresh mount (not a split reconnect), read the restored session state for this pane
    if (!existingPtyId) {
      const restoredState = useWorkspaceStore.getState().paneStates[paneId]
      if (restoredState?.hadClaude) {
        setShowResume(true)
      }
    }

    const term = new Terminal({
      fontFamily: '"Cascadia Code", "Fira Code", Menlo, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowTransparency: false,
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        cursorAccent: '#1e1e2e',
        selectionBackground: '#45475a80',
        black: '#45475a',   red: '#f38ba8',   green: '#a6e3a1',  yellow: '#f9e2af',
        blue: '#89b4fa',    magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
        brightBlack: '#585b70', brightRed: '#f38ba8',    brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af', brightBlue: '#89b4fa',  brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5',   brightWhite: '#a6adc8',
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon((_event, uri) => api.openUrl(uri)))
    // Clear any stale xterm DOM from a previous terminal on this container
    // (safety measure against partial-cleanup races on rapid remounts).
    containerRef.current.replaceChildren()
    term.open(containerRef.current)

    // Sync preferences
    api.getPrefs().then((prefs) => {
      shiftEnterRef.current = prefs.shiftEnterNewline
      cycleShortcutRef.current = prefs.cycleShortcut || 'ctrl+s'
      cycleWindowShortcutRef.current = prefs.cycleWindowShortcut || 'ctrl+shift+w'
    })

    // Track focus so the header highlights and cycling starts from the right terminal.
    // xterm v5 exposes focus via the underlying textarea element, not a Terminal event.
    const handleTermFocus = () => useWorkspaceStore.getState().setFocusedPane(paneId)
    term.textarea?.addEventListener('focus', handleTermFocus)

    // Shift+Enter → line break (same as Ctrl+J).
    // Must suppress all event types (keydown AND keypress) for Shift+Enter:
    // xterm only sets _keyDownHandled=true on the normal keydown path — when
    // our handler returns false the flag stays false, so xterm's _keyPress
    // handler fires and sends \r (submitting the input). Block keypress too.
    // Also prevent the cycle shortcut from being sent to the shell.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.shiftKey && shiftEnterRef.current) {
        if (e.type === 'keydown' && ptyIdRef.current) api.writePty(ptyIdRef.current, '\n')
        return false
      }
      if (e.type === 'keydown' && matchesShortcut(e, cycleShortcutRef.current)) {
        return false // Handled by the window-level keydown in App.tsx
      }
      if (e.type === 'keydown' && matchesShortcut(e, cycleWindowShortcutRef.current)) {
        return false // Handled by the window-level keydown in App.tsx
      }
      return true
    })

    const titleDisposable = term.onTitleChange((t) => {
      if (t) {
        livePtyOscTitles.set(paneId, t)
        setOscTitle(t)
      }
    })

    let ptyId: string | null = null
    let isMounted = true
    let onDataDisposable: { dispose: () => void } | null = null
    let removePtyData: (() => void) | null = null
    let removePtyExit: (() => void) | null = null
    let removeClaudeStatus: (() => void) | null = null

    // Register this terminal's focus function so the cycle handler can reach it
    registerTerminalFocus(paneId, () => term.focus())

    // Track the last cols/rows sent to the PTY backend so we can skip
    // resizePty calls when the grid dimensions haven't actually changed.
    // Declared here so both attachPty and the ResizeObserver can share it.
    let lastSentCols = 0
    let lastSentRows = 0

    // After a resize: if the viewport was at the bottom, keep it there.
    // If the user had scrolled up, let xterm reflow naturally — attempting to
    // recalculate an exact target line after reflow is fragile and causes jumps.
    const fitAndPreserveScroll = () => {
      const buf = term.buffer.active
      const atBottom = buf.length - buf.viewportY - term.rows <= 1
      fitAddon.fit()
      if (atBottom) term.scrollToBottom()
    }

    const attachPty = (id: string, isReconnect: boolean) => {
      if (!isMounted) {
        if (!isReconnect) api.killPty(id)
        return
      }
      ptyId = id
      ptyIdRef.current = id
      livePtyIds.set(paneId, id)
      // Split-induced remount: fit and preserve scroll before the ResizeObserver fires.
      // Fresh mount: fit so we know col/row count before sending to the PTY backend.
      if (isReconnect) {
        fitAndPreserveScroll()
      } else {
        fitAddon.fit()
      }
      api.resizePty(id, term.cols, term.rows)
      lastSentCols = term.cols
      lastSentRows = term.rows

      // On startup all terminals mount at once — only the top-left one should
      // keep focus so the user can type immediately without clicking first.
      // For split-induced remounts (isReconnect) the terminal was already active
      // so we leave focus wherever it is.
      if (!isReconnect) {
        const firstId = getFirstTerminalId(useWorkspaceStore.getState().rootPane)
        if (paneId === firstId) term.focus()
      }

      onDataDisposable = term.onData((data) => api.writePty(id, data))

      removePtyData = api.onPtyData((receivedId, data) => {
        if (receivedId === id) term.write(data)
      })

      removePtyExit = api.onPtyExit((receivedId) => {
        if (receivedId === id) {
          term.writeln('\r\n\x1b[90m[process exited]\x1b[0m')
          exitedRef.current = true
          setExited(true)
          setShowResume(false)
        }
      })

      // Subscribe to Claude Code status updates
      api.getClaudeStatus(id).then((s) => {
        if (isMounted) {
          livePtyStatuses.set(paneId, s)
          setClaudeStatus(s)
        }
      })
      removeClaudeStatus = api.onClaudeStatus((receivedId, status) => {
        if (receivedId === id) {
          livePtyStatuses.set(paneId, status)
          setClaudeStatus(status)
          // Once Claude actually starts running, the resume button is no longer needed
          if (status !== null) setShowResume(false)
        }
      })
    }

    if (existingPtyId) {
      attachPty(existingPtyId, true)
    } else {
      const savedCwd = useWorkspaceStore.getState().paneStates[paneId]?.cwd
      // Only restore a CWD that looks like a real path — saved OSC title strings
      // (e.g. "user@host:~") would otherwise override the configured default path.
      const restoredCwd = savedCwd && (savedCwd.startsWith('/') || savedCwd.startsWith('~/') || savedCwd === '~')
        ? savedCwd : undefined
      api.createPty({ cwd: restoredCwd }).then((id) => {
        attachPty(id, false)
      }).catch((err: unknown) => {
        if (isMounted) term.writeln(`\x1b[31mFailed to start terminal: ${String(err)}\x1b[0m`)
      })
    }

    // Fit the terminal synchronously on every ResizeObserver notification so
    // xterm is never at stale dimensions (no debounce here — browsers already
    // batch ResizeObserver callbacks to ~1/frame during drag, and fitting at
    // the wrong size for even 50 ms causes scroll-position drift).
    // Only the PTY backend resize is debounced (100 ms) to avoid flooding Rust
    // with resize RPCs on every animation frame during a pane drag.
    let ptyResizeTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      fitAndPreserveScroll()
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer)
      ptyResizeTimer = setTimeout(() => {
        const id = ptyIdRef.current
        if (id && (term.cols !== lastSentCols || term.rows !== lastSentRows)) {
          lastSentCols = term.cols
          lastSentRows = term.rows
          api.resizePty(id, term.cols, term.rows)
        }
      }, 100)
    })
    observer.observe(containerRef.current)

    return () => {
      isMounted = false
      ptyIdRef.current = null
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer)
      observer.disconnect()
      titleDisposable.dispose()
      term.textarea?.removeEventListener('focus', handleTermFocus)
      unregisterTerminalFocus(paneId)
      onDataDisposable?.dispose()
      removePtyData?.()
      removePtyExit?.()
      removeClaudeStatus?.()
      // Kill the PTY on intentional close/restart/exit, OR when the pane was removed
      // from the workspace tree (e.g. restore() swapped in a new layout) — but NOT on
      // a split-induced remount where the pane is still present in the tree.
      const paneInTree = isPaneInTree(useWorkspaceStore.getState().rootPane, paneId)
      if (ptyId && (closingRef.current || restartingRef.current || exitedRef.current || !paneInTree)) {
        api.killPty(ptyId)
        livePtyIds.delete(paneId)
        livePtyOscTitles.delete(paneId)
        livePtyStatuses.delete(paneId)
      }
      term.dispose()
    }
  }, [paneId, restartKey])

  const accentColor = useWorkspaceStore(s => s.accentColor)
  const focusColor = accentColor || '#89b4fa'

  return (
    <div
      className={`pane-wrapper${isFocused ? ' pane-wrapper--focused' : ''}`}
      style={isFocused ? { '--pane-focus-color': focusColor } as React.CSSProperties : undefined}
    >
      <div className="pane-header">
        <div className="pane-header-left">
          {editingLabel ? (
            <input
              ref={labelInputRef}
              className="pane-label-input"
              value={labelDraft}
              placeholder={defaultName}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitLabel()
                if (e.key === 'Escape') setEditingLabel(false)
              }}
            />
          ) : (
            <span className="pane-name" title="Double-click to rename" onDoubleClick={startEditing}>
              {displayName}
            </span>
          )}
          {!editingLabel && (() => {
            const cwd = claudeStatus?.cwdDisplay || oscTitle
            return cwd ? <span className="pane-cwd" title={cwd}>{cwd}</span> : null
          })()}
          {!editingLabel && claudeStatus?.branch && (
            <span className="pane-branch">{claudeStatus.branch}</span>
          )}
          {!editingLabel && displayStatus?.state === 'working' && displayStatus.activity && (
            <span className="pane-claude-activity">
              <span className="pane-claude-dot" />
              {displayStatus.activity}
            </span>
          )}
          {!editingLabel && displayStatus?.state === 'idle' && claudeSessionName && (
            <span className="pane-session-name" title="Idle Claude session">
              {claudeSessionName}
            </span>
          )}
          {displayStatus?.state !== 'working' && !editingLabel && (
            <button className="pane-run-claude-btn" onClick={handleRunClaude} title="Run Claude Code">
              ✦ claude
            </button>
          )}
          {showResume && !editingLabel && (
            <button className="pane-resume-btn" onClick={handleResumeClaude} title="Resume Claude session">
              ↩ Resume{claudeSessionName ? ` "${claudeSessionName}"` : ' Claude'}
            </button>
          )}
          {exited && !editingLabel && (
            <button className="pane-restart-btn" onClick={handleReset} title="Restart this terminal">
              restart
            </button>
          )}
        </div>
        <div className="pane-actions">
          <button className="pane-btn" title="Reset terminal" onClick={handleReset}>↺</button>
          {(oscTitle || claudeStatus?.cwdDisplay) && (
            <button
              className="pane-btn"
              title="Open folder in VS Code"
              onClick={(e) => {
                e.stopPropagation()
                api.openInVSCode(claudeStatus?.cwdDisplay || oscTitle)
              }}
            >
              ↗
            </button>
          )}
          <button className="pane-btn" title="Split right"
            onClick={(e) => { e.stopPropagation(); onSplit('horizontal') }}>⊞</button>
          <button className="pane-btn" title="Split down"
            onClick={(e) => { e.stopPropagation(); onSplit('vertical') }}>⊟</button>
          <button className="pane-btn pane-btn-close" title="Close pane"
            onClick={(e) => { e.stopPropagation(); handleClose() }}>✕</button>
        </div>
      </div>
      <div ref={containerRef} className="terminal-container" />
    </div>
  )
}
