// The update helper: this same executable, copied under another name and
// started with HELPER_FLAG. It shows a small progress window (updater.html),
// waits for BuzzDesk to exit, runs the installer (or the legacy uninstaller)
// and relaunches BuzzDesk.
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

use super::{sanitize_installer_name, sanitize_version, update_dir, HELPER_EXE_NAME};
use crate::{platform, startup_log::trace_startup};

const HELPER_FLAG: &str = "--buzzdesk-update-helper";
const HELPER_WINDOW_LABEL: &str = "updater";
// How long BuzzDesk gets to exit before the helper gives up.
const MAIN_EXIT_TIMEOUT: Duration = Duration::from_secs(15);

#[tauri::command]
pub fn launch_update_helper(app: AppHandle, file_name: String, version: String) -> Result<(), String> {
    let name = sanitize_installer_name(&file_name)?;
    let installer = update_dir().join(&name);
    if !installer.is_file() {
        return Err("downloaded installer not found".to_string());
    }

    spawn_helper_and_exit(
        app,
        &[
            "--mode".into(),
            "update".into(),
            "--installer".into(),
            installer.to_string_lossy().into_owned(),
            "--version".into(),
            sanitize_version(&version),
        ],
    )
}

// Copies this executable under another name and hands control to it. The copy
// is neither locked by the installer nor killed by it (NSIS kills processes by
// the main binary name), and it can show progress while BuzzDesk is closed.
pub(super) fn spawn_helper_and_exit(app: AppHandle, extra_args: &[String]) -> Result<(), String> {
    let current = std::env::current_exe()
        .map_err(|error| format!("failed to resolve current executable: {error}"))?;
    let dir = update_dir();
    fs::create_dir_all(&dir).map_err(|error| format!("failed to create update directory: {error}"))?;
    let helper = dir.join(HELPER_EXE_NAME);
    let _ = fs::remove_file(&helper);
    fs::copy(&current, &helper).map_err(|error| format!("failed to prepare update helper: {error}"))?;

    std::process::Command::new(&helper)
        .arg(HELPER_FLAG)
        .args(extra_args)
        .arg("--target")
        .arg(&current)
        .arg("--pid")
        .arg(std::process::id().to_string())
        .spawn()
        .map_err(|error| format!("failed to start update helper: {error}"))?;

    // Exiting restores the native desktop icons and releases our executable.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        app.exit(0);
    });

    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HelperMode {
    Update,
    Cleanup,
}

pub struct HelperArgs {
    mode: HelperMode,
    installer: PathBuf,
    location: Option<PathBuf>,
    target: PathBuf,
    pid: u32,
    version: String,
    restore_startup: bool,
}

pub fn helper_args() -> Option<HelperArgs> {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|arg| arg == HELPER_FLAG) {
        return None;
    }

    let value_of = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };

    Some(HelperArgs {
        mode: if value_of("--mode").as_deref() == Some("cleanup") {
            HelperMode::Cleanup
        } else {
            HelperMode::Update
        },
        installer: PathBuf::from(value_of("--installer")?),
        location: value_of("--location").map(PathBuf::from),
        target: PathBuf::from(value_of("--target")?),
        pid: value_of("--pid").and_then(|value| value.parse().ok()).unwrap_or(0),
        version: sanitize_version(&value_of("--version").unwrap_or_default()),
        restore_startup: value_of("--restore-startup").as_deref() == Some("1"),
    })
}

// --- progress shown by updater.html ------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperStatus {
    mode: &'static str,
    stage: &'static str,
    progress: f64,
    message: String,
    version: String,
    failed: bool,
}

static HELPER_STATUS: Mutex<Option<HelperStatus>> = Mutex::new(None);
static HELPER_MODE: Mutex<&'static str> = Mutex::new("update");

fn set_helper_status(stage: &'static str, progress: f64, message: &str, version: &str, failed: bool) {
    let mode = HELPER_MODE.lock().map(|mode| *mode).unwrap_or("update");
    if let Ok(mut status) = HELPER_STATUS.lock() {
        *status = Some(HelperStatus {
            mode,
            stage,
            progress: progress.clamp(0.0, 1.0),
            message: message.to_string(),
            version: version.to_string(),
            failed,
        });
    }
}

#[tauri::command]
pub fn update_helper_status() -> Option<HelperStatus> {
    HELPER_STATUS.lock().ok().and_then(|status| status.clone())
}

// --- the helper process ------------------------------------------------------

pub fn run_helper(args: HelperArgs, context: tauri::Context<tauri::Wry>) {
    if let Ok(mut mode) = HELPER_MODE.lock() {
        *mode = if args.mode == HelperMode::Cleanup { "cleanup" } else { "update" };
    }
    set_helper_status("waiting", 0.02, "正在关闭 BuzzDesk…", &args.version, false);

    let mut args = Some(args);
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![update_helper_status])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, HELPER_WINDOW_LABEL, WebviewUrl::App("updater.html".into()))
                .title("BuzzDesk 更新")
                .inner_size(420.0, 176.0)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(false)
                .center()
                .build()?;

            if let Some(args) = args.take() {
                let handle = app.handle().clone();
                std::thread::spawn(move || helper_worker(handle, args));
            }
            Ok(())
        })
        .build(context)
        .expect("failed to build BuzzDesk update helper");

    app.run(|_, _| {});
}

fn helper_worker(app: AppHandle, args: HelperArgs) {
    let version = args.version.clone();
    let started = Instant::now();

    let main_exited = platform::wait_for_process_exit(args.pid, MAIN_EXIT_TIMEOUT, |elapsed| {
        let ratio = (elapsed.as_secs_f64() / 3.0).min(1.0);
        set_helper_status("waiting", 0.02 + ratio * 0.08, "正在关闭 BuzzDesk…", &version, false);
    });
    if !main_exited {
        // BuzzDesk is still running: installing over it would fail half-way,
        // and it needs no relaunch.
        trace_startup("update-helper:main process did not exit; giving up");
        set_helper_status("done", 1.0, "BuzzDesk 仍在运行，已取消本次更新", &version, true);
        std::thread::sleep(Duration::from_millis(2200));
        app.exit(0);
        return;
    }
    // Give Explorer a beat to repaint the native icons before the installer runs.
    std::thread::sleep(Duration::from_millis(300));

    let (working, failure, success) = match args.mode {
        HelperMode::Update => ("正在安装新版本…", "更新未完成，正在恢复 BuzzDesk…", "更新完成"),
        HelperMode::Cleanup => (
            "正在清理旧版本（请在系统弹窗中确认）…",
            "旧版本未清理，正在恢复 BuzzDesk…",
            "旧版本已清理",
        ),
    };

    set_helper_status("installing", 0.12, working, &version, false);
    let on_tick = |elapsed: Duration| {
        // NSIS silent runs report no progress; ease toward 88% while it runs.
        let eased = 1.0 - (-elapsed.as_secs_f64() / 9.0).exp();
        set_helper_status("installing", 0.12 + eased * 0.76, working, &version, false);
    };
    let result = match args.mode {
        HelperMode::Update => platform::run_installer_and_wait(&args.installer, on_tick),
        HelperMode::Cleanup => match args.location.as_deref() {
            Some(location) => platform::run_legacy_uninstall(&args.installer, location, on_tick),
            None => Err("legacy install location missing".to_string()),
        },
    };

    let failed = result.is_err();
    if let Err(error) = &result {
        trace_startup(format!("update-helper:step failed: {error}"));
        set_helper_status("failed", 0.9, failure, &version, true);
        std::thread::sleep(Duration::from_millis(1200));
    } else {
        set_helper_status("launching", 0.92, "正在重新启动 BuzzDesk…", &version, false);
    }

    // The legacy cleanup removes the logon task (old and new share its name);
    // recreate it for the per-user copy (no elevation needed).
    if args.mode == HelperMode::Cleanup && args.restore_startup {
        restore_startup_entry(&args.target);
    }

    relaunch(&args.target);

    let message = match (args.mode, failed) {
        (HelperMode::Update, true) => "已恢复旧版本",
        (HelperMode::Cleanup, true) => "已保留旧版本",
        _ => success,
    };
    set_helper_status("done", 1.0, message, &version, failed);

    // Keep the finished state on screen briefly so the bar visibly completes.
    let minimum_visible = Duration::from_millis(1800);
    let remaining = minimum_visible.saturating_sub(started.elapsed());
    std::thread::sleep(remaining.max(Duration::from_millis(900)));
    if args.mode == HelperMode::Update {
        let _ = fs::remove_file(&args.installer);
    }
    app.exit(0);
}

fn restore_startup_entry(target: &Path) {
    for attempt in 1..=2 {
        match platform::enable_startup_for(target) {
            Ok(()) => return,
            Err(error) => trace_startup(format!("update-helper:restore startup attempt {attempt} failed: {error}")),
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn relaunch(target: &Path) {
    let mut command = std::process::Command::new(target);
    if let Some(dir) = target.parent() {
        command.current_dir(dir);
    }
    if let Err(error) = command.spawn() {
        trace_startup(format!("update-helper:failed to relaunch BuzzDesk: {error}"));
    }
}
