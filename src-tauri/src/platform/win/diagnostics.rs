// Startup diagnostics describing the shell desktop windows and scan results.
use super::*;

// Takes the layer window handle as an integer so callers can gather it on the
// main thread and run the (slow) scans elsewhere.
pub fn desktop_diagnostics(layer_hwnd: Option<isize>) -> DesktopDiagnostics {
    let layer_hwnd = layer_hwnd.map(|value| HWND(value as *mut c_void));
    let desktop_list_view_found = find_desktop_list_view().is_some();
    let desktop_host = ensure_desktop_host_window();
    let desktop_host_found = desktop_host.is_some();
    let virtual_screen_bounds = Some(virtual_screen_bounds());
    let desktop_host_bounds = desktop_host.and_then(window_bounds);
    let desktop_layer_bounds = layer_hwnd.and_then(window_bounds);
    let mut last_error = None;

    let shell_item_count = match scan_shell_desktop_items(false) {
        Ok(items) => Some(items.len()),
        Err(error) => {
            last_error = Some(error);
            None
        }
    };

    let fallback_item_count = match scan_desktop_file_items(false) {
        Ok(items) => Some(items.len()),
        Err(error) => {
            if let Some(existing) = last_error.as_mut() {
                existing.push_str(" | ");
                existing.push_str(&error);
            } else {
                last_error = Some(error);
            }
            None
        }
    };

    DesktopDiagnostics {
        desktop_list_view_found,
        desktop_host_found,
        virtual_screen_bounds,
        desktop_host_bounds,
        desktop_layer_bounds,
        shell_item_count,
        fallback_item_count,
        last_error,
    }
}
