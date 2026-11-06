// The "main" webview window as the desktop layer: parented under the shell's
// desktop window, shown in place of the native icons, and restored on demand.
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::platform;

pub const MAIN_WINDOW_LABEL: &str = "main";

pub fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())
}

// Parents the window under the shell desktop. When that fails the window is
// hidden so it can never float above normal applications.
fn attach_to_shell_desktop(window: &WebviewWindow, show: bool) -> bool {
    let _ = window.set_resizable(false);

    #[cfg(windows)]
    let attached = match window.hwnd() {
        Ok(hwnd) => match platform::attach_window_to_desktop(hwnd, show) {
            Ok(()) => true,
            Err(error) => {
                eprintln!("failed to attach desktop layer window: {error}");
                false
            }
        },
        Err(error) => {
            eprintln!("failed to get desktop layer hwnd: {error}");
            false
        }
    };

    #[cfg(not(windows))]
    let attached = {
        let _ = show;
        true
    };

    if !attached {
        let _ = window.hide();
    }
    attached
}

pub fn attach(window: &WebviewWindow) -> Result<bool, String> {
    Ok(attach_to_shell_desktop(window, false))
}

pub fn show(window: &WebviewWindow) -> Result<bool, String> {
    if !attach_to_shell_desktop(window, true) {
        return Ok(false);
    }

    if let Err(error) = window.show() {
        let _ = window.hide();
        return Err(format!("failed to show desktop layer window: {error}"));
    }

    Ok(true)
}

// Hides the layer and brings back the native Windows desktop icons.
pub fn restore_native_desktop(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.hide();
    }

    let _ = platform::set_native_desktop_icons_visible(true);
}

// Re-shows the layer from the tray; any failure falls back to native icons.
pub fn show_virtual_desktop(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    if !matches!(attach(&window), Ok(true)) {
        let _ = platform::set_native_desktop_icons_visible(true);
        return;
    }

    if let Err(error) = platform::set_native_desktop_icons_visible(false) {
        eprintln!("failed to hide native desktop icons: {error}");
        let _ = window.hide();
        let _ = platform::set_native_desktop_icons_visible(true);
        return;
    }

    if !matches!(show(&window), Ok(true)) {
        let _ = window.hide();
        let _ = platform::set_native_desktop_icons_visible(true);
    }
}
