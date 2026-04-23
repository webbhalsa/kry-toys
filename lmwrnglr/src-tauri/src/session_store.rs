use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneState {
    pub cwd: String,
    pub had_claude: bool,
    pub claude_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSession {
    pub name: String,
    pub root_pane: serde_json::Value,
    pub accent_color: Option<String>,
    pub pane_states: Option<HashMap<String, PaneState>>,
}

/// A workspace session that is not currently open and can be restored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreableSession {
    pub wid: String,
    pub session: WorkspaceSession,
}

/// An explicitly-saved named session (persists until deleted).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    pub id: String,
    pub session: WorkspaceSession,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionData {
    /// Auto-saved workspace sessions, keyed by stable workspace ID (wid).
    #[serde(default)]
    workspaces: HashMap<String, WorkspaceSession>,
    /// Explicitly saved named sessions, keyed by a generated ID.
    #[serde(default)]
    saved: HashMap<String, WorkspaceSession>,
}

pub struct SessionStore {
    file_path: PathBuf,
    data: SessionData,
    /// WIDs of currently-open windows (in-memory only, not persisted).
    current_open: HashSet<String>,
    /// Maps Tauri window label → WID for unregistration on window close.
    label_to_wid: HashMap<String, String>,
}

impl SessionStore {
    pub fn new(data_dir: PathBuf) -> Self {
        let file_path = data_dir.join("sessions.json");
        let data = Self::load_from(&file_path);
        Self { file_path, data, current_open: HashSet::new(), label_to_wid: HashMap::new() }
    }

    fn load_from(path: &PathBuf) -> SessionData {
        let content = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => return SessionData::default(),
        };
        let raw: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => return SessionData::default(),
        };
        // New format is identified by a "workspaces" or "saved" key at the top level.
        if raw.get("workspaces").is_some() || raw.get("saved").is_some() {
            return serde_json::from_value(raw).unwrap_or_default();
        }
        // Migrate from old format: flat map of window-label → WorkspaceSession.
        let workspaces: HashMap<String, WorkspaceSession> =
            serde_json::from_value(raw).unwrap_or_default();
        SessionData { workspaces, saved: HashMap::new() }
    }

    fn persist(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&self.data)?;
        std::fs::write(&self.file_path, json)?;
        Ok(())
    }

    // ── Workspace sessions ────────────────────────────────────────────────────

    /// Mark a window as open. Must be called on startup so the wid is excluded
    /// from the restoreable list while the window is alive.
    pub fn register_open(&mut self, window_label: &str, wid: &str) {
        self.current_open.insert(wid.to_string());
        self.label_to_wid.insert(window_label.to_string(), wid.to_string());
    }

    /// Returns the Tauri window label for the window that owns the given WID, if any.
    pub fn label_for_wid(&self, wid: &str) -> Option<&str> {
        self.label_to_wid
            .iter()
            .find(|(_, w)| w.as_str() == wid)
            .map(|(label, _)| label.as_str())
    }

    /// Returns all WIDs that are currently open, in an unspecified order.
    pub fn get_open_wids(&self) -> Vec<String> {
        self.current_open.iter().cloned().collect()
    }

    /// Remove a window's open registration by its Tauri label (called on Destroyed).
    pub fn unregister_by_label(&mut self, window_label: &str) {
        if let Some(wid) = self.label_to_wid.remove(window_label) {
            self.current_open.remove(&wid);
        }
    }

    pub fn load_for_wid(&self, wid: &str) -> Option<WorkspaceSession> {
        self.data.workspaces.get(wid).cloned()
    }

    pub fn save_for_wid(
        &mut self,
        wid: &str,
        session: WorkspaceSession,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.data.workspaces.insert(wid.to_string(), session);
        self.persist()
    }

    /// Returns all workspace sessions that are not currently open, sorted by name.
    pub fn get_restoreable(&self) -> Vec<RestoreableSession> {
        let mut sessions: Vec<RestoreableSession> = self
            .data
            .workspaces
            .iter()
            .filter(|(wid, _)| !self.current_open.contains(*wid))
            .map(|(wid, session)| RestoreableSession { wid: wid.clone(), session: session.clone() })
            .collect();
        sessions.sort_by(|a, b| a.session.name.cmp(&b.session.name));
        sessions
    }

    /// Returns all workspace sessions that ARE currently open, sorted by name.
    pub fn get_open_sessions(&self) -> Vec<RestoreableSession> {
        let mut sessions: Vec<RestoreableSession> = self
            .data
            .workspaces
            .iter()
            .filter(|(wid, _)| self.current_open.contains(*wid))
            .map(|(wid, session)| RestoreableSession { wid: wid.clone(), session: session.clone() })
            .collect();
        sessions.sort_by(|a, b| a.session.name.cmp(&b.session.name));
        sessions
    }

    pub fn delete_workspace(
        &mut self,
        wid: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.data.workspaces.remove(wid);
        self.current_open.remove(wid);
        self.persist()
    }

    // ── Named saved sessions ──────────────────────────────────────────────────

    pub fn save_named(
        &mut self,
        id: &str,
        session: WorkspaceSession,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.data.saved.insert(id.to_string(), session);
        self.persist()
    }

    pub fn rename_saved(
        &mut self,
        id: &str,
        name: String,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Some(session) = self.data.saved.get_mut(id) {
            session.name = name;
            self.persist()
        } else {
            Ok(())
        }
    }

    /// Returns all named saved sessions, sorted by name.
    pub fn list_saved(&self) -> Vec<SavedSession> {
        let mut sessions: Vec<SavedSession> = self
            .data
            .saved
            .iter()
            .map(|(id, session)| SavedSession { id: id.clone(), session: session.clone() })
            .collect();
        sessions.sort_by(|a, b| a.session.name.cmp(&b.session.name));
        sessions
    }

    pub fn delete_saved(
        &mut self,
        id: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.data.saved.remove(id);
        self.persist()
    }

    /// Copy a saved session into workspaces under a fresh WID (for opening in a new window).
    /// Returns the new WID on success.
    pub fn stage_saved_as_workspace(&mut self, saved_id: &str) -> Option<String> {
        let session = self.data.saved.get(saved_id)?.clone();
        let wid = new_wid();
        self.data.workspaces.insert(wid.clone(), session);
        self.persist().ok();
        Some(wid)
    }
}

/// Generate a random, stable workspace identifier.
pub fn new_wid() -> String {
    format!("wid-{:x}{:x}", rand::random::<u64>(), rand::random::<u32>())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn tmp_store(dir: &TempDir) -> SessionStore {
        SessionStore::new(dir.path().to_path_buf())
    }

    fn session(name: &str) -> WorkspaceSession {
        WorkspaceSession {
            name: name.to_string(),
            root_pane: serde_json::json!({"type": "terminal", "id": "p1", "number": 1}),
            accent_color: None,
            pane_states: None,
        }
    }

    fn session_json(name: &str) -> serde_json::Value {
        serde_json::json!({
            "name": name,
            "rootPane": {"type": "terminal", "id": "p1", "number": 1},
            "accentColor": null,
            "paneStates": null
        })
    }

    // ── new_wid ───────────────────────────────────────────────────────────────

    #[test]
    fn new_wid_has_prefix() {
        assert!(new_wid().starts_with("wid-"));
    }

    #[test]
    fn new_wid_is_longer_than_prefix() {
        assert!(new_wid().len() > 4);
    }

    #[test]
    fn new_wid_values_are_unique() {
        // Extremely low probability of collision
        assert_ne!(new_wid(), new_wid());
    }

    // ── load_from ─────────────────────────────────────────────────────────────

    #[test]
    fn load_missing_file_returns_empty() {
        let dir = TempDir::new().unwrap();
        let store = tmp_store(&dir);
        assert!(store.data.workspaces.is_empty());
        assert!(store.data.saved.is_empty());
    }

    #[test]
    fn load_invalid_json_returns_empty() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("sessions.json"), "not json!!!").unwrap();
        let store = tmp_store(&dir);
        assert!(store.data.workspaces.is_empty());
    }

    #[test]
    fn load_new_format_workspaces_key() {
        let dir = TempDir::new().unwrap();
        let json = serde_json::json!({
            "workspaces": { "wid-abc": session_json("Test") },
            "saved": {}
        });
        fs::write(dir.path().join("sessions.json"), json.to_string()).unwrap();
        let store = tmp_store(&dir);
        assert!(store.data.workspaces.contains_key("wid-abc"));
        assert_eq!(store.data.workspaces["wid-abc"].name, "Test");
        assert!(store.data.saved.is_empty());
    }

    #[test]
    fn load_new_format_saved_key_only() {
        let dir = TempDir::new().unwrap();
        // Only "saved" key present — still treated as new format
        let json = serde_json::json!({
            "saved": { "saved-1": session_json("Named") }
        });
        fs::write(dir.path().join("sessions.json"), json.to_string()).unwrap();
        let store = tmp_store(&dir);
        assert!(store.data.workspaces.is_empty());
        assert!(store.data.saved.contains_key("saved-1"));
    }

    #[test]
    fn load_old_format_migrates_flat_map() {
        let dir = TempDir::new().unwrap();
        // Old format: flat map of window-label → WorkspaceSession
        let json = serde_json::json!({
            "main": session_json("Main Workspace"),
            "workspace-99": session_json("Secondary")
        });
        fs::write(dir.path().join("sessions.json"), json.to_string()).unwrap();
        let store = tmp_store(&dir);
        assert!(store.data.workspaces.contains_key("main"));
        assert!(store.data.workspaces.contains_key("workspace-99"));
        assert!(store.data.saved.is_empty());
    }

    #[test]
    fn load_empty_json_object_returns_empty() {
        let dir = TempDir::new().unwrap();
        // {} has no "workspaces"/"saved" keys → treated as old format → empty map
        fs::write(dir.path().join("sessions.json"), "{}").unwrap();
        let store = tmp_store(&dir);
        assert!(store.data.workspaces.is_empty());
        assert!(store.data.saved.is_empty());
    }

    // ── register_open / unregister_by_label ──────────────────────────────────

    #[test]
    fn register_adds_to_current_open() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.register_open("main", "wid-abc");
        assert!(store.current_open.contains("wid-abc"));
        assert_eq!(store.label_to_wid.get("main"), Some(&"wid-abc".to_string()));
    }

    #[test]
    fn unregister_removes_from_current_open() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.register_open("main", "wid-abc");
        store.unregister_by_label("main");
        assert!(!store.current_open.contains("wid-abc"));
        assert!(!store.label_to_wid.contains_key("main"));
    }

    #[test]
    fn unregister_unknown_label_is_noop() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        // Must not panic
        store.unregister_by_label("nonexistent-label");
        assert!(store.current_open.is_empty());
    }

    #[test]
    fn register_same_wid_different_windows() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.register_open("win1", "wid-shared");
        store.register_open("win2", "wid-other");
        assert!(store.current_open.contains("wid-shared"));
        assert!(store.current_open.contains("wid-other"));
        store.unregister_by_label("win1");
        assert!(!store.current_open.contains("wid-shared"));
        assert!(store.current_open.contains("wid-other"));
    }

    // ── load_for_wid / save_for_wid ───────────────────────────────────────────

    #[test]
    fn save_and_load_roundtrip() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_for_wid("wid-abc", session("My Workspace")).unwrap();
        let loaded = store.load_for_wid("wid-abc").unwrap();
        assert_eq!(loaded.name, "My Workspace");
    }

    #[test]
    fn load_unknown_wid_returns_none() {
        let dir = TempDir::new().unwrap();
        let store = tmp_store(&dir);
        assert!(store.load_for_wid("no-such-wid").is_none());
    }

    #[test]
    fn save_overwrites_existing() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_for_wid("wid-abc", session("First")).unwrap();
        store.save_for_wid("wid-abc", session("Second")).unwrap();
        assert_eq!(store.load_for_wid("wid-abc").unwrap().name, "Second");
    }

    #[test]
    fn save_persists_to_disk_and_reloads() {
        let dir = TempDir::new().unwrap();
        {
            let mut store = tmp_store(&dir);
            store.save_for_wid("wid-abc", session("Persisted")).unwrap();
        }
        let store2 = tmp_store(&dir);
        assert_eq!(store2.load_for_wid("wid-abc").unwrap().name, "Persisted");
    }

    #[test]
    fn save_preserves_accent_color_and_pane_states() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        let mut pane_states = HashMap::new();
        pane_states.insert("p1".to_string(), PaneState {
            cwd: "/home/user/project".to_string(),
            had_claude: true,
            claude_session_id: Some("sess-abc".to_string()),
        });
        let s = WorkspaceSession {
            name: "Rich".to_string(),
            root_pane: serde_json::json!({}),
            accent_color: Some("#1e3a5f".to_string()),
            pane_states: Some(pane_states),
        };
        store.save_for_wid("wid-rich", s).unwrap();
        let loaded = store.load_for_wid("wid-rich").unwrap();
        assert_eq!(loaded.accent_color, Some("#1e3a5f".to_string()));
        let ps = loaded.pane_states.unwrap();
        let p1 = ps.get("p1").unwrap();
        assert_eq!(p1.cwd, "/home/user/project");
        assert!(p1.had_claude);
        assert_eq!(p1.claude_session_id, Some("sess-abc".to_string()));
    }

    // ── get_restoreable ───────────────────────────────────────────────────────

    #[test]
    fn restoreable_returns_sessions_not_in_current_open() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_for_wid("wid-open", session("Open")).unwrap();
        store.save_for_wid("wid-closed", session("Closed")).unwrap();
        store.register_open("win", "wid-open");
        let r = store.get_restoreable();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].wid, "wid-closed");
    }

    #[test]
    fn restoreable_sorted_by_name() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_for_wid("z", session("Zebra")).unwrap();
        store.save_for_wid("a", session("Alpha")).unwrap();
        store.save_for_wid("m", session("Middle")).unwrap();
        let r = store.get_restoreable();
        assert_eq!(r[0].session.name, "Alpha");
        assert_eq!(r[1].session.name, "Middle");
        assert_eq!(r[2].session.name, "Zebra");
    }

    #[test]
    fn restoreable_empty_when_all_windows_open() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_for_wid("wid-abc", session("Test")).unwrap();
        store.register_open("win", "wid-abc");
        assert!(store.get_restoreable().is_empty());
    }

    #[test]
    fn restoreable_empty_when_no_sessions() {
        let dir = TempDir::new().unwrap();
        let store = tmp_store(&dir);
        assert!(store.get_restoreable().is_empty());
    }

    #[test]
    fn unregister_makes_session_restoreable_again() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_for_wid("wid-abc", session("Test")).unwrap();
        store.register_open("win", "wid-abc");
        assert!(store.get_restoreable().is_empty());
        store.unregister_by_label("win");
        assert_eq!(store.get_restoreable().len(), 1);
    }

    // ── delete_workspace ──────────────────────────────────────────────────────

    #[test]
    fn delete_workspace_removes_session() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_for_wid("wid-abc", session("Test")).unwrap();
        store.delete_workspace("wid-abc").unwrap();
        assert!(store.load_for_wid("wid-abc").is_none());
    }

    #[test]
    fn delete_workspace_removes_from_current_open() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_for_wid("wid-abc", session("Test")).unwrap();
        store.register_open("win", "wid-abc");
        store.delete_workspace("wid-abc").unwrap();
        assert!(!store.current_open.contains("wid-abc"));
    }

    #[test]
    fn delete_workspace_persists_removal() {
        let dir = TempDir::new().unwrap();
        {
            let mut store = tmp_store(&dir);
            store.save_for_wid("wid-abc", session("Test")).unwrap();
            store.delete_workspace("wid-abc").unwrap();
        }
        let store2 = tmp_store(&dir);
        assert!(store2.load_for_wid("wid-abc").is_none());
    }

    #[test]
    fn delete_nonexistent_workspace_is_noop() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        // Should succeed without panicking
        store.delete_workspace("no-such-wid").unwrap();
    }

    // ── Named saved sessions ──────────────────────────────────────────────────

    #[test]
    fn save_and_list_named_sessions_sorted() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_named("s2", session("Bravo")).unwrap();
        store.save_named("s1", session("Alpha")).unwrap();
        store.save_named("s3", session("Charlie")).unwrap();
        let sessions = store.list_saved();
        assert_eq!(sessions.len(), 3);
        assert_eq!(sessions[0].session.name, "Alpha");
        assert_eq!(sessions[1].session.name, "Bravo");
        assert_eq!(sessions[2].session.name, "Charlie");
        assert_eq!(sessions[0].id, "s1");
    }

    #[test]
    fn list_saved_empty() {
        let dir = TempDir::new().unwrap();
        let store = tmp_store(&dir);
        assert!(store.list_saved().is_empty());
    }

    #[test]
    fn save_named_overwrites_same_id() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_named("s1", session("Original")).unwrap();
        store.save_named("s1", session("Updated")).unwrap();
        let sessions = store.list_saved();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session.name, "Updated");
    }

    #[test]
    fn rename_saved_updates_name() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_named("s1", session("Old Name")).unwrap();
        store.rename_saved("s1", "New Name".to_string()).unwrap();
        assert_eq!(store.list_saved()[0].session.name, "New Name");
    }

    #[test]
    fn rename_saved_persists() {
        let dir = TempDir::new().unwrap();
        {
            let mut store = tmp_store(&dir);
            store.save_named("s1", session("Old")).unwrap();
            store.rename_saved("s1", "New".to_string()).unwrap();
        }
        let store2 = tmp_store(&dir);
        assert_eq!(store2.list_saved()[0].session.name, "New");
    }

    #[test]
    fn rename_nonexistent_saved_returns_ok() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        // Must not panic or error
        store.rename_saved("nonexistent", "Name".to_string()).unwrap();
    }

    #[test]
    fn delete_saved_removes_session() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_named("s1", session("Test")).unwrap();
        store.delete_saved("s1").unwrap();
        assert!(store.list_saved().is_empty());
    }

    #[test]
    fn delete_saved_persists() {
        let dir = TempDir::new().unwrap();
        {
            let mut store = tmp_store(&dir);
            store.save_named("s1", session("Test")).unwrap();
            store.delete_saved("s1").unwrap();
        }
        let store2 = tmp_store(&dir);
        assert!(store2.list_saved().is_empty());
    }

    #[test]
    fn delete_nonexistent_saved_is_noop() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.delete_saved("nonexistent").unwrap();
    }

    #[test]
    fn named_sessions_do_not_appear_in_restoreable() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_named("s1", session("Named")).unwrap();
        assert!(store.get_restoreable().is_empty());
    }

    // ── stage_saved_as_workspace ──────────────────────────────────────────────

    #[test]
    fn stage_saved_creates_workspace_entry() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_named("s1", session("From Saved")).unwrap();
        let wid = store.stage_saved_as_workspace("s1").unwrap();
        assert!(wid.starts_with("wid-"));
        assert_eq!(store.load_for_wid(&wid).unwrap().name, "From Saved");
    }

    #[test]
    fn stage_saved_does_not_remove_saved_session() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_named("s1", session("Preset")).unwrap();
        store.stage_saved_as_workspace("s1").unwrap();
        // saved session must still be there
        assert_eq!(store.list_saved().len(), 1);
    }

    #[test]
    fn stage_saved_returns_none_for_unknown_id() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        assert!(store.stage_saved_as_workspace("no-such-id").is_none());
    }

    #[test]
    fn stage_saved_each_call_gets_unique_wid() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_named("s1", session("Preset")).unwrap();
        let wid1 = store.stage_saved_as_workspace("s1").unwrap();
        let wid2 = store.stage_saved_as_workspace("s1").unwrap();
        assert_ne!(wid1, wid2);
    }

    #[test]
    fn stage_saved_workspace_appears_in_restoreable() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        store.save_named("s1", session("Preset")).unwrap();
        let wid = store.stage_saved_as_workspace("s1").unwrap();
        let r = store.get_restoreable();
        assert!(r.iter().any(|rs| rs.wid == wid));
    }

    // ── pane_states with no claude_session_id ─────────────────────────────────

    #[test]
    fn pane_state_without_claude_session_id() {
        let dir = TempDir::new().unwrap();
        let mut store = tmp_store(&dir);
        let mut pane_states = HashMap::new();
        pane_states.insert("p1".to_string(), PaneState {
            cwd: "/tmp".to_string(),
            had_claude: false,
            claude_session_id: None,
        });
        let s = WorkspaceSession {
            name: "No Claude".to_string(),
            root_pane: serde_json::json!({}),
            accent_color: None,
            pane_states: Some(pane_states),
        };
        store.save_for_wid("wid-nc", s).unwrap();
        let ps = store.load_for_wid("wid-nc").unwrap().pane_states.unwrap();
        assert!(!ps["p1"].had_claude);
        assert!(ps["p1"].claude_session_id.is_none());
    }
}
