import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))

vi.mock('../tauriAPI', () => ({
  getPrefs: vi.fn(),
  setPrefs: vi.fn(),
  pickFolder: vi.fn(),
}))

import * as api from '../tauriAPI'
import { PreferencesModal } from './PreferencesModal'

const defaultPrefs = {
  startingPath: '/home/user',
  apiKeyFromEnv: false,
  hasApiKey: false,
  shiftEnterNewline: true,
  cycleShortcut: 'ctrl+s',
  cycleWindowShortcut: 'ctrl+shift+w',
}

const onClose = vi.fn()

function renderModal() {
  return render(<PreferencesModal onClose={onClose} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getPrefs).mockResolvedValue({ ...defaultPrefs })
  vi.mocked(api.setPrefs).mockResolvedValue(undefined)
  vi.mocked(api.pickFolder).mockResolvedValue(null)
})

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('rendering', () => {
  it('renders the Preferences title', async () => {
    renderModal()
    expect(screen.getByText('Preferences')).toBeInTheDocument()
  })

  it('loads prefs on mount and populates fields', async () => {
    renderModal()
    await waitFor(() => {
      expect(screen.getByDisplayValue('/home/user')).toBeInTheDocument()
    })
    expect(api.getPrefs).toHaveBeenCalledOnce()
  })

  it('shows the cycle shortcut from prefs', async () => {
    vi.mocked(api.getPrefs).mockResolvedValue({ ...defaultPrefs, cycleShortcut: 'ctrl+tab' })
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    // ShortcutDisplay renders the key parts
    expect(screen.getByText('Tab')).toBeInTheDocument()
  })

  it('falls back to ctrl+s if cycleShortcut is empty', async () => {
    vi.mocked(api.getPrefs).mockResolvedValue({ ...defaultPrefs, cycleShortcut: '' })
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    expect(screen.getByText('S')).toBeInTheDocument()
  })
})

// ── Close button ──────────────────────────────────────────────────────────────

describe('close', () => {
  it('calls onClose when ✕ button is clicked', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    await userEvent.click(screen.getByText('✕'))
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when Cancel button is clicked', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    await userEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when clicking the modal overlay', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    const overlay = document.querySelector('.modal-overlay')!
    fireEvent.click(overlay, { target: overlay })
    expect(onClose).toHaveBeenCalled()
  })
})

// ── Starting path ─────────────────────────────────────────────────────────────

describe('starting path', () => {
  it('updates startingPath when typing', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    const input = screen.getByDisplayValue('/home/user')
    fireEvent.change(input, { target: { value: '/new/path' } })
    expect(screen.getByDisplayValue('/new/path')).toBeInTheDocument()
  })

  it('calls pickFolder and updates path on Browse click', async () => {
    vi.mocked(api.pickFolder).mockResolvedValue('/picked/folder')
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    await userEvent.click(screen.getByText('Browse…'))
    expect(api.pickFolder).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByDisplayValue('/picked/folder')).toBeInTheDocument()
    })
  })

  it('does not update path when pickFolder returns null', async () => {
    vi.mocked(api.pickFolder).mockResolvedValue(null)
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    await userEvent.click(screen.getByText('Browse…'))
    await waitFor(() => expect(api.pickFolder).toHaveBeenCalled())
    expect(screen.getByDisplayValue('/home/user')).toBeInTheDocument()
  })
})

// ── shiftEnterNewline toggle ──────────────────────────────────────────────────

describe('shiftEnterNewline', () => {
  it('toggles the checkbox', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    await userEvent.click(checkbox)
    expect(checkbox.checked).toBe(false)
  })
})

// ── Shortcut recording ────────────────────────────────────────────────────────

describe('shortcut recording', () => {
  it('shows "Press keys…" when the shortcut capture is focused', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    const capture = document.querySelector('.pref-shortcut-capture')!
    fireEvent.focus(capture)
    expect(screen.getByText('Press keys…')).toBeInTheDocument()
  })

  it('reverts to display mode on blur', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    const capture = document.querySelector('.pref-shortcut-capture')!
    fireEvent.focus(capture)
    fireEvent.blur(capture)
    expect(screen.queryByText('Press keys…')).not.toBeInTheDocument()
  })

  it('records a shortcut on keydown with modifier', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    const capture = document.querySelector('.pref-shortcut-capture')!
    fireEvent.focus(capture)
    fireEvent.keyDown(capture, { ctrlKey: true, key: 'k', altKey: false, metaKey: false, shiftKey: false })
    // Should exit recording mode and show the new shortcut
    expect(screen.queryByText('Press keys…')).not.toBeInTheDocument()
    expect(screen.getByText('K')).toBeInTheDocument()
  })

  it('cancels recording on Escape', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    const capture = document.querySelector('.pref-shortcut-capture')!
    fireEvent.focus(capture)
    fireEvent.keyDown(capture, { key: 'Escape' })
    expect(screen.queryByText('Press keys…')).not.toBeInTheDocument()
  })

  it('ignores standalone modifier keys', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    const capture = document.querySelector('.pref-shortcut-capture')!
    fireEvent.focus(capture)
    fireEvent.keyDown(capture, { key: 'Control' })
    // Still recording
    expect(screen.getByText('Press keys…')).toBeInTheDocument()
  })

  it('records shift modifier', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    const capture = document.querySelector('.pref-shortcut-capture')!
    fireEvent.focus(capture)
    fireEvent.keyDown(capture, { ctrlKey: true, shiftKey: true, key: 'a', altKey: false, metaKey: false })
    expect(screen.queryByText('Press keys…')).not.toBeInTheDocument()
  })
})

// ── API key section ───────────────────────────────────────────────────────────

describe('API key section', () => {
  it('shows key-from-env message when apiKeyFromEnv is true', async () => {
    vi.mocked(api.getPrefs).mockResolvedValue({ ...defaultPrefs, apiKeyFromEnv: true })
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    expect(screen.getByText(/Loaded from/)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/sk-ant/)).not.toBeInTheDocument()
  })

  it('shows input when apiKeyFromEnv is false', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    expect(screen.getByPlaceholderText(/sk-ant/)).toBeInTheDocument()
  })

  it('shows existing-key placeholder when hasApiKey is true', async () => {
    vi.mocked(api.getPrefs).mockResolvedValue({ ...defaultPrefs, hasApiKey: true })
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    expect(screen.getByPlaceholderText(/key saved/)).toBeInTheDocument()
  })

  it('updates apiKey when typing', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    const keyInput = screen.getByPlaceholderText(/sk-ant/) as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'sk-ant-test' } })
    expect(keyInput.value).toBe('sk-ant-test')
  })
})

// ── Save ──────────────────────────────────────────────────────────────────────

describe('save', () => {
  // Restore real timers after each test so fake timers don't bleed between tests.
  afterEach(() => vi.useRealTimers())

  it('calls setPrefs with correct args and shows ✓ Saved', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByText('✓ Saved')).toBeInTheDocument())
    expect(api.setPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ startingPath: '/home/user', shiftEnterNewline: true })
    )
    // onClose fires after the real 800ms setTimeout; wait up to 2s.
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2000 })
  }, 10000)

  it('includes apiKey in setPrefs when non-empty', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    const keyInput = screen.getByPlaceholderText(/sk-ant/) as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'sk-ant-mykey' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.setPrefs).toHaveBeenCalled())
    expect(api.setPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-ant-mykey' })
    )
  })

  it('does not include apiKey when input is empty', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.setPrefs).toHaveBeenCalled())
    const call = vi.mocked(api.setPrefs).mock.calls[0][0]
    expect(call).not.toHaveProperty('apiKey')
  })

  it('shows saveError when setPrefs throws', async () => {
    vi.mocked(api.setPrefs).mockRejectedValue(new Error('Disk full'))
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => {
      expect(screen.getByText(/Disk full/)).toBeInTheDocument()
    })
  })
})

// ── ShortcutDisplay helper ────────────────────────────────────────────────────

describe('ShortcutDisplay', () => {
  it('renders known modifier symbols', async () => {
    vi.mocked(api.getPrefs).mockResolvedValue({ ...defaultPrefs, cycleShortcut: 'ctrl+alt+shift+meta+s' })
    renderModal()
    await waitFor(() => screen.getByDisplayValue('/home/user'))
    // All modifiers should be rendered as symbols
    // ⌃ and ⇧ appear twice: once in ctrl+alt+shift+meta+s, once in the default ctrl+shift+w
    expect(screen.getAllByText('⌃')).toHaveLength(2)
    expect(screen.getByText('⌥')).toBeInTheDocument()
    expect(screen.getAllByText('⇧')).toHaveLength(2)
    expect(screen.getByText('⌘')).toBeInTheDocument()
    expect(screen.getByText('S')).toBeInTheDocument()
  })
})
