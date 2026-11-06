// Versions up to 0.1.4 installed per-machine, which made every update ask for
// administrator rights. Newer builds install per-user; this finds a leftover
// per-machine copy so it can be removed once (one elevation, ever).
use serde::Serialize;
use tauri::AppHandle;

use super::helper::spawn_helper_and_exit;
use crate::platform;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyInstall {
    pub(crate) version: String,
    pub(crate) location: String,
    pub(crate) uninstaller: String,
}

#[tauri::command]
pub async fn detect_legacy_install() -> Option<LegacyInstall> {
    tauri::async_runtime::spawn_blocking(platform::legacy_install)
        .await
        .ok()
        .flatten()
}

#[tauri::command]
pub async fn cleanup_legacy_install(app: AppHandle, restore_startup: bool) -> Result<(), String> {
    let (legacy, startup_entry_exists) =
        tauri::async_runtime::spawn_blocking(|| (platform::legacy_install(), platform::get_startup_enabled()))
            .await
            .map_err(|error| format!("legacy cleanup task failed: {error}"))?;
    let legacy = legacy.ok_or("no legacy installation found")?;
    // The cleanup deletes the logon task by name, which the per-user install
    // shares: put it back if the user has one now, whatever the frontend's
    // (possibly stale) setting says.
    let restore = restore_startup || startup_entry_exists;
    spawn_helper_and_exit(
        app,
        &[
            "--mode".into(),
            "cleanup".into(),
            "--installer".into(),
            legacy.uninstaller,
            "--location".into(),
            legacy.location,
            "--restore-startup".into(),
            if restore { "1".into() } else { "0".into() },
        ],
    )
}
