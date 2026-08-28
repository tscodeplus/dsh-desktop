//! System tray: status label, show/hide, restart service, open data dir,
//! auto-start & close-to-tray checkboxes, restart, about, quit.
//!
//! Menu rebuild triggers: config file change (config.rs poll), sidecar status
//! change (sidecar.rs holder/health loops). Tauri has no "menu about to open"
//! event, so state is only as fresh as the last rebuild — 1s config poll keeps
//! it close enough for checkboxes and the status label.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{config_path, DesktopConfig};
use crate::i18n::{is_zh_cfg, tr};
use crate::sidecar::{take_snapshot, SidecarState, StatusKind};

const ID_TOGGLE: &str = "toggle-window";
const ID_STATUS: &str = "status";
const ID_RESTART_SERVICE: &str = "restart-service";
const ID_OPEN_DATA: &str = "open-data-dir";
const ID_PLUGINS: &str = "plugins";
const ID_AUTO_START: &str = "auto-start";
const ID_CLOSE_TO_TRAY: &str = "close-to-tray";
const ID_RESTART_APP: &str = "restart-app";
const ID_ABOUT: &str = "about";
const ID_OPEN_LOG: &str = "open-log-dir";
const ID_WEB_ACCESS: &str = "web-access";
const ID_CHECK_ENGINE: &str = "check-engine";
const ID_QUIT: &str = "quit";

/// Create the tray icon with its initial menu.
pub fn create_tray(app: &AppHandle, cfg: &DesktopConfig) -> tauri::Result<()> {
    let menu = build_menu(app, cfg)?;
    // Without an explicit id the tray gets a random unique id and
    // `app.tray_by_id("main")` in rebuild() silently misses → the menu
    // would stay frozen at its initial state ("服务启动中…").
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("DSH Desktop")
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });

    // Dedicated tray icon; fall back to the app icon.
    if let Some(icon) = load_tray_icon(app) {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn load_tray_icon(app: &AppHandle) -> Option<tauri::image::Image<'static>> {
    // Dedicated 128x128 tray asset (tight-cropped glyph from
    // assets/icon-source.svg via scripts/gen-icons.py) — a downscaled app icon
    // renders muddy at tray size on Windows.
    tauri::image::Image::from_bytes(include_bytes!("../../assets/tray-icon.png")).ok()
        .or_else(|| app.default_window_icon().cloned().map(|i| i.to_owned()))
}

fn build_menu(app: &AppHandle, cfg: &DesktopConfig) -> tauri::Result<Menu<tauri::Wry>> {
    let zh = is_zh_cfg(cfg);
    let menu = Menu::new(app)?;

    let status = MenuItem::with_id(app, ID_STATUS, status_label(app, cfg), false, None::<&str>)?;
    menu.append(&status)?;

    let restart = MenuItem::with_id(
        app,
        ID_RESTART_SERVICE,
        tr("重启服务", "Restart Service", zh),
        true,
        None::<&str>,
    )?;
    menu.append(&restart)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let toggle = MenuItem::with_id(
        app,
        ID_TOGGLE,
        tr("显示 / 隐藏窗口", "Show / Hide Window", zh),
        true,
        None::<&str>,
    )?;
    menu.append(&toggle)?;

    let auto_start = CheckMenuItem::with_id(
        app,
        ID_AUTO_START,
        tr("开机自启动", "Start on Login", zh),
        true,
        cfg.auto_start,
        None::<&str>,
    )?;
    menu.append(&auto_start)?;
    let close_to_tray = CheckMenuItem::with_id(
        app,
        ID_CLOSE_TO_TRAY,
        tr("关闭时最小化到托盘", "Close to Tray", zh),
        true,
        cfg.close_to_tray,
        None::<&str>,
    )?;
    menu.append(&close_to_tray)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let plugins = MenuItem::with_id(
        app,
        ID_PLUGINS,
        tr("安装 / 管理插件", "Install / Manage Plugins", zh),
        true,
        None::<&str>,
    )?;
    menu.append(&plugins)?;

    // "更多" submenu: housekeeping + remote/engine actions that don't need a
    // permanent top-level slot. The engine update check was moved out of the
    // About window into here (per the About-window cleanup).
    let open_data = MenuItem::with_id(
        app,
        ID_OPEN_DATA,
        tr("打开数据目录", "Open Data Folder", zh),
        true,
        None::<&str>,
    )?;
    let open_log = MenuItem::with_id(
        app,
        ID_OPEN_LOG,
        tr("打开日志目录", "Open Log Folder", zh),
        true,
        None::<&str>,
    )?;
    let web_access = MenuItem::with_id(
        app,
        ID_WEB_ACCESS,
        tr("Web 端访问", "Web Access", zh),
        true,
        None::<&str>,
    )?;
    let check_engine = MenuItem::with_id(
        app,
        ID_CHECK_ENGINE,
        tr("检查 DeepSeek Harness 更新", "Check DeepSeek Harness Updates", zh),
        true,
        None::<&str>,
    )?;
    let about = MenuItem::with_id(app, ID_ABOUT, tr("关于", "About", zh), true, None::<&str>)?;
    let more = Submenu::with_id(app, "more", tr("更多", "More", zh), true)?;
    more.append_items(&[&open_data, &open_log, &web_access, &check_engine, &about])?;
    menu.append(&more)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let restart_app = MenuItem::with_id(
        app,
        ID_RESTART_APP,
        tr("重启应用", "Restart App", zh),
        true,
        None::<&str>,
    )?;
    menu.append(&restart_app)?;

    let quit = MenuItem::with_id(app, ID_QUIT, tr("退出", "Quit", zh), true, None::<&str>)?;
    menu.append(&quit)?;

    Ok(menu)
}

fn status_label(app: &AppHandle, cfg: &DesktopConfig) -> String {
    let zh = is_zh_cfg(cfg);
    // The tray is created before sidecar::init manages the state — degrade
    // gracefully instead of panicking on state().
    let Some(state) = app.try_state::<std::sync::Arc<SidecarState>>() else {
        return tr("服务启动中…", "Starting service…", zh).into();
    };
    let snapshot = take_snapshot(&state);
    match snapshot.kind {
        StatusKind::Running => format!(
            "{} · {} {}",
            tr("服务运行中", "Service running", zh),
            tr("端口", "port", zh),
            snapshot.port
        ),
        StatusKind::Starting => tr("服务启动中…", "Starting service…", zh).into(),
        StatusKind::Stopping => tr("服务停止中…", "Stopping service…", zh).into(),
        // Fixed label, like the Electron tray (its serviceStatusError string);
        // the error details live in the error window, not in the menu.
        StatusKind::Error => tr("服务异常", "Service error", zh).into(),
        StatusKind::Stopped => tr("服务已停止", "Service stopped", zh).into(),
    }
}

/// Rebuild the tray menu (new config or sidecar status).
pub fn rebuild(app: &AppHandle, cfg: &DesktopConfig) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(menu) = build_menu(app, cfg) {
            let _ = tray.set_menu(Some(menu));
        } else {
            log::warn!("tray: rebuild failed to build menu");
        }
    } else {
        log::warn!("tray: rebuild found no tray with id \"main\"");
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        ID_TOGGLE => toggle_main_window(app),
        ID_RESTART_SERVICE => crate::sidecar::restart(app),
        ID_OPEN_DATA => {
            // All user data (profiles, storages, credentials, logs,
            // desktop-config.json) lives under the upstream dsh home `~/.dsh`.
            let cfg = crate::config::ShellConfig::load(app);
            open_path(app, &cfg.data_dir);
        }
        ID_PLUGINS => {
            if let Err(e) = crate::windows::show_plugins_window(app) {
                log::error!("tray: show_plugins_window failed: {e}");
            }
        }
        ID_AUTO_START => toggle_auto_start(app),
        ID_CLOSE_TO_TRAY => toggle_close_to_tray(app),
        ID_RESTART_APP => restart_app(app),
        ID_ABOUT => {
            if let Err(e) = crate::windows::show_about_window(app) {
                log::error!("tray: show_about_window failed: {e}");
            }
        }
        ID_OPEN_LOG => {
            // Mirror the former About-window "Open Log Folder" action.
            let log_dir = crate::config::ShellConfig::load(app).log_dir;
            open_path(app, &log_dir);
        }
        ID_WEB_ACCESS => {
            // Open the Web UI in the default browser. Loopback token URL so
            // BrowserAuth is satisfied without manual token entry.
            let url = crate::windows::webui_url(app, true);
            let _ = tauri_plugin_opener::OpenerExt::opener(app)
                .open_url(url, None::<&str>);
        }
        ID_CHECK_ENGINE => {
            // Engine update check moved out of the About window into the tray.
            // If About is already open, emit to its live listener; otherwise
            // open it with runOnLoad so it checks on load (show_about_window
            // early-returns without re-running init when already open).
            if app.get_webview_window(crate::windows::ABOUT_LABEL).is_some() {
                let _ = app.emit_to(crate::windows::ABOUT_LABEL, "dshd-check-engine", ());
            } else if let Err(e) =
                crate::windows::show_about_window_run(app, Some("checkEngine"))
            {
                log::error!("tray: show_about_window failed: {e}");
            }
        }
        ID_QUIT => quit_app(app),
        _ => {}
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(crate::windows::MAIN_LABEL) {
        // During the first boot the main window is intentionally hidden
        // behind the splash (single-splash gate) — don't reveal it early.
        if app.get_webview_window(crate::windows::SPLASH_LABEL).is_some() {
            return;
        }
        if let Ok(visible) = win.is_visible() {
            if visible {
                let _ = win.hide();
            } else {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
}

pub(crate) fn open_path(app: &AppHandle, path: &std::path::Path) {
    // Open the directory itself; only fall back to the parent when it does
    // not exist (e.g. logs dir before the sidecar has written anything).
    let target = if path.exists() {
        path.to_path_buf()
    } else if std::fs::create_dir_all(path).is_ok() {
        path.to_path_buf()
    } else {
        path.parent().unwrap_or(path).to_path_buf()
    };
    let _ = tauri_plugin_opener::OpenerExt::opener(app)
        .open_path(target.to_string_lossy().to_string(), None::<&str>);
}

fn toggle_auto_start(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let path = config_path(app);
    let mut cfg = DesktopConfig::load(&path);
    let autolaunch = app.autolaunch();
    match autolaunch.is_enabled() {
        Ok(enabled) => {
            cfg.auto_start = !enabled;
            if cfg.auto_start {
                let _ = autolaunch.enable();
            } else {
                let _ = autolaunch.disable();
            }
            let _ = cfg.save(&path);
            rebuild(app, &cfg);
        }
        Err(_) => {
            // Plugin unavailable (e.g. macOS without the right flags): flip the
            // config anyway so the checkbox stays truthful.
            cfg.auto_start = !cfg.auto_start;
            let _ = cfg.save(&path);
            rebuild(app, &cfg);
        }
    }
}

fn toggle_close_to_tray(app: &AppHandle) {
    let path = config_path(app);
    let mut cfg = DesktopConfig::load(&path);
    cfg.close_to_tray = !cfg.close_to_tray;
    crate::config::CLOSE_TO_TRAY.store(cfg.close_to_tray, std::sync::atomic::Ordering::SeqCst);
    let _ = cfg.save(&path);
    rebuild(app, &cfg);
}

fn restart_app(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::sidecar::shutdown(&app).await;
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::process::Command::new(exe).spawn();
        }
        app.exit(0);
    });
}

fn quit_app(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::sidecar::shutdown(&app).await;
        app.exit(0);
    });
}
