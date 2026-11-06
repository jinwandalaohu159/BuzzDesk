// No-op platform layer so the crate builds and runs (as a browser-like preview) off Windows.
use crate::{DesktopDiagnostics, DesktopItem, NativeContextMenuResult};

pub fn scan_desktop_items() -> Result<Vec<DesktopItem>, String> {
    Ok(Vec::new())
}

pub fn scan_desktop_items_fast() -> Result<Vec<DesktopItem>, String> {
    scan_desktop_items()
}

pub fn desktop_diagnostics(_layer_hwnd: Option<isize>) -> DesktopDiagnostics {
    DesktopDiagnostics {
        desktop_list_view_found: false,
        desktop_host_found: false,
        virtual_screen_bounds: None,
        desktop_host_bounds: None,
        desktop_layer_bounds: None,
        shell_item_count: Some(0),
        fallback_item_count: Some(0),
        last_error: None,
    }
}

pub fn open_desktop_item(_launch_id: &str) -> Result<(), String> {
    Ok(())
}

pub fn copy_desktop_item(_launch_id: &str) -> Result<(), String> {
    Ok(())
}

pub fn paste_desktop_items() -> Result<(), String> {
    Ok(())
}

pub fn create_desktop_folder() -> Result<(), String> {
    Ok(())
}

pub fn rename_desktop_item(launch_id: &str, name: &str) -> Result<DesktopItem, String> {
    Ok(DesktopItem {
        id: format!("mock:{name}"),
        name: name.to_string(),
        kind: "file".to_string(),
        path: None,
        launch_id: launch_id.to_string(),
        icon_data_url: None,
        is_virtual: false,
    })
}

pub fn delete_desktop_item(_launch_id: &str) -> Result<(), String> {
    Ok(())
}

pub fn show_desktop_item_properties(_launch_id: &str) -> Result<(), String> {
    Ok(())
}

pub fn set_app_process_priority(_priority: &str) -> Result<(), String> {
    Ok(())
}

pub fn get_startup_enabled() -> bool {
    false
}

pub fn set_startup_enabled(_enabled: bool) -> Result<(), String> {
    Ok(())
}

pub fn enable_startup_for(_exe_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

pub fn repair_startup_entry() -> Result<bool, String> {
    Ok(false)
}

pub fn open_update_release_page(_url: &str) -> Result<(), String> {
    Ok(())
}

pub fn set_native_desktop_icons_visible(_visible: bool) -> Result<(), String> {
    Ok(())
}

pub fn claim_single_instance() -> bool {
    true
}

pub fn legacy_install() -> Option<crate::updater::legacy::LegacyInstall> {
    None
}

pub fn run_legacy_uninstall(
    _uninstaller: &std::path::Path,
    _location: &std::path::Path,
    _on_tick: impl Fn(std::time::Duration),
) -> Result<(), String> {
    Err("legacy cleanup is only supported on Windows".to_string())
}

pub fn wait_for_process_exit(_pid: u32, _timeout: std::time::Duration, _on_tick: impl Fn(std::time::Duration)) -> bool {
    true
}

pub fn run_installer_and_wait(installer: &std::path::Path, _on_tick: impl Fn(std::time::Duration)) -> Result<(), String> {
    let status = std::process::Command::new(installer)
        .arg("/S")
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("installer exited with {status}"))
    }
}

pub fn show_toast(_title: &str, _body: &str) -> Result<(), String> {
    Ok(())
}

pub fn backdrop_info() -> Result<crate::backdrop::DesktopBackdropInfo, String> {
    Err("desktop backdrop is only available on Windows".to_string())
}

pub fn desktop_uncovered() -> bool {
    false
}

pub fn capture_desktop(_target_width: i32) -> Result<(u32, u32, Vec<u8>), String> {
    Err("desktop backdrop is only available on Windows".to_string())
}
