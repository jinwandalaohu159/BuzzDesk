// Self-update pipeline:
//   1. `download` fetches the NSIS installer from a GitHub release into
//      %TEMP%\buzzdesk-update, streaming progress events to the frontend.
//   2. `helper` copies this executable to a helper exe (a different file name,
//      so the installer can neither lock nor kill it) and starts it in helper
//      mode; the main app exits.
//   3. The helper shows a small progress window, waits for the main process to
//      exit, runs the installer silently, then relaunches BuzzDesk.
//   `legacy` reuses the helper to remove an old per-machine install once.
pub mod download;
pub mod helper;
pub mod legacy;

use std::path::{Path, PathBuf};

pub use helper::{helper_args, run_helper};

const UPDATE_DIR_NAME: &str = "buzzdesk-update";
const HELPER_EXE_NAME: &str = "buzzdesk-update-helper.exe";

fn update_dir() -> PathBuf {
    std::env::temp_dir().join(UPDATE_DIR_NAME)
}

fn sanitize_installer_name(name: &str) -> Result<String, String> {
    let base = Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("invalid installer name")?;
    let lower = base.to_ascii_lowercase();
    if !lower.ends_with(".exe") || lower == HELPER_EXE_NAME {
        return Err("unsupported installer name".to_string());
    }

    Ok(base.to_string())
}

fn sanitize_version(version: &str) -> String {
    version
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '+'))
        .take(32)
        .collect()
}
