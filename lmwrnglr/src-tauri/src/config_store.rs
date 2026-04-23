use dirs::home_dir;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    api_key: Option<String>,
    starting_path: Option<String>,
    shift_enter_newline: Option<bool>,
    cycle_shortcut: Option<String>,
    cycle_window_shortcut: Option<String>,
}

pub struct ConfigStore {
    file_path: PathBuf,
    config: Config,
}

impl ConfigStore {
    pub fn new(data_dir: PathBuf) -> Self {
        let file_path = data_dir.join("config.json");
        let config = Self::load_from(&file_path);
        Self { file_path, config }
    }

    fn load_from(path: &PathBuf) -> Config {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&self.config)?;
        std::fs::write(&self.file_path, json)?;
        Ok(())
    }

    // API key — env var takes priority over stored key.
    pub fn get_api_key(&self) -> Option<String> {
        std::env::var("CLAUDE_WRANGLER_LLM_KEY")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| self.config.api_key.clone())
    }

    pub fn has_api_key(&self) -> bool {
        self.get_api_key().is_some()
    }

    pub fn api_key_from_env(&self) -> bool {
        std::env::var("CLAUDE_WRANGLER_LLM_KEY")
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    }

    pub fn set_api_key(&mut self, key: String) {
        self.config.api_key = if key.trim().is_empty() {
            None
        } else {
            Some(key.trim().to_string())
        };
    }

    // Starting path
    pub fn get_starting_path(&self) -> String {
        let raw = self
            .config
            .starting_path
            .clone()
            .unwrap_or_default();
        if raw.is_empty() {
            home_dir()
                .map(|h| h.to_string_lossy().into_owned())
                .unwrap_or_else(|| "/".to_string())
        } else {
            let home = home_dir().unwrap_or_else(|| PathBuf::from("/"));
            if raw.starts_with("~/") {
                home.join(&raw[2..]).to_string_lossy().into_owned()
            } else if raw == "~" {
                home.to_string_lossy().into_owned()
            } else {
                raw
            }
        }
    }

    pub fn get_stored_starting_path(&self) -> String {
        self.config.starting_path.clone().unwrap_or_default()
    }

    pub fn set_starting_path(&mut self, path: String) {
        self.config.starting_path = if path.trim().is_empty() {
            None
        } else {
            Some(path.trim().to_string())
        };
    }

    // Shift+Enter → newline (default true)
    pub fn get_shift_enter_newline(&self) -> bool {
        self.config.shift_enter_newline.unwrap_or(true)
    }

    pub fn set_shift_enter_newline(&mut self, value: bool) {
        self.config.shift_enter_newline = Some(value);
    }

    // Cycle-terminals shortcut (default "ctrl+s")
    pub fn get_cycle_shortcut(&self) -> String {
        self.config
            .cycle_shortcut
            .clone()
            .unwrap_or_else(|| "ctrl+s".to_string())
    }

    pub fn set_cycle_shortcut(&mut self, shortcut: String) {
        self.config.cycle_shortcut = if shortcut.trim().is_empty() {
            None
        } else {
            Some(shortcut.trim().to_string())
        };
    }

    // Cycle-windows shortcut (default "ctrl+shift+w")
    pub fn get_cycle_window_shortcut(&self) -> String {
        self.config
            .cycle_window_shortcut
            .clone()
            .unwrap_or_else(|| "ctrl+shift+w".to_string())
    }

    pub fn set_cycle_window_shortcut(&mut self, shortcut: String) {
        self.config.cycle_window_shortcut = if shortcut.trim().is_empty() {
            None
        } else {
            Some(shortcut.trim().to_string())
        };
    }
}
