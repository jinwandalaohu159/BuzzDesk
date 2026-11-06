// The desktop as it looks right now, for the frontend's frosted glass.
//
// The layer window is transparent, so CSS backdrop-filter never sees what is
// behind it, and wallpapers are not always image files (Wallpaper Engine and
// friends render live). So the frontend hides its own icons for a moment and we
// snapshot the screen: whatever the user sees as their desktop is what the glass
// blurs. Snapshots are only taken while no window covers the desktop, and are
// cached until the wallpaper changes. The Windows side lives in
// platform/win/backdrop.rs.
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::platform;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBackdropInfo {
    // Physical-pixel virtual screen the snapshot covers.
    pub virtual_x: i32,
    pub virtual_y: i32,
    pub virtual_width: i32,
    pub virtual_height: i32,
    pub layer_bleed: i32,
    // Changes whenever the wallpaper or the monitor layout changes.
    pub signature: String,
}

// Snapshots are blurred heavily, so a small one is plenty.
const SNAPSHOT_WIDTH: i32 = 640;
const CACHE_FILE: &str = "desktop-backdrop.bin";

#[tauri::command]
pub async fn get_desktop_backdrop_info() -> Result<DesktopBackdropInfo, String> {
    run(platform::backdrop_info).await
}

// Cheap check the frontend polls before hiding its icons for a snapshot.
#[tauri::command]
pub async fn desktop_backdrop_clear() -> Result<bool, String> {
    run(|| Ok(platform::desktop_uncovered())).await
}

// Snapshot (RGBA, prefixed by width and height as little-endian u32), or an
// empty response when a window covers the desktop. The frontend hides its
// content until this returns, so the cache is written afterwards.
#[tauri::command]
pub async fn capture_desktop_backdrop(app: AppHandle, signature: String) -> Result<tauri::ipc::Response, String> {
    let cache = cache_path(&app);
    run(move || {
        if !platform::desktop_uncovered() {
            return Ok(tauri::ipc::Response::new(Vec::new()));
        }
        let (width, height, pixels) = platform::capture_desktop(SNAPSHOT_WIDTH)?;
        let payload = encode(width, height, &pixels);
        if let Some(cache) = cache {
            let mut file = signature.into_bytes();
            file.push(b'\n');
            file.extend_from_slice(&payload);
            std::thread::spawn(move || {
                let _ = std::fs::write(cache, file);
            });
        }
        Ok(tauri::ipc::Response::new(payload))
    })
    .await
}

// The cached snapshot, if it was taken for this exact wallpaper; else empty.
#[tauri::command]
pub async fn load_desktop_backdrop(app: AppHandle, signature: String) -> Result<tauri::ipc::Response, String> {
    let cache = cache_path(&app);
    run(move || {
        let Some(bytes) = cache.and_then(|path| std::fs::read(path).ok()) else {
            return Ok(tauri::ipc::Response::new(Vec::new()));
        };
        let Some(split) = bytes.iter().position(|byte| *byte == b'\n') else {
            return Ok(tauri::ipc::Response::new(Vec::new()));
        };
        if bytes[..split] != *signature.as_bytes() {
            return Ok(tauri::ipc::Response::new(Vec::new()));
        }
        Ok(tauri::ipc::Response::new(bytes[split + 1..].to_vec()))
    })
    .await
}

async fn run<T: Send + 'static>(task: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("desktop backdrop task failed: {error}"))?
}

fn cache_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(CACHE_FILE))
}

fn encode(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(8 + rgba.len());
    payload.extend_from_slice(&width.to_le_bytes());
    payload.extend_from_slice(&height.to_le_bytes());
    payload.extend_from_slice(rgba);
    payload
}
