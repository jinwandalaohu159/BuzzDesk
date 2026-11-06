// The desktop as the user sees it, for the frosted glass: where the screens
// are, whether any window covers them, a screen capture, and a signature that
// changes whenever the wallpaper does (including Wallpaper Engine, which draws
// its wallpaper into the desktop window instead of setting a file).
use super::*;
use crate::backdrop::DesktopBackdropInfo;
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, SelectObject, SetBrushOrgEx, SetStretchBltMode,
    StretchBlt, HALFTONE, SRCCOPY,
};
use windows::Win32::System::Com::CLSCTX_ALL;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{DesktopWallpaper, IDesktopWallpaper};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE,
    WS_EX_TRANSPARENT,
};

// Windows smaller than this share of the screen (desktop widgets, overlays)
// do not block a snapshot; the blur hides them.
const BLOCKING_SHARE: f64 = 0.015;
// Live wallpaper hosts that render inside the desktop window.
const WALLPAPER_ENGINE_CLASS: &str = "WPEDesktopDX11Window";

struct Monitor {
    rect: RECT,
    wallpaper: String,
}

// Monitor rects from the shell's wallpaper object: physical pixels whatever the
// calling thread's DPI awareness, so they match the screen capture.
unsafe fn monitors(wallpaper: &IDesktopWallpaper) -> Vec<Monitor> {
    let count = wallpaper.GetMonitorDevicePathCount().unwrap_or(0);
    let mut monitors = Vec::new();
    for index in 0..count {
        let Ok(id) = wallpaper.GetMonitorDevicePathAt(index) else {
            continue;
        };
        let id_wide = to_wide(&take_pwstr(id));
        let Ok(rect) = wallpaper.GetMonitorRECT(PCWSTR(id_wide.as_ptr())) else {
            continue;
        };
        if rect.right <= rect.left || rect.bottom <= rect.top {
            continue;
        }
        let wallpaper = wallpaper
            .GetWallpaper(PCWSTR(id_wide.as_ptr()))
            .map(|value| take_pwstr(value))
            .unwrap_or_default();
        monitors.push(Monitor { rect, wallpaper });
    }
    monitors
}

fn virtual_rect(monitors: &[Monitor]) -> (i32, i32, i32, i32) {
    if monitors.is_empty() {
        return unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1),
                GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1),
            )
        };
    }
    let left = monitors.iter().map(|m| m.rect.left).min().unwrap_or(0);
    let top = monitors.iter().map(|m| m.rect.top).min().unwrap_or(0);
    let right = monitors.iter().map(|m| m.rect.right).max().unwrap_or(1);
    let bottom = monitors.iter().map(|m| m.rect.bottom).max().unwrap_or(1);
    (left, top, (right - left).max(1), (bottom - top).max(1))
}

unsafe fn desktop_wallpaper() -> Option<IDesktopWallpaper> {
    CoCreateInstance::<_, IDesktopWallpaper>(&DesktopWallpaper, None, CLSCTX_ALL).ok()
}

pub fn backdrop_info() -> Result<DesktopBackdropInfo, String> {
    let _com = ComApartment::enter();
    unsafe {
        let monitors = desktop_wallpaper().map(|wallpaper| monitors(&wallpaper)).unwrap_or_default();
        let (x, y, width, height) = virtual_rect(&monitors);

        // Windows' own wallpaper setting (path + timestamp only: a change of
        // wallpaper means a new snapshot is due).
        let mut signature = format!("{x},{y},{width},{height}|");
        for monitor in &monitors {
            let rect = monitor.rect;
            signature.push_str(&format!(
                "{},{},{},{}:{}@{}|",
                rect.left,
                rect.top,
                rect.right,
                rect.bottom,
                monitor.wallpaper,
                file_stamp(&monitor.wallpaper)
            ));
        }
        if let Some(position) = desktop_wallpaper().and_then(|wallpaper| wallpaper.GetPosition().ok()) {
            signature.push_str(&format!("pos{}|", position.0));
        }
        signature.push_str(&live_wallpaper_signature());

        Ok(DesktopBackdropInfo {
            virtual_x: x,
            virtual_y: y,
            virtual_width: width,
            virtual_height: height,
            layer_bleed: DESKTOP_LAYER_EDGE_BLEED_PX,
            signature,
        })
    }
}

// The whole desktop scaled to `target_width` (aspect kept), as RGBA. Only the
// geometry is looked up here: the caller has hidden its own window for this,
// so it must be quick.
pub fn capture_desktop(target_width: i32) -> Result<(u32, u32, Vec<u8>), String> {
    let (x, y, width, height) = {
        let _com = ComApartment::enter();
        let monitors = unsafe { desktop_wallpaper().map(|wallpaper| monitors(&wallpaper)).unwrap_or_default() };
        virtual_rect(&monitors)
    };
    let target_height = ((target_width as f64) * height as f64 / width.max(1) as f64).round().max(1.0) as i32;
    let pixels = capture_screen(x, y, width, height, target_width, target_height)?;
    Ok((target_width as u32, target_height as u32, pixels))
}

// Wallpaper Engine keeps the selected wallpaper per monitor in config.json
// next to its executable.
fn live_wallpaper_signature() -> String {
    let Some(hwnd) = (unsafe { find_desktop_child(WALLPAPER_ENGINE_CLASS) }) else {
        return String::new();
    };
    let Some(exe) = (unsafe { process_image(hwnd) }) else {
        return "wallpaper-engine".to_string();
    };
    let config = exe.with_file_name("config.json");
    let selected = fs::read(&config)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| find_key(&value, "selectedwallpapers").map(|found| found.to_string()))
        .unwrap_or_default();
    format!("wallpaper-engine:{selected}")
}

fn find_key<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    match value {
        serde_json::Value::Object(map) => map
            .get(key)
            .or_else(|| map.values().find_map(|child| find_key(child, key))),
        _ => None,
    }
}

// A child window of the shell desktop (WorkerW/Progman) with this class.
unsafe fn find_desktop_child(class: &str) -> Option<HWND> {
    struct Search<'a> {
        class: &'a str,
        found: Option<HWND>,
    }
    unsafe extern "system" fn child(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam.0 as *mut Search);
        if window_class_name(hwnd) == search.class {
            search.found = Some(hwnd);
            return BOOL(0);
        }
        BOOL(1)
    }
    unsafe extern "system" fn top(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let name = window_class_name(hwnd);
        if name == "WorkerW" || name == "Progman" {
            let _ = EnumChildWindows(Some(hwnd), Some(child), lparam);
            let search = &*(lparam.0 as *const Search);
            if search.found.is_some() {
                return BOOL(0);
            }
        }
        BOOL(1)
    }
    let mut search = Search { class, found: None };
    let _ = EnumWindows(Some(top), LPARAM(&mut search as *mut Search as isize));
    search.found
}

unsafe fn process_image(hwnd: HWND) -> Option<PathBuf> {
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buffer = [0u16; 1024];
    let mut len = buffer.len() as u32;
    let result = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut len);
    let _ = CloseHandle(process);
    result.ok()?;
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize])))
}

// True when no app window covers a meaningful part of the screen, so a
// screen snapshot shows the desktop itself.
pub fn desktop_uncovered() -> bool {
    unsafe { blocking_windows(1).is_empty() }
}

// Windows covering the desktop (class, title, rect), up to `limit`.
pub(super) unsafe fn blocking_windows(limit: usize) -> Vec<String> {
    struct Scan {
        screen: RECT,
        own_pid: u32,
        limit: usize,
        blockers: Vec<String>,
    }
    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let scan = &mut *(lparam.0 as *mut Scan);
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), 4).is_ok() && cloaked != 0 {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == scan.own_pid {
            return BOOL(1);
        }
        let class = window_class_name(hwnd);
        if matches!(
            class.as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
        ) {
            return BOOL(1);
        }
        // Click-through overlays (GPU/FPS overlays and the like) draw nothing solid.
        if GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TRANSPARENT.0 != 0 {
            return BOOL(1);
        }

        let mut rect = RECT::default();
        let framed = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&mut rect as *mut RECT).cast(),
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok();
        if !framed && GetWindowRect(hwnd, &mut rect).is_err() {
            return BOOL(1);
        }
        let screen = scan.screen;
        let overlap_w = (rect.right.min(screen.right) - rect.left.max(screen.left)).max(0) as f64;
        let overlap_h = (rect.bottom.min(screen.bottom) - rect.top.max(screen.top)).max(0) as f64;
        let screen_area = ((screen.right - screen.left) as f64 * (screen.bottom - screen.top) as f64).max(1.0);
        if overlap_w * overlap_h / screen_area > BLOCKING_SHARE {
            let mut title = [0u16; 128];
            let len = GetWindowTextW(hwnd, &mut title);
            scan.blockers.push(format!(
                "{class} \"{}\" {},{},{},{}",
                String::from_utf16_lossy(&title[..len.max(0) as usize]),
                rect.left,
                rect.top,
                rect.right,
                rect.bottom
            ));
            if scan.blockers.len() >= scan.limit {
                return BOOL(0);
            }
        }
        BOOL(1)
    }

    let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
    let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
    let mut scan = Scan {
        screen: RECT {
            left: x,
            top: y,
            right: x + GetSystemMetrics(SM_CXVIRTUALSCREEN),
            bottom: y + GetSystemMetrics(SM_CYVIRTUALSCREEN),
        },
        own_pid: std::process::id(),
        limit,
        blockers: Vec::new(),
    };
    let _ = EnumWindows(Some(visit), LPARAM(&mut scan as *mut Scan as isize));
    scan.blockers
}

// Screen region scaled down to target size, as RGBA.
pub(super) fn capture_screen(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    target_w: i32,
    target_h: i32,
) -> Result<Vec<u8>, String> {
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("screen unavailable".to_string());
        }
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, target_w, target_h);
        let previous = SelectObject(memory, bitmap.into());
        SetStretchBltMode(memory, HALFTONE);
        let _ = SetBrushOrgEx(memory, 0, 0, None);
        let copied = StretchBlt(memory, 0, 0, target_w, target_h, Some(screen), x, y, width, height, SRCCOPY);

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: target_w,
                // Negative height: top-down rows.
                biHeight: -target_h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (target_w * target_h * 4) as usize];
        SelectObject(memory, previous);
        let rows = GetDIBits(
            memory,
            bitmap,
            0,
            target_h as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);

        if !copied.as_bool() || rows == 0 {
            return Err("screen capture failed".to_string());
        }
        // BGRX -> RGBA
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        Ok(pixels)
    }
}

unsafe fn take_pwstr(value: PWSTR) -> String {
    if value.is_null() {
        return String::new();
    }
    let text = value.to_string().unwrap_or_default();
    CoTaskMemFree(Some(value.0 as *const _));
    text
}

fn file_stamp(path: &str) -> u64 {
    if path.is_empty() {
        return 0;
    }
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    // These read the live desktop: run explicitly with `-- --ignored`.
    #[test]
    #[ignore]
    fn describes_desktop_backdrop() {
        let info = super::backdrop_info().expect("backdrop info");
        println!("{info:#?}");
        println!("blocking windows: {:#?}", unsafe { super::blocking_windows(20) });
        assert!(info.virtual_width > 0 && info.virtual_height > 0);
    }

    #[test]
    #[ignore]
    fn captures_the_screen() {
        let pixels = super::capture_screen(0, 0, 400, 300, 40, 30).expect("capture");
        assert_eq!(pixels.len(), 40 * 30 * 4);
        assert!(pixels.chunks_exact(4).all(|pixel| pixel[3] == 255));
    }
}
