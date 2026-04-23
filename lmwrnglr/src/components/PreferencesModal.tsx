import { useState, useEffect, useRef } from 'react'
import * as api from '../tauriAPI'

interface Props {
  onClose: () => void
}

function formatShortcutPart(part: string): string {
  const map: Record<string, string> = {
    ctrl: '⌃', alt: '⌥', meta: '⌘', shift: '⇧',
    tab: 'Tab', escape: 'Esc', enter: '↩', backspace: '⌫',
    arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
    ' ': 'Space',
  }
  return map[part] || part.toUpperCase()
}

function ShortcutDisplay({ shortcut }: { shortcut: string }) {
  const parts = shortcut.split('+')
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          {i > 0 && <span className="shortcut-sep">+</span>}
          <kbd className="shortcut-key">{formatShortcutPart(p)}</kbd>
        </span>
      ))}
    </>
  )
}

type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string; notes: string | null }
  | { phase: 'upToDate'; version: string }
  | { phase: 'installing' }
  | { phase: 'error'; message: string }

export function PreferencesModal({ onClose }: Props) {
  const [startingPath, setStartingPath] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiKeyFromEnv, setApiKeyFromEnv] = useState(false)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [shiftEnterNewline, setShiftEnterNewline] = useState(true)
  const [cycleShortcut, setCycleShortcut] = useState('ctrl+s')
  const [cycleWindowShortcut, setCycleWindowShortcut] = useState('ctrl+shift+w')
  const [recordingWhich, setRecordingWhich] = useState<'terminals' | 'windows' | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>({ phase: 'idle' })
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.getPrefs().then((prefs) => {
      setStartingPath(prefs.startingPath)
      setApiKeyFromEnv(prefs.apiKeyFromEnv)
      setHasApiKey(prefs.hasApiKey)
      setShiftEnterNewline(prefs.shiftEnterNewline)
      setCycleShortcut(prefs.cycleShortcut || 'ctrl+s')
      setCycleWindowShortcut(prefs.cycleWindowShortcut || 'ctrl+shift+w')
    })
  }, [])

  const handleShortcutKeyDown = (which: 'terminals' | 'windows') => (e: React.KeyboardEvent) => {
    if (recordingWhich !== which) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') { setRecordingWhich(null); return }
    if (['Control', 'Alt', 'Meta', 'Shift'].includes(e.key)) return
    const parts: string[] = []
    if (e.ctrlKey) parts.push('ctrl')
    if (e.altKey) parts.push('alt')
    if (e.metaKey) parts.push('meta')
    if (e.shiftKey) parts.push('shift')
    parts.push(e.key.toLowerCase())
    const shortcut = parts.join('+')
    if (which === 'terminals') setCycleShortcut(shortcut)
    else setCycleWindowShortcut(shortcut)
    setRecordingWhich(null)
  }

  const pickFolder = async () => {
    const path = await api.pickFolder()
    if (path) setStartingPath(path)
  }

  const checkUpdates = async () => {
    setUpdateState({ phase: 'checking' })
    try {
      const info = await api.checkForUpdates()
      if (info.available && info.latestVersion) {
        setUpdateState({ phase: 'available', version: info.latestVersion, notes: info.releaseNotes })
      } else {
        setUpdateState({ phase: 'upToDate', version: info.currentVersion })
      }
    } catch (e) {
      setUpdateState({ phase: 'error', message: String(e) })
    }
  }

  const doInstallUpdate = async () => {
    setUpdateState({ phase: 'installing' })
    try {
      await api.installUpdate()
      // installUpdate restarts the app — if we get here something went wrong
      setUpdateState({ phase: 'error', message: 'Install completed but app did not restart. Please relaunch manually.' })
    } catch (e) {
      setUpdateState({ phase: 'error', message: String(e) })
    }
  }

  const save = async () => {
    setSaveError(null)
    try {
      await api.setPrefs({
        startingPath,
        shiftEnterNewline,
        cycleShortcut,
        cycleWindowShortcut,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      window.dispatchEvent(new CustomEvent('prefs-changed'))
      setSaved(true)
      setTimeout(() => { setSaved(false); onClose() }, 800)
    } catch (e) {
      setSaveError(String(e))
    }
  }

  return (
    <div
      className="modal-overlay"
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
    >
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Preferences</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="pref-section">
            <label className="pref-label">Default starting directory</label>
            <p className="pref-hint">New terminal panes open here. Leave blank to use your home directory.</p>
            <div className="pref-row">
              <input
                className="pref-input"
                value={startingPath}
                onChange={(e) => setStartingPath(e.target.value)}
                placeholder="~ (home directory)"
              />
              <button className="pref-browse-btn" onClick={pickFolder}>Browse…</button>
            </div>
          </div>

          <div className="pref-section">
            <label className="pref-label">Keyboard shortcuts</label>
            <label className="pref-checkbox-row">
              <input
                type="checkbox"
                checked={shiftEnterNewline}
                onChange={(e) => setShiftEnterNewline(e.target.checked)}
              />
              <span>
                <strong>Shift+Enter</strong> inserts a line break
                <span className="pref-hint pref-hint--inline">
                  Useful for multi-line Claude Code prompts (same as Ctrl+J)
                </span>
              </span>
            </label>

            <div className="pref-shortcut-row">
              <span className="pref-shortcut-label">Cycle terminals</span>
              <div
                className={`pref-shortcut-capture${recordingWhich === 'terminals' ? ' pref-shortcut-capture--recording' : ''}`}
                tabIndex={0}
                onFocus={() => setRecordingWhich('terminals')}
                onBlur={() => setRecordingWhich(null)}
                onKeyDown={handleShortcutKeyDown('terminals')}
                title="Click then press a key combination"
              >
                {recordingWhich === 'terminals'
                  ? <span style={{ fontStyle: 'italic', color: '#f38ba8' }}>Press keys…</span>
                  : <ShortcutDisplay shortcut={cycleShortcut} />
                }
              </div>
            </div>

            <div className="pref-shortcut-row">
              <span className="pref-shortcut-label">Cycle windows</span>
              <div
                className={`pref-shortcut-capture${recordingWhich === 'windows' ? ' pref-shortcut-capture--recording' : ''}`}
                tabIndex={0}
                onFocus={() => setRecordingWhich('windows')}
                onBlur={() => setRecordingWhich(null)}
                onKeyDown={handleShortcutKeyDown('windows')}
                title="Click then press a key combination"
              >
                {recordingWhich === 'windows'
                  ? <span style={{ fontStyle: 'italic', color: '#f38ba8' }}>Press keys…</span>
                  : <ShortcutDisplay shortcut={cycleWindowShortcut} />
                }
              </div>
            </div>
          </div>

          <div className="pref-section">
            <label className="pref-label">Updates</label>
            <div className="pref-update-row">
              {updateState.phase === 'idle' && (
                <button className="pref-browse-btn" onClick={checkUpdates}>
                  Check for Updates
                </button>
              )}
              {updateState.phase === 'checking' && (
                <button className="pref-browse-btn" disabled>Checking…</button>
              )}
              {updateState.phase === 'upToDate' && (
                <>
                  <span className="pref-hint pref-hint--ok">✓ Up to date (v{updateState.version})</span>
                  <button className="pref-browse-btn" style={{ marginLeft: 8 }} onClick={checkUpdates}>
                    Check Again
                  </button>
                </>
              )}
              {updateState.phase === 'available' && (
                <>
                  <button
                    className="pref-browse-btn pref-browse-btn--update"
                    onClick={doInstallUpdate}
                  >
                    Install v{updateState.version} &amp; Restart
                  </button>
                  {updateState.notes && (
                    <span className="pref-hint" style={{ marginLeft: 8 }}>{updateState.notes}</span>
                  )}
                </>
              )}
              {updateState.phase === 'installing' && (
                <button className="pref-browse-btn" disabled>Installing…</button>
              )}
              {updateState.phase === 'error' && (
                <>
                  <button className="pref-browse-btn" onClick={checkUpdates}>Check for Updates</button>
                  <span className="pref-hint" style={{ marginLeft: 8, color: '#f38ba8' }}>
                    {updateState.message}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="pref-section">
            <label className="pref-label">Anthropic API key</label>
            {apiKeyFromEnv ? (
              <p className="pref-hint pref-hint--ok">
                ✓ Loaded from <code>CLAUDE_WRANGLER_LLM_KEY</code> environment variable.
                Unset it to use a stored key instead.
              </p>
            ) : (
              <>
                <p className="pref-hint">
                  Used for the workspace summary feature. Store the key here, or set{' '}
                  <code>CLAUDE_WRANGLER_LLM_KEY</code> in your shell profile (<code>~/.zshrc</code>,{' '}
                  <code>~/.zprofile</code>, etc.).
                </p>
                <input
                  className="pref-input pref-input--mono"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={hasApiKey ? '(key saved — enter new key to replace)' : 'sk-ant-…'}
                />
              </>
            )}
          </div>
        </div>

        <div className="modal-footer">
          {saveError && <span style={{ color: '#f38ba8', fontSize: 12, flex: 1 }}>{saveError}</span>}
          <button className="modal-btn modal-btn--cancel" onClick={onClose}>Cancel</button>
          <button className="modal-btn modal-btn--save" onClick={save}>
            {saved ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
