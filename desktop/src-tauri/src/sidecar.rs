//! Sidecar supervision — spawn the bundled Node runtime running the dsh
//! (DeepSeek Harness) web server, health-poll it, forward its output to
//! `logs/sidecar.log`, and clean up on exit.
//!
//! Lifecycle (the main behavioral difference vs. Electron, where the server ran
//! in-process):
//!   · spawn:  `node.exe index.js` (the sidecar) with cwd = the sidecar root;
//!             the sidecar in turn spawns `dsh web` on the bundled runtime
//!   · health: poll GET http://127.0.0.1:3080/ every 500ms (8s request
//!             timeout); up to 60s to become ready at startup; 5 consecutive
//!             failures while running → error state
//!   · exit:   graceful POST /_desktop/shutdown → wait 2s → taskkill /T /F
//!   · anti-orphan: the sidecar self-exits after 3 missed heartbeats to the
//!             shell's control service (Rust dying cannot leave it alive)
//!
//! Ownership model: the `Child` handle lives in a single "holder" task that
//! forwards stdout/stderr and reaps it; the shared state only stores the pid,
//! so shutdown/restart can kill by pid without contending on the handle.
//!
//! Dev mode (debug_assertions): the sidecar is started by `beforeDevCommand`
//! (`pnpm dev:sidecar`, tsx watch) so hot reload works; the shell only polls
//! health and never spawns/kills.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};

use crate::config::{config_path, DesktopConfig, ShellConfig};
use crate::i18n::is_zh;

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);
const STARTUP_WINDOW: Duration = Duration::from_secs(60);
const MAX_CONSECUTIVE_FAILURES: u32 = 5;
// Must exceed the sidecar's own force-exit deadline (SHUTDOWN_TIMEOUT_MS,
// 5s) so a stuck stop() is reaped by the sidecar itself — killing from
// here only happens when even that deadline didn't fire (process wedged,
// e.g. an uninterruptible native call).
const GRACEFUL_EXIT_WAIT: Duration = Duration::from_secs(6);

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum StatusKind {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

#[derive(Clone, Serialize, Debug)]
pub struct SidecarStatus {
    pub kind: StatusKind,
    pub port: u16,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DshAuthInfo {
    #[serde(rename = "launchUrl")]
    pub launch_url: String,
    pub cookie: String,
}

/// Shared, thread-safe shell-side state about the sidecar process.
pub struct SidecarState {
    pub status: RwLock<SidecarStatus>,
    pub pid: RwLock<Option<u32>>,
    /// Port of the shell's control service (env to the sidecar as DSHD_DESKTOP_CONTROL_PORT).
    pub ctl_port: u16,
    pub ctl_token: String,
    /// Port the sidecar's control API listens on (reserved here, env
    /// DSHD_SIDECAR_CONTROL_PORT; corrected by the heartbeat when the
    /// sidecar's actual bind shifted). Consumed by the tray / shell windows.
    pub sidecar_api_port: std::sync::atomic::AtomicU16,
    /// Monotonic spawn counter — bumped on every respawn. Holders capture
    /// their own generation at spawn and ignore the exit of a previous
    /// sidecar after a restart (no bogus "意外退出" error window).
    pub generation: std::sync::atomic::AtomicU32,
    /// Unix-millis timestamp of when the current Starting phase began.
    /// Reset by mark_starting() so the health loop's 60s startup window is
    /// measured per-start, not per-shell-lifetime (restart would otherwise
    /// trip "启动超时" on the first !healthy poll after respawn).
    pub starting_at: std::sync::atomic::AtomicU64,
    /// Set when a user-initiated "restart service" respawns the sidecar; the
    /// health loop reloads the main window once the new service answers. The
    /// Webview does not reload on its own when dsh web comes back under it,
    /// so a restart (e.g. the plugin window's restart-after-install) would
    /// otherwise leave the user staring at the stale UI.
    pub reload_main_on_recover: std::sync::atomic::AtomicBool,
    /// DSH web authentication (0.1.2-alpha.1+): the launch token URL and the
    /// `dsh-auth-xxx` cookie derived from it. Pushed by the sidecar via
    /// POST /dsh-auth; used for the health probe and for the WebView URL.
    pub dsh_auth: RwLock<Option<DshAuthInfo>>,
}

impl SidecarState {
    pub async fn snapshot(&self) -> SidecarStatus {
        self.status.read().await.clone()
    }

    pub async fn set_kind(&self, kind: StatusKind) {
        self.status.write().await.kind = kind;
    }

    pub async fn set_error(&self, error: String) {
        let mut s = self.status.write().await;
        s.kind = StatusKind::Error;
        s.error = Some(error);
    }

    /// Enter the Starting state and start the health loop's startup window
    /// from now. Call on initial spawn and on every respawn.
    pub async fn mark_starting(&self, port: u16) {
        let mut s = self.status.write().await;
        s.kind = StatusKind::Starting;
        s.port = port;
        s.error = None;
        self.starting_at
            .store(unix_millis(), std::sync::atomic::Ordering::SeqCst);
    }
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// User-visible error text for shell dialogs / the tray status, in the
/// configured UI language.
fn err_text(key: &str, zh: bool) -> String {
    match (key, zh) {
        (
            "startup_timeout",
            true,
        ) => "后端服务启动超时（60 秒内未就绪）。请关闭其他 DeepSeek Harness 实例，或检查端口 3080 是否被其他程序占用。"
            .into(),
        (
            "startup_timeout",
            false,
        ) => "The backend service did not become ready within 60 seconds. Close other DeepSeek Harness instances or check whether port 3080 is in use by another program."
            .into(),
        ("crashed", true) => {
            "后端服务已停止运行。请点击「重启服务」重新启动。若反复出现，请检查端口 3080 是否被其他程序或残留进程占用。"
                .into()
        }
        ("crashed", false) => {
            "The backend service stopped unexpectedly. Click \"Restart Service\" to restart it. If this keeps happening, check whether port 3080 is held by a leftover process."
                .into()
        }
        ("spawn_failed", true) => "无法启动后端服务".into(),
        ("spawn_failed", false) => "Failed to start the backend service".into(),
        ("restart_failed", true) => "重新启动后端服务失败".into(),
        ("restart_failed", false) => "Failed to restart the backend service".into(),
        _ => key.into(),
    }
}

/// Synchronous snapshot for blocking contexts (tray menu events).
///
/// Deliberately lock-free: `block_on` panics when called from inside the
/// tokio runtime (health_loop / poll_config_loop call this via
/// `tray::rebuild`), which killed the health loop and left the tray stuck
/// on "服务启动中…". `try_read` never blocks and never panics; a write
/// hold is sub-millisecond (set_kind only), so a failed read is vanishingly
/// rare and degrades to the Starting label until the next rebuild.
pub fn take_snapshot(state: &SidecarState) -> SidecarStatus {
    match state.status.try_read() {
        Ok(guard) => guard.clone(),
        Err(_) => SidecarStatus {
            kind: StatusKind::Starting,
            port: 0,
            error: None,
        },
    }
}

/// Entry point: build state, start the control server, (spawn|probe) the
/// sidecar, then hand the process to a holder task and launch the health loop.
/// Returns once everything is scheduled; the health loop runs for the shell's
/// lifetime in its own task.
pub async fn init(app: &AppHandle) {
    let cfg = ShellConfig::load(app);
    let server_port = cfg.server_port;

    // The control server is started synchronously in setup (before the
    // splash is created, which loads its page from it). Reuse that instance.
    let (ctl_token, ctl_port) = if crate::ctl_server::port() != 0 {
        (
            crate::ctl_server::token().unwrap_or_default(),
            crate::ctl_server::port(),
        )
    } else {
        crate::ctl_server::init(app.clone())
    };
    let sidecar_api_port = reserve_port();
    let state = Arc::new(SidecarState {
        status: RwLock::new(SidecarStatus {
            kind: StatusKind::Starting,
            port: server_port,
            error: None,
        }),
        pid: RwLock::new(None),
        ctl_port,
        ctl_token,
        sidecar_api_port: std::sync::atomic::AtomicU16::new(sidecar_api_port),
        generation: std::sync::atomic::AtomicU32::new(1),
        starting_at: std::sync::atomic::AtomicU64::new(unix_millis()),
        reload_main_on_recover: std::sync::atomic::AtomicBool::new(false),
        dsh_auth: RwLock::new(None),
    });
    app.manage(state.clone());

    if cfg!(debug_assertions) {
        log::info!("sidecar: dev mode — beforeDevCommand sidecar expected on :{server_port}");
    } else {
        // Reclaim the port from an orphaned previous sidecar before spawning
        // (its shell is gone but node survived — the anti-orphan heartbeat
        // can miss a hard-killed shell, and a leftover listener turns every
        // subsequent launch into a startup failure).
        reap_orphan_sidecar(server_port);
        match spawn_sidecar(&cfg, &state) {
            Ok(child) => {
                let pid = child.id().unwrap_or(0);
                log::info!("sidecar: spawned node pid={pid} (gen 1)");
                *state.pid.write().await = Some(pid);
                spawn_holder(app.clone(), state.clone(), child, 1);
            }
            Err(e) => {
                log::error!("sidecar: spawn failed: {e}");
                let zh = is_zh(&app);
                state
                    .set_error(format!("{}: {e}", err_text("spawn_failed", zh)))
                    .await;
            }
        }
    }

    // Health loop + config mirror poll run for the whole shell lifetime.
    let app2 = app.clone();
    let state2 = state.clone();
    tauri::async_runtime::spawn(async move {
        health_loop(app2, state2, server_port).await;
    });
    tauri::async_runtime::spawn(crate::config::poll_config_loop(app.clone()));
}

/// Owner of the spawned Child: forwards stdout/stderr to sidecar.log, reaps the
/// process, and flips state to error on surprise death (unless a shutdown was
/// requested). Kill-on-shutdown is handled by `shutdown()` itself (taskkill),
/// so this task only reacts to the process exiting on its own — no Notify to
/// race with a respawned holder.
///
/// `generation` is the spawn counter captured at spawn time: when a previous
/// generation's process exits after a restart, this holder ignores it (the
/// new sidecar owns the state now). Without that check the old child's wait
/// would raise a bogus "意外退出" error window right after a clean restart.
fn spawn_holder(
    app: AppHandle,
    state: Arc<SidecarState>,
    mut child: tokio::process::Child,
    generation: u32,
) {
    let log_path = ShellConfig::load(&app).log_dir.join("sidecar.log");

    if let Some(stdout) = child.stdout.take() {
        let p = log_path.clone();
        tauri::async_runtime::spawn(async move {
            forward_output(stdout, p).await;
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let p = log_path.clone();
        tauri::async_runtime::spawn(async move {
            forward_output(stderr, p).await;
        });
    }

    let app2 = app.clone();
    let state2 = state.clone();
    tauri::async_runtime::spawn(async move {
        let status = child.wait().await;
        log::info!("sidecar: process exited ({status:?})");
        let current_gen = state2.generation.load(std::sync::atomic::Ordering::SeqCst);
        if current_gen != generation {
            log::info!("sidecar: stale holder (gen {generation}, now {current_gen}) — ignoring exit");
            return;
        }
        // Distinguish expected shutdown from crash. Stopped counts as
        // expected too: shutdown() force-flips the state when its taskkill
        // fallback outruns this holder, and the exit arrives afterwards —
        // treating it as a crash raised a bogus "服务异常" window after
        // every slow graceful stop.
        let kind = state2.snapshot().await.kind;
        match kind {
            StatusKind::Stopping | StatusKind::Stopped => {
                if kind == StatusKind::Stopping {
                    state2.set_kind(StatusKind::Stopped).await;
                }
            }
            _ => {
                log::error!("sidecar: process died unexpectedly (kind={kind:?})");
                let msg = err_text("crashed", is_zh(&app2));
                state2.set_error(msg.clone()).await;
                crate::windows::close_splash(&app2);
                let _ = crate::windows::show_error_window(&app2, &msg);
            }
        }
        crate::tray::rebuild(&app2, &DesktopConfig::load(&config_path(&app2)));
    });
}

/// Windows: tauri's resource_dir() returns `\\?\`-prefixed (verbatim) paths
/// which Node cannot resolve (EISDIR on the drive letter). Strip the prefix
/// before handing paths to the sidecar.
fn strip_verbatim(p: &std::path::Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return std::path::PathBuf::from(rest);
        }
    }
    p.to_path_buf()
}

fn spawn_sidecar(
    cfg: &ShellConfig,
    state: &Arc<SidecarState>,
) -> std::io::Result<tokio::process::Child> {
    let sidecar_dir = strip_verbatim(&cfg.resources_dir);
    let node = if cfg!(windows) {
        sidecar_dir.join("node.exe")
    } else {
        sidecar_dir.join("node")
    };
    // All paths handed to the sidecar must be verbatim-free (Node chokes on
    // `\\?\` prefixes).
    let data_dir = strip_verbatim(&cfg.data_dir);
    let log_dir = strip_verbatim(&cfg.log_dir);
    let locale = os_locale();

    let mut cmd = tokio::process::Command::new(node);
    // Entry must be a *relative* path with cwd = the sidecar root: Node 24 on
    // Windows mishandles an absolute entry path when the cwd differs (EISDIR
    // on the drive letter). index.js itself chdirs to server-dist, which is
    // where bootstrap expects to run.
    // Windows: a GUI process spawning a console app (node.exe) allocates a
    // new console window unless CREATE_NO_WINDOW is set — that black flash
    // at startup. tokio's Command implements std's CommandExt, so the flag
    // applies here too.
    #[cfg(windows)]
    {
        // tokio::process::Command has creation_flags as a native method —
        // no CommandExt import needed (std::process::Command does need it).
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.arg("index.js")
        .current_dir(&sidecar_dir)
        .env("DSHD_HOME", &data_dir)
        .env("DSHD_PORT", cfg.server_port.to_string())
        .env("DSHD_BIND_ADDRESS", "127.0.0.1")
        .env("DSHD_LOG_DIR", &log_dir)
        .env("DSHD_RESOURCES_DIR", sidecar_dir)
        // Engine runtime home: the sidecar resolves/spawns dsh from here
        // (seed-copied from DSHD_RESOURCES_DIR on first run, swapped in
        // place by engine updates). Stripped like every other path.
        .env("DSHD_ENGINE_DIR", strip_verbatim(&cfg.engine_dir))
        .env("DSHD_DESKTOP_CONTROL_PORT", state.ctl_port.to_string())
        .env(
            "DSHD_SIDECAR_CONTROL_PORT",
            state
                .sidecar_api_port
                .load(std::sync::atomic::Ordering::SeqCst)
                .to_string(),
        )
        .env("DSHD_CONTROL_TOKEN", &state.ctl_token)
        .env("DSHD_APP_VERSION", &cfg.app_version)
        .env("DSHD_OS_LOCALE", &locale)
        // OS dark preference for the sidecar's dialog theming ("system"
        // theme fallback) — Node cannot read the OS appearance directly.
        .env(
            "DSHD_OS_DARK",
            if crate::windows::system_dark() { "1" } else { "0" },
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = cmd.spawn()?;
    // Windows: put the sidecar in a kill-on-close job object so the OS
    // terminates it the instant the shell process dies — however it dies
    // (crash, taskkill from the NSIS uninstaller, tray quit). Without this
    // the sidecar lingers ~10s (3 missed 3s heartbeats, control-server.ts)
    // while holding server-dist as its cwd; the uninstaller starts deleting
    // files 500ms after killing the shell, fails on the locked tree, and the
    // whole sidecar\ directory stays behind on disk.
    #[cfg(windows)]
    assign_to_kill_on_close_job(&child);
    Ok(child)
}

/// Windows: the shared Job Object the sidecar is assigned to. Flagged
/// KILL_ON_JOB_CLOSE — when the shell exits (any path), its last handle to
/// the job closes and the OS force-terminates every process in it. One job
/// object covers all sidecar generations (spawn/restart), since the flag
/// only applies at job destruction, not per assignment.
#[cfg(windows)]
fn kill_on_close_job() -> windows_sys::Win32::Foundation::HANDLE {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // HANDLE is a raw pointer — not Send/Sync; wrap for static storage. The
    // handle lives for the whole shell process (the OS closes it at exit,
    // which is exactly what fires the kill-on-close).
    struct JobHandle(HANDLE);
    // SAFETY: the handle is only stored, never dereferenced; the OS owns it.
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: std::sync::OnceLock<JobHandle> = std::sync::OnceLock::new();
    JOB.get_or_init(|| unsafe {
        // SAFETY: CreateJobObjectW with a null name yields a fresh job handle
        // (or null on failure — checked below). Setting KILL_ON_JOB_CLOSE
        // flags the job so closing its last handle (at shell exit)
        // force-terminates children. Failure of the SET is tolerable: the
        // guarantee degrades to the heartbeat suicide; assignment proceeds.
        let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if !raw.is_null() {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let _ = SetInformationJobObject(
                raw,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
        }
        JobHandle(raw)
    }).0
}

/// Windows: assign a spawned sidecar to the shared kill-on-close job.
/// Best-effort — a failed assignment (e.g. the process sits in a
/// breakaway-restricted job already) only loses the auto-kill guarantee.
#[cfg(windows)]
fn assign_to_kill_on_close_job(child: &tokio::process::Child) {
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

    let job = kill_on_close_job();
    if job.is_null() {
        return;
    }
    // tokio's raw_handle() is Option: None only if the process handle was
    // already taken — impossible right after spawn.
    if let Some(handle) = child.raw_handle() {
        unsafe {
            // SAFETY: handle borrows the live process handle of the
            // just-spawned child; the job outlives this call (static), and
            // assignment after the process exits is a harmless no-op.
            let _ = AssignProcessToJobObject(job, handle);
        }
    }
}

/// Best-effort OS locale, mirroring Electron's `app.getLocale()`.
#[cfg(windows)]
fn os_locale() -> String {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
    let mut buf = [0u16; 85]; // LOCALE_NAME_MAX_LENGTH
    unsafe {
        GetUserDefaultLocaleName(buf.as_mut_ptr(), 85);
    }
    let s = String::from_utf16_lossy(&buf);
    let s = s.trim_end_matches('\0');
    if s.to_ascii_lowercase().starts_with("zh") {
        "zh-CN".into()
    } else {
        "en".into()
    }
}

/// macOS: GUI-launched apps (Finder/Dock) have no LANG/LC_ALL — the shell
/// never set them — so the env fallback below would always yield "en" even
/// on a Chinese-language system (updater dialogs / error window stayed
/// English until the user explicitly picked a language). Read the system's
/// preferred language list instead, mirroring Electron's app.getLocale().
/// `defaults read -g AppleLanguages` prints an array like:
///   (
///       "zh-Hans-CN",
///       en
///   )
#[cfg(target_os = "macos")]
fn os_locale() -> String {
    if let Ok(out) = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleLanguages"])
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            let t = line.trim().trim_matches(',').trim();
            if t.is_empty() || t == "(" || t == ")" {
                continue;
            }
            let lang = t.trim_matches('"');
            if lang.to_ascii_lowercase().starts_with("zh") {
                return "zh-CN".into();
            }
            return "en".into();
        }
    }
    std::env::var("LANG")
        .or_else(|_| std::env::var("LC_ALL"))
        .unwrap_or_else(|_| "en".to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn os_locale() -> String {
    std::env::var("LANG")
        .or_else(|_| std::env::var("LC_ALL"))
        .unwrap_or_else(|_| "en".to_string())
}

async fn forward_output<R: AsyncRead + Unpin + Send + 'static>(
    stream: R,
    log_path: PathBuf,
) {
    let mut lines = BufReader::new(stream).lines();
    let mut sink = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(f) => Some(f),
        Err(_) => None,
    };
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(f) = &mut sink {
            use std::io::Write;
            let _ = writeln!(f, "{line}");
        }
    }
}

/// Fetch the DSH cookie from the sidecar control API (race fallback when the
/// push via POST /dsh-auth has not yet arrived). Returns `Some(cookie)` if the
/// sidecar reports a token-bearing launch URL.
async fn fetch_dsh_cookie_from_sidecar(
    client: &reqwest::Client,
    state: &SidecarState,
) -> Option<String> {
    let port = state.sidecar_api_port.load(std::sync::atomic::Ordering::SeqCst);
    if port == 0 {
        return None;
    }
    let url = format!(
        "http://127.0.0.1:{port}/_desktop/dsh-auth?token={}",
        state.ctl_token
    );
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    let cookie = body.get("cookie")?.as_str()?;
    if cookie.is_empty() {
        return None;
    }
    // Cache it so subsequent probes don't re-fetch
    let launch_url = body.get("launchUrl")?.as_str().unwrap_or("").to_string();
    if !launch_url.is_empty() {
        let mut guard = state.dsh_auth.try_write().ok()?;
        *guard = Some(DshAuthInfo {
            launch_url,
            cookie: cookie.to_string(),
        });
    }
    Some(cookie.to_string())
}

async fn probe_dsh(client: &reqwest::Client, url: &str, state: &SidecarState) -> bool {
    // 1. Cached cookie (pushed via POST /dsh-auth or cached from fetch)
    if let Ok(guard) = state.dsh_auth.try_read() {
        if let Some(auth) = guard.as_ref() {
            if !auth.cookie.is_empty() {
                if let Ok(resp) = client.get(url).header("Cookie", &auth.cookie).send().await {
                    if resp.status().is_success() {
                        return true;
                    }
                }
                // Cookie present but probe failed — fall through to refresh/fallback
            }
        }
    }
    // 2. Try to fetch/refresh from the sidecar (covers the race)
    if let Some(cookie) = fetch_dsh_cookie_from_sidecar(client, state).await {
        if let Ok(resp) = client.get(url).header("Cookie", cookie).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
    }
    // 3. Plain probe — works for old engines (0.1.1-rc.2) without auth
    client
        .get(url)
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Endless health loop: drives the Starting → Running / Error state machine and
/// reveals the main window once the gateway answers.
async fn health_loop(app: AppHandle, state: Arc<SidecarState>, server_port: u16) {
    let client = match reqwest::Client::builder().timeout(HTTP_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            log::error!("sidecar: http client build failed: {e}");
            return;
        }
    };
    let url = format!("http://127.0.0.1:{server_port}/");

    let mut consecutive_failures: u32 = 0;

    loop {
        let healthy = probe_dsh(&client, &url, &state).await;
        let snapshot = state.snapshot().await;

        match snapshot.kind {
            StatusKind::Starting => {
                if healthy {
                    consecutive_failures = 0;
                    state.set_kind(StatusKind::Running).await;
                    log::info!("sidecar: healthy, starting to run");

                    // dsh is local-only: reveal the main window once the web
                    // server answers (no remote pre-flight, no first-run
                    // chooser — those were OhMyAgent gateway flows).
                    crate::windows::reveal_main_window(&app);

                    crate::tray::rebuild(&app, &DesktopConfig::load(&config_path(&app)));

                    // User-initiated restart: the main window was already
                    // visible under the old page — reload it so the fresh
                    // service (and any plugin changes) is what the user sees.
                    if state
                        .reload_main_on_recover
                        .swap(false, std::sync::atomic::Ordering::SeqCst)
                    {
                        if let Some(win) = app.get_webview_window(crate::windows::MAIN_LABEL) {
                            if win.is_visible().unwrap_or(false) {
                                // Navigate to the fresh WebUI URL. For a
                                // 0.1.2+ (token-gated) engine this now carries
                                // `?token=`, so the WebView does the 303 and
                                // plants the auth cookie. A bare `reload()`
                                // would repeat the OLD url and — post-swap —
                                // land on dsh's 401 page.
                                let target = crate::windows::webui_url(&app, true);
                                let _ = win.navigate(target.parse().expect("webui url"));
                            }
                        }
                        // The plugin-manager window pins the sidecar control
                        // port in its URL, which changes on respawn — a plain
                        // reload would keep the dead URL, so re-navigate it.
                        // This also clears the stuck "restarting…" state that
                        // a restart-killed in-flight request can leave behind.
                        crate::windows::repoint_plugins_window(&app, &state);
                    }
                } else {
                    // Startup window is measured from when THIS Starting phase
                    // began (mark_starting), not from shell launch — a
                    // user-initiated restart must get a fresh 60s window.
                    let started = state.starting_at.load(std::sync::atomic::Ordering::SeqCst);
                    let elapsed = unix_millis().saturating_sub(started);
                    if elapsed > STARTUP_WINDOW.as_millis() as u64 {
                        let err = err_text("startup_timeout", is_zh(&app));
                        log::error!("sidecar: startup timeout after {elapsed}ms");
                        state.set_error(err.clone()).await;
                        crate::windows::close_splash(&app);
                        let _ = crate::windows::show_error_window(&app, &err);
                    }
                }
            }
            StatusKind::Running => {
                if !healthy {
                    consecutive_failures += 1;
                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                        let err = "后端服务健康检查连续失败，服务可能已停止".to_string();
                        log::error!("sidecar: {err}");
                        state.set_error(err.clone()).await;
                        let _ = crate::windows::show_error_window(&app, &err);
                    }
                } else {
                    consecutive_failures = 0;
                }
            }
            StatusKind::Stopping => {
                if !healthy {
                    state.set_kind(StatusKind::Stopped).await;
                    crate::tray::rebuild(&app, &DesktopConfig::load(&config_path(&app)));
                }
            }
            StatusKind::Error => {
                // Restart is initiated elsewhere (tray); the
                // loop picks up the new Starting state once respawn happens.
                if healthy {
                    // Got healthy again (e.g. sidecar restarted externally).
                    state.set_kind(StatusKind::Running).await;
                }
            }
            StatusKind::Stopped => {
                // Idle until someone flips us back to Starting.
            }
        }
        sleep(POLL_INTERVAL).await;
    }
}

/// Graceful shutdown: ask the sidecar to stop() itself, wait briefly, then
/// force-kill the process tree as a fallback.
pub async fn shutdown(app: &AppHandle) {
    let state = app.state::<Arc<SidecarState>>().clone();
    let snapshot = state.snapshot().await;
    if snapshot.kind == StatusKind::Stopped {
        return;
    }
    state.set_kind(StatusKind::Stopping).await;

    // 1. Graceful: POST /_desktop/shutdown to the sidecar's control API.
    //    (Not the shell's own ctl_server — that one has no such route and a
    //    request there is a 404, which silently degraded every shutdown to the
    //    taskkill fallback below and could orphan the node process.)
    let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build();
    if let Ok(client) = client {
        let sidecar_port = state
            .sidecar_api_port
            .load(std::sync::atomic::Ordering::SeqCst);
        if sidecar_port != 0 {
            let url = format!("http://127.0.0.1:{sidecar_port}/_desktop/shutdown");
            let _ = client
                .post(&url)
                .bearer_auth(&state.ctl_token)
                .send()
                .await;
        }
    }

    // 2. Give the process a moment; the holder task flips state to Stopped
    //    once the child reaps. Return early only when the PID is really gone
    //    — not on the state alone, which the health loop can set (Stopping +
    //    unhealthy) while a stuck graceful stop keeps the process alive and
    //    holding the control port.
    let deadline = std::time::Instant::now() + GRACEFUL_EXIT_WAIT;
    loop {
        let gone = match *state.pid.read().await {
            Some(pid) => !pid_alive(pid),
            None => true,
        };
        if gone {
            return;
        }
        if std::time::Instant::now() > deadline {
            break;
        }
        sleep(Duration::from_millis(200)).await;
    }

    // 3. Fallback: kill the whole tree (harmless if the pid already exited).
    if let Some(pid) = *state.pid.read().await {
        log::warn!("sidecar: graceful exit timed out, killing pid={pid}");
        let _ = kill_process_tree(pid);
    }
    // The holder task flips state to Stopped once the child reaps; wait
    // briefly for that, then force it — a stuck Stopping state would leave
    // the tray label frozen and block the next restart.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if state.snapshot().await.kind == StatusKind::Stopped {
            return;
        }
        sleep(Duration::from_millis(200)).await;
    }
    if state.snapshot().await.kind != StatusKind::Stopped {
        log::warn!("sidecar: forced Stopped after kill (holder was slow)");
        state.set_kind(StatusKind::Stopped).await;
    }
}

/// Reserve an ephemeral port by binding and immediately dropping the listener.
/// The tiny race (another process grabbing it before the sidecar binds) is
/// acceptable for a local desktop app.
fn reserve_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(0)
}

/// Windows: if the server port is held by an orphaned sidecar from a previous
/// shell (command line matches our bundled `sidecar\node.exe index.js` and
/// its parent process is gone), kill it so this launch can bind. Runs once at
/// shell start — deterministic, unlike the sidecar's heartbeat.
#[cfg(windows)]
fn reap_orphan_sidecar(port: u16) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    // netstat/powershell are console apps; from a GUI shell they would each
    // flash a terminal window at startup without CREATE_NO_WINDOW.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let netstat = match Command::new("netstat")
        .arg("-ano")
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::piped())
        .output()
    {
        Ok(o) => o,
        Err(_) => return,
    };
    let text = String::from_utf8_lossy(&netstat.stdout);
    let Some(pid) = text.lines().find_map(|line| {
        if !line.contains(&format!(":{port}")) || !line.contains("LISTENING") {
            return None;
        }
        line.split_whitespace().last()?.parse::<u32>().ok()
    }) else {
        return; // port free — nothing to reap
    };
    if pid == std::process::id() {
        return;
    }
    // Identify our sidecar and check its parent is gone, via WMI. `$` in the
    // raw string are PowerShell variables.
    let script = format!(
        r#"$p = Get-CimInstance Win32_Process -Filter 'ProcessId={pid}' -ErrorAction SilentlyContinue
if ($p -and $p.CommandLine -like '*\sidecar\node.exe*index.js*') {{
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
  if (-not $parent) {{ 'ORPHAN' }}
}}"#
    );
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let orphan = out
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("ORPHAN"))
        .unwrap_or(false);
    if orphan {
        log::warn!("sidecar: port {port} held by orphaned sidecar pid={pid} — killing it");
        let _ = kill_process_tree(pid);
    }
}

/// Same port-reclaim semantics on macOS/Linux: the anti-orphan heartbeat can
/// miss a hard-killed shell, and a leftover listener would fail the next
/// launch (spawn error + error window) if it happens within the ~9s before
/// the orphaned node's heartbeat gives up. Simpler than Windows — node spawns
/// no child processes here, so a single SIGKILL suffices, and the current
/// shell hasn't spawned yet at this point, so a matching listener is by
/// definition an orphan.
#[cfg(not(windows))]
fn reap_orphan_sidecar(port: u16) {
    use std::process::Command;

    let out = match Command::new("lsof")
        .args(["-ti", &format!("tcp:{port}")])
        .stdout(Stdio::piped())
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return, // lsof unavailable or nothing listening
    };
    let text = String::from_utf8_lossy(&out.stdout);
    for pid in text.split_whitespace() {
        let ps = match Command::new("ps")
            .args(["-p", pid, "-o", "command="])
            .stdout(Stdio::piped())
            .output()
        {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
            _ => continue,
        };
        // The sidecar spawns `node index.js` (relative entry + cwd = sidecar
        // dir); a node process whose argv mentions index.js is ours.
        if ps.contains("index.js") {
            log::warn!("sidecar: port {port} held by orphaned sidecar pid={pid} — killing it");
            let _ = Command::new("kill")
                .args(["-9", pid])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

/// Is a pid still alive? shutdown() uses this instead of the state machine:
/// the health loop flips Stopping→Stopped whenever the server stops answering,
/// which races ahead of a stuck graceful stop (server.close() waits on
/// lingering SSE connections) — trusting that state alone used to skip the
/// kill, leaving the old process holding the control port so the respawn
/// crashed with EADDRINUSE.
#[cfg(not(windows))]
fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(true) // kill unavailable — assume alive, fall through to the kill
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::piped())
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()),
        Err(_) => true, // tasklist unavailable — assume alive, fall through to the kill
    }
}

/// Kill the sidecar process and its whole tree. Windows: `taskkill /T /F`;
/// other platforms: SIGKILL to the child (no process group is created).
#[cfg(windows)]
fn kill_process_tree(pid: u32) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    Ok(())
}

#[cfg(not(windows))]
fn kill_process_tree(pid: u32) -> std::io::Result<()> {
    std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()?;
    Ok(())
}

/// (Re)start the sidecar after an error or a user-initiated "restart service".
pub fn restart(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Arc<SidecarState>>().clone();

        if cfg!(debug_assertions) {
            // Dev: the sidecar is external (tsx watch); relaunching the shell is
            // the closest equivalent to a service restart.
            let exe = std::env::current_exe();
            if let Ok(exe) = exe {
                let _ = std::process::Command::new(exe).spawn();
                app.exit(0);
            }
            return;
        }

        // Tear down the current process, then respawn.
        let _ = shutdown(&app).await;

        let cfg = ShellConfig::load(&app);
        match spawn_sidecar(&cfg, &state) {
            Ok(child) => {
                let pid = child.id().unwrap_or(0);
                let generation = state.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                log::info!("sidecar: respawned pid={pid} (gen {generation})");
                *state.pid.write().await = Some(pid);
                spawn_holder(app.clone(), state.inner().clone(), child, generation);
                state.mark_starting(cfg.server_port).await;
                // Restart happened under a (visible) main window: once the
                // new service answers, the health loop reloads the page so
                // the user sees the fresh service instead of the stale UI.
                state.reload_main_on_recover.store(true, std::sync::atomic::Ordering::SeqCst);
                crate::tray::rebuild(&app, &DesktopConfig::load(&config_path(&app)));
            }
            Err(e) => {
                log::error!("sidecar: respawn failed: {e}");
                let zh = is_zh(&app);
                let msg = format!("{}: {e}", err_text("restart_failed", zh));
                state.set_error(msg.clone()).await;
                // Surface it like any other service failure — a silent
                // respawn error would leave the user on a dead UI.
                crate::windows::close_splash(&app);
                let _ = crate::windows::show_error_window(&app, &msg);
            }
        }
    });
}
