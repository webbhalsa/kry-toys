mod config_store;
mod pty_manager;
mod session_store;

use config_store::ConfigStore;
use pty_manager::{ClaudeStatus, PtyManager};
use session_store::{new_wid, RestoreableSession, SavedSession, SessionStore, WorkspaceSession};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    pty_manager: Mutex<PtyManager>,
    config_store: Mutex<ConfigStore>,
    session_store: Mutex<SessionStore>,
    // Keep the fs watcher alive for the process lifetime
    _watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

// ── PTY commands ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePtyOptions {
    shell: Option<String>,
    cwd: Option<String>,
}

#[tauri::command]
async fn create_pty(
    window: tauri::Window,
    state: State<'_, AppState>,
    options: CreatePtyOptions,
    on_data: tauri::ipc::Channel<pty_manager::PtyDataPayload>,
    on_exit: tauri::ipc::Channel<String>,
) -> Result<String, String> {
    let cwd = {
        let config = state.config_store.lock().map_err(|e| e.to_string())?;
        let default = config.get_starting_path();
        // Validate the provided cwd: expand tilde and check it's a real directory.
        // If it's invalid (e.g. a stale OSC title string like "user@host:~"), fall
        // back to the configured default so the user's preference is respected.
        options.cwd
            .filter(|c| {
                let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"));
                let p = if c.starts_with("~/") {
                    home.join(&c[2..])
                } else if c == "~" {
                    home
                } else {
                    std::path::PathBuf::from(c)
                };
                p.is_dir()
            })
            .unwrap_or(default)
    };
    state
        .pty_manager
        .lock()
        .map_err(|e| e.to_string())?
        .create(window.label().to_string(), options.shell, cwd, on_data, on_exit)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn write_pty(state: State<'_, AppState>, pty_id: String, data: String) -> Result<(), String> {
    state
        .pty_manager
        .lock()
        .map_err(|e| e.to_string())?
        .write(&pty_id, &data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn resize_pty(
    state: State<'_, AppState>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .pty_manager
        .lock()
        .map_err(|e| e.to_string())?
        .resize(&pty_id, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn kill_pty(state: State<'_, AppState>, pty_id: String) {
    if let Ok(mut m) = state.pty_manager.lock() {
        m.kill(&pty_id);
    }
}

#[tauri::command]
fn pty_has_subprocess(state: State<'_, AppState>, pty_id: String) -> bool {
    state
        .pty_manager
        .lock()
        .map(|m| m.has_subprocess(&pty_id))
        .unwrap_or(false)
}

#[tauri::command]
fn kill_all_ptys(window: tauri::Window, state: State<'_, AppState>) -> Result<(), String> {
    state
        .pty_manager
        .lock()
        .map_err(|e| e.to_string())?
        .kill_all_for_window(window.label());
    Ok(())
}

#[tauri::command]
fn window_has_subprocess(window: tauri::Window, state: State<'_, AppState>) -> bool {
    state
        .pty_manager
        .lock()
        .map(|m| m.window_has_subprocess(window.label()))
        .unwrap_or(false)
}

#[tauri::command]
fn get_claude_status(state: State<'_, AppState>, pty_id: String) -> Option<ClaudeStatus> {
    state
        .pty_manager
        .lock()
        .ok()
        .and_then(|m| m.get_claude_status(&pty_id))
}

// ── Window commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn start_dragging(window: tauri::Window) {
    window.start_dragging().ok();
}

#[tauri::command]
fn toggle_maximize(window: tauri::Window) {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().ok();
    } else {
        window.maximize().ok();
    }
}

#[tauri::command]
fn set_window_title(window: tauri::Window, title: String) {
    let _ = window.set_title(&title);
}

fn build_workspace_window(
    app: &AppHandle,
    wid: &str,
) -> Result<(), String> {
    tauri::WebviewWindowBuilder::new(
        app,
        format!("workspace-{}", rand::random::<u32>()),
        tauri::WebviewUrl::App(format!("index.html?wid={}", wid).into()),
    )
    .title("lmwrnglr")
    .inner_size(1200.0, 800.0)
    .min_inner_size(500.0, 400.0)
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true)
    .build()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Open a blank new workspace window. A fresh WID is generated and embedded in
/// the URL so the window has a stable session identity from birth.
#[tauri::command]
fn open_new_window(app: AppHandle) -> Result<(), String> {
    build_workspace_window(&app, &new_wid())
}

/// Reopen a previously-saved workspace (recent or named) in a new window.
#[tauri::command]
fn open_window_with_wid(app: AppHandle, wid: String) -> Result<(), String> {
    build_workspace_window(&app, &wid)
}

/// Copy a named saved session into workspaces, then open it in a new window.
#[tauri::command]
fn open_saved_session_in_new_window(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let wid = state
        .session_store
        .lock()
        .map_err(|e| e.to_string())?
        .stage_saved_as_workspace(&id)
        .ok_or_else(|| format!("saved session '{}' not found", id))?;
    build_workspace_window(&app, &wid)
}

/// Return all WIDs that currently have an open window.
#[tauri::command]
fn list_open_workspaces(state: State<'_, AppState>) -> Vec<String> {
    state.session_store.lock().map(|s| s.get_open_wids()).unwrap_or_default()
}

/// Return workspace sessions for all currently open windows.
#[tauri::command]
fn get_open_sessions(state: State<'_, AppState>) -> Vec<RestoreableSession> {
    state.session_store.lock().map(|s| s.get_open_sessions()).unwrap_or_default()
}

/// Focus the window that owns the given WID.
#[tauri::command]
fn focus_workspace(app: AppHandle, state: State<'_, AppState>, wid: String) -> Result<(), String> {
    let label = {
        let s = state.session_store.lock().map_err(|e| e.to_string())?;
        s.label_for_wid(&wid).map(str::to_string)
    };
    let Some(label) = label else {
        return Ok(()); // Window no longer open — silently ignore
    };
    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── URL / browser command ─────────────────────────────────────────────────────

/// Open a URL in the system default browser.  Only http/https are accepted so
/// this cannot be abused to launch arbitrary shell commands via custom schemes.
#[tauri::command]
fn open_url(url: String) {
    if url.starts_with("https://") || url.starts_with("http://") {
        std::process::Command::new("open").arg(&url).spawn().ok();
    }
}

// ── VS Code command ───────────────────────────────────────────────────────────

#[tauri::command]
fn open_in_vscode(path: String) {
    let home = dirs::home_dir().unwrap_or_default();
    let expanded = if path.starts_with("~/") {
        home.join(&path[2..])
    } else if path == "~" {
        home
    } else {
        std::path::PathBuf::from(&path)
    };
    let s = expanded.to_string_lossy().into_owned();

    // GUI apps on macOS don't inherit the user's full shell PATH, so `code`
    // won't resolve even if it's installed. Check the common install locations.
    let code_candidates = [
        "/usr/local/bin/code",
        "/opt/homebrew/bin/code",
        "/usr/bin/code",
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    ];
    let code_path = code_candidates.iter().find(|p| std::path::Path::new(p).exists()).copied();

    if let Some(code) = code_path {
        if std::process::Command::new(code).args(["--new-window", &s]).spawn().is_ok() {
            return;
        }
    }

    // Fallback: open the folder directly via macOS open. Do NOT pass --args here —
    // `open -a` passes arguments to the Electron binary, not the `code` CLI, so
    // --new-window is silently ignored and VS Code just focuses an existing window.
    std::process::Command::new("open")
        .args(["-a", "Visual Studio Code", &s])
        .spawn()
        .ok();
}

// ── Config / Preferences ──────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Prefs {
    starting_path: String,
    api_key_from_env: bool,
    has_api_key: bool,
    shift_enter_newline: bool,
    cycle_shortcut: String,
    cycle_window_shortcut: String,
}

#[tauri::command]
fn get_prefs(state: State<'_, AppState>) -> Result<Prefs, String> {
    let c = state.config_store.lock().map_err(|e| e.to_string())?;
    Ok(Prefs {
        starting_path: c.get_stored_starting_path(),
        api_key_from_env: c.api_key_from_env(),
        has_api_key: c.has_api_key(),
        shift_enter_newline: c.get_shift_enter_newline(),
        cycle_shortcut: c.get_cycle_shortcut(),
        cycle_window_shortcut: c.get_cycle_window_shortcut(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPrefsArgs {
    starting_path: Option<String>,
    api_key: Option<String>,
    shift_enter_newline: Option<bool>,
    cycle_shortcut: Option<String>,
    cycle_window_shortcut: Option<String>,
}

#[tauri::command]
fn set_prefs(state: State<'_, AppState>, prefs: SetPrefsArgs) -> Result<(), String> {
    let mut c = state.config_store.lock().map_err(|e| e.to_string())?;
    if let Some(p) = prefs.starting_path {
        c.set_starting_path(p);
    }
    if let Some(k) = prefs.api_key {
        c.set_api_key(k);
    }
    if let Some(v) = prefs.shift_enter_newline {
        c.set_shift_enter_newline(v);
    }
    if let Some(v) = prefs.cycle_shortcut {
        c.set_cycle_shortcut(v);
    }
    if let Some(v) = prefs.cycle_window_shortcut {
        c.set_cycle_window_shortcut(v);
    }
    c.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn has_api_key(state: State<'_, AppState>) -> bool {
    state
        .config_store
        .lock()
        .map(|c| c.has_api_key())
        .unwrap_or(false)
}

#[tauri::command]
fn set_api_key(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let mut c = state.config_store.lock().map_err(|e| e.to_string())?;
    c.set_api_key(key);
    c.save().map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_folder(window: tauri::Window) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    window
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

// ── Session commands ──────────────────────────────────────────────────────────

/// Register this window as owning the given WID. Called once on startup so the
/// WID is excluded from the restoreable list while the window is open.
#[tauri::command]
fn register_workspace(window: tauri::Window, state: State<'_, AppState>, wid: String) {
    if let Ok(mut s) = state.session_store.lock() {
        s.register_open(window.label(), &wid);
    }
}

/// Load the saved session for a WID, or None if this is a fresh workspace.
#[tauri::command]
fn load_session(state: State<'_, AppState>, wid: String) -> Option<WorkspaceSession> {
    state.session_store.lock().ok().and_then(|s| s.load_for_wid(&wid))
}

/// Persist the current workspace state for a WID (called continuously by the frontend).
#[tauri::command]
fn save_session(
    state: State<'_, AppState>,
    wid: String,
    session: WorkspaceSession,
) -> Result<(), String> {
    state
        .session_store
        .lock()
        .map_err(|e| e.to_string())?
        .save_for_wid(&wid, session)
        .map_err(|e| e.to_string())
}

/// Return all workspace sessions that are not currently open.
#[tauri::command]
fn get_restoreable_sessions(state: State<'_, AppState>) -> Vec<RestoreableSession> {
    state.session_store.lock().map(|s| s.get_restoreable()).unwrap_or_default()
}

/// Delete a workspace session (auto-saved). Does not affect named saved sessions.
#[tauri::command]
fn delete_workspace_session(state: State<'_, AppState>, wid: String) -> Result<(), String> {
    state
        .session_store
        .lock()
        .map_err(|e| e.to_string())?
        .delete_workspace(&wid)
        .map_err(|e| e.to_string())
}

/// Save the current workspace as a named session. Returns the generated ID.
#[tauri::command]
fn save_named_session(
    state: State<'_, AppState>,
    session: WorkspaceSession,
) -> Result<String, String> {
    let id = format!("saved-{}", new_wid());
    state
        .session_store
        .lock()
        .map_err(|e| e.to_string())?
        .save_named(&id, session)
        .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Rename a saved session in place.
#[tauri::command]
fn rename_saved_session(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    state
        .session_store
        .lock()
        .map_err(|e| e.to_string())?
        .rename_saved(&id, name)
        .map_err(|e| e.to_string())
}

/// Return all named saved sessions.
#[tauri::command]
fn list_saved_sessions(state: State<'_, AppState>) -> Vec<SavedSession> {
    state.session_store.lock().map(|s| s.list_saved()).unwrap_or_default()
}

/// Delete a named saved session permanently.
#[tauri::command]
fn delete_saved_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .session_store
        .lock()
        .map_err(|e| e.to_string())?
        .delete_saved(&id)
        .map_err(|e| e.to_string())
}

// ── Summary command ───────────────────────────────────────────────────────────

#[tauri::command]
async fn generate_summary(
    window: tauri::Window,
    state: State<'_, AppState>,
    workspace_name: String,
) -> Result<serde_json::Value, String> {
    let (api_key, sections) = {
        let config = state.config_store.lock().map_err(|e| e.to_string())?;
        let api_key = config
            .get_api_key()
            .ok_or_else(|| "no-api-key".to_string())?;
        let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
        let ids = manager.get_pty_ids_for_window(window.label());
        if ids.is_empty() {
            return Ok(serde_json::json!({ "summary": "No active terminals." }));
        }
        let sections: Vec<String> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let output = manager.get_recent_output(id);
                let cs = manager.get_claude_status(id);
                let mut header = format!("Terminal {}", i + 1);
                if let Some(cs) = &cs {
                    let parts: Vec<&str> = [cs.cwd_display.as_deref(), cs.branch.as_deref()]
                        .iter()
                        .filter_map(|x| *x)
                        .collect();
                    if !parts.is_empty() {
                        header.push_str(&format!(" ({})", parts.join(", ")));
                    }
                    if cs.state == "working" {
                        if let Some(act) = &cs.activity {
                            header.push_str(&format!(" — Claude: {}", act));
                        }
                    }
                }
                format!(
                    "{}:\n{}",
                    header,
                    if output.is_empty() {
                        "(no output yet)".to_string()
                    } else {
                        output
                    }
                )
            })
            .collect();
        (api_key, sections)
    };

    let n = sections.len();
    let content = sections.join("\n\n---\n\n");
    let prompt = format!(
        "Summarize what's happening across {} terminal session(s) in the \"{}\" workspace.\n\n\
         Recent terminal output:\n\n{}\n\n\
         Write 1-3 concise sentences. Focus on what commands/tools are running and what the \
         developer is working on. Be specific.",
        n, workspace_name, content
    );

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 200,
        "messages": [{ "role": "user", "content": prompt }]
    });

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let json = resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
    let text = json["content"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string();
    Ok(serde_json::json!({ "summary": text }))
}

// ── Auto-update ───────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    available: bool,
    current_version: String,
    latest_version: Option<String>,
    release_notes: Option<String>,
}

fn get_gh_token() -> Option<String> {
    // Tauri .app bundles on macOS don't inherit the shell PATH, so `gh` won't
    // be found by name alone.  Try well-known Homebrew / system locations too.
    let candidates = [
        "gh",
        "/opt/homebrew/bin/gh",   // Homebrew – Apple Silicon
        "/usr/local/bin/gh",      // Homebrew – Intel / older installs
        "/home/linuxbrew/.linuxbrew/bin/gh", // Linux Homebrew
    ];
    candidates.iter().find_map(|gh| {
        std::process::Command::new(gh)
            .args(["auth", "token"])
            .output()
            .ok()
            .and_then(|out| {
                if out.status.success() {
                    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !token.is_empty() { Some(token) } else { None }
                } else {
                    None
                }
            })
    })
}

/// Returns the GitHub API URL for the `latest.json` asset of the most recent
/// non-prerelease lmwrnglr release.  Uses the API URL (not browser_download_url)
/// so Bearer-token auth works when the repo is private.
async fn get_latest_manifest_url(token: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let releases: Vec<serde_json::Value> = client
        .get("https://api.github.com/repos/webbhalsa/kry-tools/releases?per_page=20")
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "lmwrnglr-updater")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let release = releases
        .iter()
        .find(|r| {
            r["tag_name"]
                .as_str()
                .map(|t| t.starts_with("lmwrnglr/v"))
                .unwrap_or(false)
                && !r["prerelease"].as_bool().unwrap_or(false)
        })
        .ok_or_else(|| "No lmwrnglr releases found on GitHub.".to_string())?;

    release["assets"]
        .as_array()
        .and_then(|assets| {
            assets
                .iter()
                .find(|a| a["name"].as_str() == Some("latest.json"))
                .and_then(|a| a["url"].as_str().map(str::to_string))
        })
        .ok_or_else(|| {
            "No update manifest found in release. \
             Update signing may not be configured yet \
             (TAURI_SIGNING_PRIVATE_KEY secret missing)."
                .to_string()
        })
}

fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> (u64, u64, u64) {
        let parts: Vec<u64> = v
            .split('.')
            .map(|p| p.split(['-', '+']).next().unwrap_or("0").parse().unwrap_or(0))
            .collect();
        (
            *parts.first().unwrap_or(&0),
            *parts.get(1).unwrap_or(&0),
            *parts.get(2).unwrap_or(&0),
        )
    };
    parse(latest) > parse(current)
}

/// Check GitHub for a newer lmwrnglr release.  Requires `gh` CLI to be
/// authenticated so we can access the private repo's release assets.
#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    let token = get_gh_token().ok_or_else(|| {
        "gh CLI not found or not authenticated. Run `gh auth login` to enable updates.".to_string()
    })?;

    let manifest_url = get_latest_manifest_url(&token).await?;

    let client = reqwest::Client::new();
    let manifest: serde_json::Value = client
        .get(&manifest_url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/octet-stream")
        .header("User-Agent", "lmwrnglr-updater")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let latest_version = manifest["version"].as_str().map(str::to_string);
    let release_notes = manifest["notes"].as_str().map(str::to_string);
    let available = latest_version
        .as_deref()
        .map(|v| is_newer(v, &current_version))
        .unwrap_or(false);

    Ok(UpdateInfo { available, current_version, latest_version, release_notes })
}

/// Download and install the latest lmwrnglr release, then restart the app.
/// Uses the Tauri updater for signature verification and in-place bundle swap.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let token = get_gh_token()
        .ok_or_else(|| "gh CLI not authenticated. Run `gh auth login` first.".to_string())?;

    let manifest_url = get_latest_manifest_url(&token).await?;

    let url: tauri::Url = manifest_url
        .parse()
        .map_err(|e| format!("Invalid manifest URL: {}", e))?;

    // Build an updater pointed at the manifest asset URL on the private repo.
    // The same Bearer token is reused for the binary download; GitHub API URLs
    // redirect to an unauthenticated CDN URL that reqwest follows automatically.
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .header("Authorization", format!("Bearer {}", token))
        .map_err(|e| e.to_string())?
        .header("Accept", "application/octet-stream")
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Already up to date.".to_string())?;

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    app.restart()
}

// ── Shell env discovery ───────────────────────────────────────────────────────

fn discover_api_key_from_shell() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let shell_name = std::path::Path::new(&shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    // Fish sources ~/.config/fish/config.fish automatically for all invocations.
    // Every other major shell (zsh, bash, sh, dash, ksh, …) needs -i (interactive,
    // loads .zshrc/.bashrc) and -l (login, loads .zprofile/.bash_profile).
    let args: &[&str] = if shell_name == "fish" {
        &["-c", "printf '%s' $CLAUDE_WRANGLER_LLM_KEY"]
    } else {
        &["-i", "-l", "-c", "printf '%s' \"$CLAUDE_WRANGLER_LLM_KEY\""]
    };

    std::process::Command::new(&shell)
        .args(args)
        .output()
        .ok()
        .and_then(|out| {
            let val = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if val.is_empty() { None } else { Some(val) }
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // macOS GUI apps launched from Finder don't inherit shell env vars.
            // Spawn the user's shell in a background thread to pick up
            // CLAUDE_WRANGLER_LLM_KEY — doing this asynchronously means the window
            // appears immediately instead of waiting 1-2 s for the shell to start.
            // When the key is found, emit "llm-key-discovered" so the UI can re-check.
            let app_handle_for_key = app_handle.clone();
            std::thread::spawn(move || {
                if std::env::var("CLAUDE_WRANGLER_LLM_KEY").unwrap_or_default().is_empty() {
                    if let Some(val) = discover_api_key_from_shell() {
                        #[allow(deprecated)]
                        unsafe { std::env::set_var("CLAUDE_WRANGLER_LLM_KEY", val) };
                        app_handle_for_key.emit("llm-key-discovered", ()).ok();
                    }
                }
            });

            // Write Claude Code hook scripts to ~/.lmwrnglr/hooks/
            pty_manager::setup_lmwrnglr_dirs();

            // Watch ~/.lmwrnglr/status/ and push Claude status updates to windows
            let watcher = pty_manager::watch_status_dir(app_handle.clone());

            let data_dir = app.path().app_data_dir()?;
            let config_store = ConfigStore::new(data_dir.clone());
            let session_store = SessionStore::new(data_dir);

            app.manage(AppState {
                pty_manager: Mutex::new(PtyManager::new()),
                config_store: Mutex::new(config_store),
                session_store: Mutex::new(session_store),
                _watcher: Mutex::new(watcher),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_pty,
            write_pty,
            resize_pty,
            kill_pty,
            kill_all_ptys,
            pty_has_subprocess,
            window_has_subprocess,
            get_claude_status,
            start_dragging,
            toggle_maximize,
            set_window_title,
            open_new_window,
            open_window_with_wid,
            open_saved_session_in_new_window,
            list_open_workspaces,
            get_open_sessions,
            focus_workspace,
            open_url,
            open_in_vscode,
            get_prefs,
            set_prefs,
            has_api_key,
            set_api_key,
            pick_folder,
            register_workspace,
            load_session,
            save_session,
            get_restoreable_sessions,
            delete_workspace_session,
            save_named_session,
            rename_saved_session,
            list_saved_sessions,
            delete_saved_session,
            generate_summary,
            check_for_updates,
            install_update,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    if let Ok(mut m) = state.pty_manager.lock() {
                        m.kill_all_for_window(window.label());
                    }
                    if let Ok(mut s) = state.session_store.lock() {
                        s.unregister_by_label(window.label());
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
