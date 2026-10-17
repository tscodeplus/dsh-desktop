//! Shell configuration + mirror of the sidecar-owned `desktop-config.json`.
//!
//! The sidecar is the primary writer of `desktop-config.json` (it lives at
//! `<data_dir>/desktop-config.json`, where `data_dir` is the upstream dsh
//! home `~/.dsh`). The shell reads the file at startup and polls mtime once
//! per second to react to `theme` / `language` / `closeToTray` changes
//! without a push channel.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;
use tauri::{AppHandle, Manager};

/// Paths the shell passes to the sidecar. The data root is the upstream dsh
/// default home (`~/.dsh` — see `@deepseek-ai/dsh-home-paths` `resolveDshHome`),
/// so the desktop app shares profiles / storages / credentials with the
/// upstream CLI instead of keeping a private copy.
#[derive(Clone, Debug)]
pub struct ShellConfig {
    /// `~/.dsh` on all platforms (upstream dsh default home).
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub config_file: PathBuf,
    pub log_dir: PathBuf,
    pub server_port: u16,
    /// Root of the bundled sidecar (prod: `<resources>/sidecar`, dev: `<repo>/desktop/.sidecar-deps`).
    pub resources_dir: PathBuf,
    /// Engine (dsh runtime closure) home — `<data_dir>/engine`. The engine
    /// lives under the data root (same volume) so runtime updates can swap
    /// directories atomically, and outside the read-only install dir.
    pub engine_dir: PathBuf,
    pub app_version: String,
}

impl ShellConfig {
    pub fn load(app: &AppHandle) -> Self {
        let data_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".dsh");
        let resources_dir = app
            .path()
            .resource_dir()
            .unwrap_or_default()
            .join("sidecar");
        let version = app.package_info().version.to_string();
        let server_port = std::env::var("DSHD_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3080);

        ShellConfig {
            data_dir: data_dir.clone(),
            db_path: data_dir.join("data").join("app.db"),
            config_file: data_dir.join("config.yaml"),
            log_dir: data_dir.join("logs"),
            server_port,
            resources_dir,
            engine_dir: data_dir.join("engine"),
            app_version: version,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopConfig {
    pub close_to_tray: bool,
    pub auto_start: bool,
    /// "system" | "light" | "dark"
    pub theme: String,
    pub language: Option<String>,
    /// "lan" | "tailscale" — which adapter the web server binds (engine
    /// 0.2.1-alpha.5+ single-bind model). Written by the sidecar (primary
    /// owner of the file); the shell only mirrors it.
    pub bind_adapter: String,
    pub first_run_done: bool,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        DesktopConfig {
            close_to_tray: true,
            auto_start: false,
            theme: "system".into(),
            language: None,
            bind_adapter: "lan".into(),
            first_run_done: false,
        }
    }
}

impl DesktopConfig {
    /// Read + parse the file; falls back to defaults when missing/corrupt.
    pub fn load(path: &std::path::Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => DesktopConfig::default(),
        }
    }

    /// Atomic write (tmp + rename) so the sidecar's watcher never sees a partial file.
    pub fn save(&self, path: &std::path::Path) -> std::io::Result<()> {
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}

/// State held by the shell: current config mirror + the file's last mtime.
pub struct ConfigMirror {
    pub cfg: DesktopConfig,
    last_mtime: Option<SystemTime>,
}

impl ConfigMirror {
    pub fn new(path: &std::path::Path) -> Self {
        let cfg = DesktopConfig::load(path);
        let last_mtime = std::fs::metadata(path).ok().and_then(|m| m.modified().ok());
        ConfigMirror { cfg, last_mtime }
    }
}

/// True when `closeToTray` was requested in the mirror.
pub static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

/// Poll the config file every second; on change, update the mirror and react
/// (window chrome theme, tray rebuild, close-to-tray flag).
pub async fn poll_config_loop(app: AppHandle) {
    let path = ShellConfig::load(&app).data_dir.join("desktop-config.json");
    let mut mirror = ConfigMirror::new(&path);

    loop {
        let mtime = std::fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok());
        if mtime != mirror.last_mtime {
            let new_cfg = DesktopConfig::load(&path);
            let changed = new_cfg.theme != mirror.cfg.theme
                || new_cfg.language != mirror.cfg.language
                || new_cfg.close_to_tray != mirror.cfg.close_to_tray;
            mirror.cfg = new_cfg;
            mirror.last_mtime = mtime;

            CLOSE_TO_TRAY.store(
                mirror.cfg.close_to_tray,
                Ordering::SeqCst,
            );

            if changed {
                crate::tray::rebuild(&app, &mirror.cfg);
                let _ = crate::windows::apply_theme(&app, &mirror.cfg.theme);
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

/// Locate the desktop config file from the shell data dir.
pub fn config_path(app: &AppHandle) -> PathBuf {
    ShellConfig::load(app).data_dir.join("desktop-config.json")
}
