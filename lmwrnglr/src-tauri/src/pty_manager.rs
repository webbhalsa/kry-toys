use dirs::home_dir;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, ipc::Channel};
use tempfile::TempDir;

const MAX_BUFFER_LINES: usize = 150;

// ── Status types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub state: String,
    pub cwd: Option<String>,
    pub cwd_display: Option<String>,
    pub branch: Option<String>,
    pub tool: Option<String>,
    pub activity: Option<String>,
    pub session_id: Option<String>,
    pub ts: f64,
}

// ── Event payloads emitted to renderer ───────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyDataPayload {
    pub pty_id: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatusPayload {
    pub pty_id: String,
    pub status: Option<ClaudeStatus>,
}

// ── PTY entry ─────────────────────────────────────────────────────────────────

struct PtyEntry {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    window_label: String,
    pid: Option<u32>,
    output_buffer: Arc<Mutex<VecDeque<String>>>,
}

// ── PtyManager ────────────────────────────────────────────────────────────────

pub struct PtyManager {
    ptys: HashMap<String, PtyEntry>,
    zdotdir: Option<TempDir>,
}

impl PtyManager {
    pub fn new() -> Self {
        let zdotdir = setup_zdotdir();
        Self {
            ptys: HashMap::new(),
            zdotdir,
        }
    }

    pub fn create(
        &mut self,
        window_label: String,
        shell: Option<String>,
        cwd: String,
        on_data: Channel<PtyDataPayload>,
        on_exit: Channel<String>,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        // Generate a random 16-char hex pty id
        let pty_id: String = (0..8)
            .map(|_| format!("{:02x}", rand::random::<u8>()))
            .collect();

        let shell =
            shell.unwrap_or_else(|| std::env::var("SHELL").unwrap_or("/bin/zsh".to_string()));

        let home = home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let cwd_path = expand_tilde(&cwd, &home);
        let cwd_path = if cwd_path.exists() { cwd_path } else { home.clone() };

        let pty_system = NativePtySystem::default();
        let pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(&shell);
        // Launch as a login shell so macOS GUI apps pick up ~/.zprofile / ~/.bash_profile
        // (where Homebrew, nvm, etc. add themselves to PATH).
        // Safe with the ZDOTDIR shim: .zshenv always runs first, restores ZDOTDIR=$HOME,
        // and then the rest of the login startup sequence loads from the user's HOME.
        let is_login_capable = shell.ends_with("/zsh")
            || shell == "zsh"
            || shell.ends_with("/bash")
            || shell == "bash";
        if is_login_capable {
            cmd.arg("-l");
        }
        cmd.cwd(&cwd_path);

        // Inherit environment, add our vars
        for (k, v) in std::env::vars() {
            cmd.env(&k, &v);
        }
        if std::env::var("PATH").is_err() {
            cmd.env("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "lmwrnglr");
        cmd.env("SHELL_SESSION_HISTORY", "0");
        // Expose PTY ID so Claude Code hooks can write status files
        cmd.env("LMWRNGLR_PTY_ID", &pty_id);
        // Strip API keys — don't let them leak into terminal sessions
        cmd.env_remove("ANTHROPIC_API_KEY");
        cmd.env_remove("CLAUDE_WRANGLER_LLM_KEY");

        // Inject ZDOTDIR shim for zsh CWD title reporting
        if let Some(zdotdir) = &self.zdotdir {
            if shell.ends_with("/zsh") || shell == "zsh" {
                cmd.env("ZDOTDIR", zdotdir.path());
            }
        }

        let child = pair.slave.spawn_command(cmd)?;
        let pid = child.process_id();

        let writer = pair.master.take_writer()?;
        let reader = pair.master.try_clone_reader()?;

        let output_buffer: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        let output_buffer_task = Arc::clone(&output_buffer);

        let pty_id_task = pty_id.clone();

        // Use Tauri v2 Channels instead of app_handle.emit() for PTY data.
        // Channel.send() is a direct callback from Rust → JavaScript and works
        // reliably from any thread. app_handle.emit() (the global event bus) can
        // fail silently when called from background threads in Tauri v2.
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 4096];
            let mut reader = reader;
            // Carry over any incomplete multi-byte UTF-8 sequence from the
            // previous read so box-drawing chars and other non-ASCII bytes
            // split across read boundaries are decoded correctly.
            let mut incomplete: Vec<u8> = Vec::new();
            // Tracks the in-progress terminal line across chunks.  Only lines
            // terminated by \n are committed to the summary buffer, so
            // abandoned/deleted keystrokes never reach the LLM.
            let mut current_line: Vec<char> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        on_exit.send(pty_id_task.clone()).ok();
                        break;
                    }
                    Ok(n) => {
                        incomplete.extend_from_slice(&buf[..n]);

                        // Find the longest valid UTF-8 prefix of accumulated bytes.
                        let process_up_to = match std::str::from_utf8(&incomplete) {
                            Ok(_) => incomplete.len(),
                            Err(e) => {
                                if e.error_len().is_none() {
                                    // Incomplete sequence at end — defer to next read.
                                    e.valid_up_to()
                                } else {
                                    // Invalid (non-UTF-8) bytes — process all with lossy.
                                    incomplete.len()
                                }
                            }
                        };

                        let to_process: Vec<u8> = if process_up_to == incomplete.len() {
                            std::mem::take(&mut incomplete)
                        } else {
                            let chunk = incomplete[..process_up_to].to_vec();
                            incomplete = incomplete[process_up_to..].to_vec();
                            chunk
                        };

                        if to_process.is_empty() {
                            continue;
                        }

                        let data = String::from_utf8_lossy(&to_process).into_owned();
                        on_data
                            .send(PtyDataPayload {
                                pty_id: pty_id_task.clone(),
                                data,
                            })
                            .ok();

                        // Accumulate output for workspace summary.
                        //
                        // Strip ANSI escapes first, then simulate terminal line
                        // editing so that backspaced/abandoned keystrokes never
                        // appear in the buffer.  Only lines terminated by \n
                        // (i.e. completed output or submitted commands) are kept.
                        // \r is ignored — \r\n is the standard TTY line ending
                        // so \r always arrives just before a \n.
                        let stripped = strip_ansi_escapes::strip(&to_process);
                        let stripped_str = String::from_utf8_lossy(&stripped).into_owned();

                        let mut completed: Vec<String> = Vec::new();
                        for ch in stripped_str.chars() {
                            match ch {
                                '\n' => {
                                    let line: String = current_line.iter().collect();
                                    let trimmed = line.trim().to_string();
                                    if !trimmed.is_empty() {
                                        completed.push(trimmed);
                                    }
                                    current_line.clear();
                                }
                                '\r' => {} // ignored; \r\n is standard TTY line ending
                                '\x08' | '\x7f' => { current_line.pop(); } // backspace / delete
                                ch if ch.is_control() => {} // skip other control chars
                                ch => current_line.push(ch),
                            }
                        }

                        if !completed.is_empty() {
                            if let Ok(mut q) = output_buffer_task.lock() {
                                for line in completed {
                                    q.push_back(line);
                                }
                                while q.len() > MAX_BUFFER_LINES {
                                    q.pop_front();
                                }
                            }
                        }
                    }
                }
            }
        });

        self.ptys.insert(
            pty_id.clone(),
            PtyEntry {
                writer,
                master: pair.master,
                window_label,
                pid,
                output_buffer,
            },
        );

        Ok(pty_id)
    }

    pub fn write(&mut self, pty_id: &str, data: &str) -> std::io::Result<()> {
        if let Some(entry) = self.ptys.get_mut(pty_id) {
            entry.writer.write_all(data.as_bytes())?;
        }
        Ok(())
    }

    pub fn resize(&self, pty_id: &str, cols: u16, rows: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Some(entry) = self.ptys.get(pty_id) {
            entry.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        }
        Ok(())
    }

    pub fn kill(&mut self, pty_id: &str) {
        if let Some(entry) = self.ptys.remove(pty_id) {
            kill_process(entry.pid);
            cleanup_status_file(pty_id);
        }
    }

    pub fn kill_all_for_window(&mut self, window_label: &str) {
        let ids: Vec<String> = self
            .ptys
            .iter()
            .filter(|(_, e)| e.window_label == window_label)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(entry) = self.ptys.remove(&id) {
                kill_process(entry.pid);
                cleanup_status_file(&id);
            }
        }
    }

    pub fn has_subprocess(&self, pty_id: &str) -> bool {
        self.ptys
            .get(pty_id)
            .and_then(|e| e.pid)
            .map(|pid| {
                std::process::Command::new("pgrep")
                    .args(["-P", &pid.to_string()])
                    .output()
                    .map(|out| !out.stdout.is_empty())
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    pub fn window_has_subprocess(&self, window_label: &str) -> bool {
        self.ptys
            .iter()
            .filter(|(_, e)| e.window_label == window_label)
            .any(|(id, _)| self.has_subprocess(id))
    }

    pub fn get_recent_output(&self, pty_id: &str) -> String {
        self.ptys
            .get(pty_id)
            .map(|e| {
                e.output_buffer
                    .lock()
                    .map(|q| q.iter().cloned().collect::<Vec<_>>().join("\n"))
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }

    pub fn get_pty_ids_for_window(&self, window_label: &str) -> Vec<String> {
        self.ptys
            .iter()
            .filter(|(_, e)| e.window_label == window_label)
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn get_claude_status(&self, pty_id: &str) -> Option<ClaudeStatus> {
        let home = home_dir()?;
        let status_file = home
            .join(".lmwrnglr")
            .join("status")
            .join(format!("{}.json", pty_id));
        if !status_file.exists() {
            return None;
        }
        let raw = std::fs::read_to_string(&status_file).ok()?;
        let mut status: serde_json::Value = serde_json::from_str(&raw).ok()?;

        // Discard stale working entries (> 10 min) — handles Claude crashing mid-task.
        // Idle entries are a permanent final state and must never expire.
        let ts = status["ts"].as_f64().unwrap_or(0.0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        let state = status["state"].as_str().unwrap_or("");
        if state != "idle" && now - ts > 600.0 {
            return None;
        }

        // Compute tilde-abbreviated cwd_display
        let cwd = status["cwd"].as_str().map(|s| s.to_string());
        let cwd_display = cwd.as_deref().map(|c| {
            let home_str = home.to_string_lossy();
            if c == home_str.as_ref() {
                "~".to_string()
            } else if let Some(rest) = c.strip_prefix(&format!("{}/", home_str)) {
                format!("~/{}", rest)
            } else {
                c.to_string()
            }
        });
        status["cwd_display"] =
            serde_json::Value::String(cwd_display.clone().unwrap_or_default());

        let mut cs: ClaudeStatus = serde_json::from_value(status).ok()?;
        cs.cwd_display = cwd_display;
        Some(cs)
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn expand_tilde(path: &str, home: &PathBuf) -> PathBuf {
    if path.starts_with("~/") {
        home.join(&path[2..])
    } else if path == "~" {
        home.clone()
    } else {
        PathBuf::from(path)
    }
}

fn kill_process(pid: Option<u32>) {
    if let Some(pid) = pid {
        std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .spawn()
            .ok();
    }
}

fn cleanup_status_file(pty_id: &str) {
    if let Some(home) = home_dir() {
        let f = home
            .join(".lmwrnglr")
            .join("status")
            .join(format!("{}.json", pty_id));
        if f.exists() {
            std::fs::remove_file(f).ok();
        }
    }
}

// ── ZDOTDIR shim ──────────────────────────────────────────────────────────────

fn setup_zdotdir() -> Option<TempDir> {
    let dir = tempfile::tempdir().ok()?;

    // Strategy: keep ZDOTDIR as our temp dir for the entire shell lifetime so zsh
    // loads our proxy files (.zshenv/.zprofile/.zshrc/.zlogin) instead of the
    // user's directly. Each proxy sources the real user file first, then we append
    // _cw_title to precmd_functions *last* — after Oh My Zsh, Starship, Powerlevel10k,
    // etc. have added their own title-setting hooks — so our path title always wins.

    // .zshenv — runs for every zsh invocation (login, interactive, scripts).
    // Just proxy the user's .zshenv; do NOT restore ZDOTDIR here.
    let zshenv = r#"# lmwrnglr: proxy .zshenv
[[ -f "$HOME/.zshenv" ]] && builtin source "$HOME/.zshenv"
"#;

    // .zprofile — runs for login shells, before .zshrc.
    let zprofile = r#"# lmwrnglr: proxy .zprofile
[[ -f "$HOME/.zprofile" ]] && builtin source "$HOME/.zprofile"
"#;

    // .zshrc — runs for interactive shells.
    // Source the user's config first, then add _cw_title LAST so it overwrites
    // any OSC title set by the user's prompt framework (Oh My Zsh termsupport, etc.).
    let zshrc = r#"# lmwrnglr: proxy .zshrc, then inject CWD title reporter last
[[ -f "$HOME/.zshrc" ]] && builtin source "$HOME/.zshrc"
_cw_title() { printf '\033]0;%s\007' "${PWD/#$HOME/~}"; }
precmd_functions+=(_cw_title)
"#;

    // .zlogin — runs for login shells, after .zshrc.
    let zlogin = r#"# lmwrnglr: proxy .zlogin
[[ -f "$HOME/.zlogin" ]] && builtin source "$HOME/.zlogin"
"#;

    std::fs::write(dir.path().join(".zshenv"), zshenv).ok()?;
    std::fs::write(dir.path().join(".zprofile"), zprofile).ok()?;
    std::fs::write(dir.path().join(".zshrc"), zshrc).ok()?;
    std::fs::write(dir.path().join(".zlogin"), zlogin).ok()?;
    Some(dir)
}

// ── Hook script setup ────────────────────────────────────────────────────────

pub fn setup_lmwrnglr_dirs() {
    let Some(home) = home_dir() else { return };
    let base = home.join(".lmwrnglr");
    let hooks_dir = base.join("hooks");
    let status_dir = base.join("status");

    std::fs::create_dir_all(&hooks_dir).ok();
    std::fs::create_dir_all(&status_dir).ok();

    let pre_tool_use = r#"#!/usr/bin/env python3
"""lmwrnglr PreToolUse hook — writes Claude Code status to ~/.lmwrnglr/status/<pty-id>.json"""
import json, os, subprocess, sys, time

pty_id = os.environ.get('LMWRNGLR_PTY_ID')
if not pty_id:
    sys.exit(0)

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

cwd = data.get('cwd', '')
tool = data.get('tool_name', '')
tool_input = data.get('tool_input') or {}

branch = None
if cwd:
    try:
        r = subprocess.run(['git', '-C', cwd, 'branch', '--show-current'],
                           capture_output=True, text=True, timeout=2)
        if r.returncode == 0:
            branch = r.stdout.strip() or None
    except Exception:
        pass

if tool in ('Edit', 'Write', 'MultiEdit'):
    path = tool_input.get('file_path') or tool_input.get('path') or ''
    activity = f"Editing {os.path.basename(path)}" if path else tool
elif tool == 'Bash':
    cmd = (tool_input.get('command') or '').strip()
    activity = f"$ {cmd[:80]}" if cmd else 'Running command'
elif tool == 'Read':
    path = tool_input.get('file_path') or ''
    activity = f"Reading {os.path.basename(path)}" if path else 'Reading file'
elif tool == 'Grep':
    pat = tool_input.get('pattern') or ''
    activity = f"Searching for '{pat[:40]}'" if pat else 'Searching'
elif tool == 'Task':
    activity = 'Spawning agent'
elif tool:
    activity = tool
else:
    activity = 'Working'

status = {
    'state': 'working',
    'cwd': cwd,
    'branch': branch,
    'tool': tool,
    'activity': activity,
    'ts': time.time(),
}

status_dir = os.path.join(os.path.expanduser('~'), '.lmwrnglr', 'status')
os.makedirs(status_dir, exist_ok=True)
try:
    with open(os.path.join(status_dir, pty_id + '.json'), 'w') as f:
        json.dump(status, f)
except Exception:
    pass
"#;

    let stop_hook = r#"#!/usr/bin/env python3
"""lmwrnglr Stop hook — marks Claude Code as idle in ~/.lmwrnglr/status/<pty-id>.json"""
import json, os, subprocess, sys, time

pty_id = os.environ.get('LMWRNGLR_PTY_ID')
if not pty_id:
    sys.exit(0)

try:
    data = json.load(sys.stdin)
except Exception:
    data = {}

cwd = data.get('cwd', '')
session_id = data.get('session_id') or None

branch = None
if cwd:
    try:
        r = subprocess.run(['git', '-C', cwd, 'branch', '--show-current'],
                           capture_output=True, text=True, timeout=2)
        if r.returncode == 0:
            branch = r.stdout.strip() or None
    except Exception:
        pass

status = {
    'state': 'idle',
    'cwd': cwd,
    'branch': branch,
    'tool': None,
    'activity': None,
    'session_id': session_id,
    'ts': time.time(),
}

status_dir = os.path.join(os.path.expanduser('~'), '.lmwrnglr', 'status')
os.makedirs(status_dir, exist_ok=True)
try:
    with open(os.path.join(status_dir, pty_id + '.json'), 'w') as f:
        json.dump(status, f)
except Exception:
    pass
"#;

    std::fs::write(hooks_dir.join("pre-tool-use.py"), pre_tool_use).ok();
    std::fs::write(hooks_dir.join("stop.py"), stop_hook).ok();

    // Register our hooks in ~/.claude/settings.json so Claude Code runs them
    setup_claude_settings(&home, &hooks_dir);
}

// Configure Claude Code hooks in ~/.claude/settings.json.
// Adds PreToolUse + Stop hooks that write to ~/.lmwrnglr/status/.
// Idempotent: skips if our commands are already registered.
fn setup_claude_settings(home: &std::path::Path, hooks_dir: &std::path::Path) {
    let settings_path = home.join(".claude").join("settings.json");

    let pre_tool_cmd = format!("python3 {}", hooks_dir.join("pre-tool-use.py").display());
    let stop_cmd = format!("python3 {}", hooks_dir.join("stop.py").display());

    // Read existing settings or start with an empty object
    let mut settings: serde_json::Value = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    // Idempotency check: if any hook entry already references our hooks dir, we're done
    let marker = ".lmwrnglr/hooks";
    let already_registered = settings
        .get("hooks")
        .and_then(|h| h.as_object())
        .map(|hooks_map| {
            hooks_map.values().any(|event_arr| {
                event_arr.as_array().map(|entries| {
                    entries.iter().any(|entry| {
                        entry.get("hooks").and_then(|h| h.as_array()).map(|hs| {
                            hs.iter().any(|h| {
                                h.get("command")
                                    .and_then(|c| c.as_str())
                                    .map(|c| c.contains(marker))
                                    .unwrap_or(false)
                            })
                        }).unwrap_or(false)
                    })
                }).unwrap_or(false)
            })
        })
        .unwrap_or(false);

    if already_registered {
        return;
    }

    // Ensure settings is an object (guard against corrupt file)
    if !settings.is_object() {
        settings = serde_json::json!({});
    }

    let hooks = settings
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert(serde_json::json!({}));

    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }

    let hooks_obj = hooks.as_object_mut().unwrap();

    // PreToolUse: matcher ".*" catches all tools
    let pre_entry = serde_json::json!({
        "matcher": ".*",
        "hooks": [{"type": "command", "command": pre_tool_cmd}]
    });
    hooks_obj
        .entry("PreToolUse")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .unwrap()
        .push(pre_entry);

    // Stop: no matcher needed
    let stop_entry = serde_json::json!({
        "hooks": [{"type": "command", "command": stop_cmd}]
    });
    hooks_obj
        .entry("Stop")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .unwrap()
        .push(stop_entry);

    // Write back, preserving all existing settings
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if let Ok(json) = serde_json::to_string_pretty(&settings) {
        std::fs::write(&settings_path, json).ok();
    }
}

// ── fs::watch for Claude Code status files ────────────────────────────────────

pub fn watch_status_dir(app_handle: AppHandle) -> Option<notify::RecommendedWatcher> {
    use notify::{EventKind, RecursiveMode, Watcher};

    let Some(home) = home_dir() else { return None };
    let status_dir = home.join(".lmwrnglr").join("status");

    let mut watcher = notify::RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_)
            ) {
                return;
            }
            for path in &event.paths {
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let pty_id = stem.to_string();
                // Re-read the status and broadcast to all windows
                let status = read_claude_status_file(path);
                app_handle
                    .emit(
                        "claude-status-update",
                        ClaudeStatusPayload {
                            pty_id,
                            status,
                        },
                    )
                    .ok();
            }
        },
        notify::Config::default(),
    )
    .ok()?;

    watcher.watch(&status_dir, RecursiveMode::NonRecursive).ok()?;
    Some(watcher)
}

fn read_claude_status_file(path: &std::path::Path) -> Option<ClaudeStatus> {
    let raw = std::fs::read_to_string(path).ok()?;
    let mut status: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let ts = status["ts"].as_f64().unwrap_or(0.0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    // Only discard stale working entries — idle is a permanent final state.
    let state = status["state"].as_str().unwrap_or("");
    if state != "idle" && now - ts > 600.0 {
        return None;
    }
    let home = home_dir()?;
    let home_str = home.to_string_lossy();
    let cwd = status["cwd"].as_str().map(|s| s.to_string());
    let cwd_display = cwd.as_deref().map(|c| {
        if c == home_str.as_ref() {
            "~".to_string()
        } else if let Some(rest) = c.strip_prefix(&format!("{}/", home_str)) {
            format!("~/{}", rest)
        } else {
            c.to_string()
        }
    });
    status["cwd_display"] =
        serde_json::Value::String(cwd_display.clone().unwrap_or_default());
    let mut cs: ClaudeStatus = serde_json::from_value(status).ok()?;
    cs.cwd_display = cwd_display;
    Some(cs)
}
