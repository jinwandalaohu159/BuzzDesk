// Tauri command surface. Names and argument names are part of the frontend
// contract (`invoke("scan_desktop_items")` etc.); keep them stable.
//
// Tauri runs synchronous commands on the main (UI) thread. Anything that hits
// the disk, enumerates the shell or talks to Task Scheduler / the registry is `async` and runs on
// the blocking pool so the desktop never stalls. Commands that drive native UI
// owned by the layer window (context menus, window parenting, icon visibility)
// stay synchronous on the main thread.
use tauri::AppHandle;

use crate::{
    layer_window, platform, release, startup_log, state, DesktopDiagnostics, DesktopItem,
    NativeContextMenuItem, NativeContextMenuResult,
};

async fn run_blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("background task failed: {error}"))
}

// --- Desktop state -----------------------------------------------------------

#[tauri::command]
pub async fn load_desktop_state(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = state::state_path(&app)?;
    run_blocking(move || state::load(&path)).await?
}

#[tauri::command]
pub async fn save_desktop_state(app: AppHandle, state: serde_json::Value) -> Result<(), String> {
    let path = state::state_path(&app)?;
    run_blocking(move || state::save(&path, &state)).await?
}

#[tauri::command]
pub fn log_startup_event(event: String) {
    startup_log::trace_startup(event);
}

// --- Desktop items -----------------------------------------------------------

#[tauri::command]
pub async fn scan_desktop_items() -> Result<Vec<DesktopItem>, String> {
    run_blocking(platform::scan_desktop_items).await?
}

#[tauri::command]
pub async fn scan_desktop_items_fast() -> Result<Vec<DesktopItem>, String> {
    run_blocking(platform::scan_desktop_items_fast).await?
}

#[tauri::command]
pub async fn desktop_diagnostics(app: AppHandle) -> Result<DesktopDiagnostics, String> {
    #[cfg(windows)]
    let layer_hwnd = layer_window::main_window(&app)
        .ok()
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize);
    #[cfg(not(windows))]
    let layer_hwnd = {
        let _ = &app;
        None
    };

    run_blocking(move || platform::desktop_diagnostics(layer_hwnd)).await
}

// ShellExecute can stall for seconds (UNC paths, slow handlers, UAC).
#[tauri::command]
pub async fn open_desktop_item(launch_id: String) -> Result<(), String> {
    run_blocking(move || platform::open_desktop_item(&launch_id)).await?
}

#[tauri::command]
pub async fn copy_desktop_item(launch_id: String) -> Result<(), String> {
    run_blocking(move || platform::copy_desktop_item(&launch_id)).await?
}

#[tauri::command]
pub async fn paste_desktop_items() -> Result<(), String> {
    run_blocking(platform::paste_desktop_items).await?
}

#[tauri::command]
pub async fn create_desktop_folder() -> Result<(), String> {
    run_blocking(platform::create_desktop_folder).await?
}

#[tauri::command]
pub async fn rename_desktop_item(launch_id: String, name: String) -> Result<DesktopItem, String> {
    run_blocking(move || platform::rename_desktop_item(&launch_id, &name)).await?
}

#[tauri::command]
pub async fn delete_desktop_item(launch_id: String) -> Result<(), String> {
    run_blocking(move || platform::delete_desktop_item(&launch_id)).await?
}

#[tauri::command]
pub async fn show_desktop_item_properties(launch_id: String) -> Result<(), String> {
    run_blocking(move || platform::show_desktop_item_properties(&launch_id)).await?
}

// --- App settings ------------------------------------------------------------

#[tauri::command]
pub fn set_app_process_priority(priority: String) -> Result<(), String> {
    platform::set_app_process_priority(&priority)
}

#[tauri::command]
pub async fn get_startup_enabled() -> bool {
    run_blocking(platform::get_startup_enabled).await.unwrap_or(false)
}

#[tauri::command]
pub async fn set_startup_enabled(enabled: bool) -> Result<(), String> {
    run_blocking(move || platform::set_startup_enabled(enabled)).await?
}

#[tauri::command]
pub async fn repair_startup_entry() -> Result<bool, String> {
    run_blocking(platform::repair_startup_entry).await?
}

#[tauri::command]
pub fn open_update_release_page(url: Option<String>) -> Result<(), String> {
    let release_url = release::validate_release_page(url.as_deref().unwrap_or(release::LATEST_RELEASE_URL))?;
    platform::open_update_release_page(release_url.as_str())
}

// --- Native context menus (main thread: they own modal menu loops) ----------

#[tauri::command]
pub fn show_native_item_context_menu(
    app: AppHandle,
    launch_id: String,
    x: i32,
    y: i32,
) -> Result<NativeContextMenuResult, String> {
    let window = layer_window::main_window(&app)?;

    #[cfg(windows)]
    {
        let hwnd = window
            .hwnd()
            .map_err(|error| format!("failed to get main window hwnd: {error}"))?;
        platform::show_native_item_context_menu(&launch_id, hwnd, x, y)
    }

    #[cfg(not(windows))]
    {
        let _ = (window, launch_id, x, y);
        Ok(NativeContextMenuResult {
            invoked: false,
            verb: None,
        })
    }
}

#[tauri::command]
pub fn list_native_desktop_context_menu(app: AppHandle) -> Result<Vec<NativeContextMenuItem>, String> {
    let window = layer_window::main_window(&app)?;

    #[cfg(windows)]
    {
        let hwnd = window
            .hwnd()
            .map_err(|error| format!("failed to get main window hwnd: {error}"))?;
        platform::list_native_desktop_context_menu(hwnd)
    }

    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn invoke_native_desktop_context_menu_command(
    app: AppHandle,
    command_id: u32,
    label: Option<String>,
) -> Result<NativeContextMenuResult, String> {
    let window = layer_window::main_window(&app)?;

    #[cfg(windows)]
    {
        let hwnd = window
            .hwnd()
            .map_err(|error| format!("failed to get main window hwnd: {error}"))?;
        platform::invoke_native_desktop_context_menu_command(hwnd, command_id, label.as_deref())
    }

    #[cfg(not(windows))]
    {
        let _ = (window, command_id, label);
        Ok(NativeContextMenuResult {
            invoked: false,
            verb: None,
        })
    }
}

// --- Desktop layer window ----------------------------------------------------

#[tauri::command]
pub fn hide_native_desktop_icons() -> Result<(), String> {
    platform::set_native_desktop_icons_visible(false)
}

#[tauri::command]
pub fn show_native_desktop_icons() -> Result<(), String> {
    platform::set_native_desktop_icons_visible(true)
}

#[tauri::command]
pub fn show_desktop_layer_window(app: AppHandle) -> Result<bool, String> {
    layer_window::show(&layer_window::main_window(&app)?)
}

#[tauri::command]
pub fn attach_desktop_layer_window(app: AppHandle) -> Result<bool, String> {
    layer_window::attach(&layer_window::main_window(&app)?)
}
