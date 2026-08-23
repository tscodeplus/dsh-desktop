// DSH Desktop — Tauri shell around the DeepSeek Harness Node server (sidecar).
//
// Shell responsibilities (mirroring the former Electron main process):
//   · spawn / supervise the Node sidecar (see sidecar.rs)
//   · windows: splash, main WebUI window, updater dialogs (windows.rs)
//   · system tray (tray.rs)
//   · desktop-config.json mirror + theme/language/closeToTray reactions (config.rs)
//   · tiny_http control service receiving pushes from the sidecar (ctl_server.rs)
//
// The dsh web UI is served by the sidecar (dsh-dist) and loaded via
// http://127.0.0.1:3080 — same-origin.

use tauri::Manager;

mod config;
mod ctl_server;
mod i18n;
mod log_file;
mod sidecar;
mod tray;
mod windows;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the main window on second-instance launch. During the
            // first boot the main window exists but is intentionally hidden
            // behind the splash (single-splash gate) — a second instance
            // must not reveal it early.
            if let Some(win) = app.get_webview_window(windows::MAIN_LABEL) {
                if app.get_webview_window(windows::SPLASH_LABEL).is_none() {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // Close-to-tray: intercept the main window's close request.
        .on_window_event(|window, event| {
            if window.label() == windows::MAIN_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if config::CLOSE_TO_TRAY.load(std::sync::atomic::Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // File logger first: everything below (tray, sidecar, windows)
            // logs into ~/.dsh/logs/shell.log — GUI apps have no stderr.
            let shell_log = config::ShellConfig::load(&handle).log_dir.join("shell.log");
            let _ = log_file::init(&shell_log);
            // Read the shell config mirror (~/.dsh/desktop-config.json).
            let cfg = config::DesktopConfig::load(&config::config_path(&handle));
            config::CLOSE_TO_TRAY.store(cfg.close_to_tray, std::sync::atomic::Ordering::SeqCst);
            let _ = windows::apply_theme(&handle, &cfg.theme);

            // Control service first: the splash/error windows load their
            // pages from it (works even when the sidecar is down).
            let _ = ctl_server::init(handle.clone());

            // Tray + splash next, then the sidecar supervision stack. The
            // main window is NOT created here — it is built lazily by
            // reveal_main_window once the sidecar answers /api/health, so its
            // first navigation never hits a not-yet-listening server.
            // Single-splash UX: the shell splash (deepseek.com/harness
            // branding) stays up until the WebUI's own boot chain settles
            // inside the hidden main window — see windows.rs
            // reveal_main_window / boot-watch.js.
            let _ = tray::create_tray(&handle, &cfg);
            let _ = windows::create_splash(&handle);

            tauri::async_runtime::spawn(async move {
                sidecar::init(&handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
