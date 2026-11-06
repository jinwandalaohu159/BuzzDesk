// Desktop host window discovery and parenting the layer window under the shell desktop.
use super::*;

pub(super) const DESKTOP_LAYER_EDGE_BLEED_PX: i32 = 20;

pub(super) static LAYER_WINDOW_PROCS: OnceLock<Mutex<HashMap<isize, isize>>> = OnceLock::new();

pub(super) unsafe fn install_desktop_layer_hit_test_guard(hwnd: HWND) {
    let key = hwnd.0 as isize;
    let procs = LAYER_WINDOW_PROCS.get_or_init(|| Mutex::new(HashMap::new()));
    if procs
        .lock()
        .map(|guard| guard.contains_key(&key))
        .unwrap_or(false)
    {
        return;
    }

    let previous_proc = SetWindowLongPtrW(
        hwnd,
        GWLP_WNDPROC,
        desktop_layer_window_proc as *const () as usize as isize,
    );
    if previous_proc == 0 {
        return;
    }

    if let Ok(mut guard) = procs.lock() {
        guard.insert(key, previous_proc);
    }
}

pub(super) unsafe extern "system" fn desktop_layer_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCHITTEST {
        return LRESULT(HTCLIENT as isize);
    }

    let key = hwnd.0 as isize;
    let previous_proc = LAYER_WINDOW_PROCS
        .get()
        .and_then(|procs| procs.lock().ok().and_then(|guard| guard.get(&key).copied()))
        .unwrap_or(0);

    if previous_proc == 0 {
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }

    let previous_proc: WNDPROC = unsafe { std::mem::transmute(previous_proc) };
    unsafe { CallWindowProcW(previous_proc, hwnd, message, wparam, lparam) }
}

pub fn set_native_desktop_icons_visible(visible: bool) -> Result<(), String> {
    let hwnd = find_desktop_list_view().ok_or("desktop list view not found")?;
    unsafe {
        let _ = ShowWindow(hwnd, if visible { SW_SHOW } else { SW_HIDE });
    }
    Ok(())
}

pub fn attach_window_to_desktop(hwnd: HWND, show: bool) -> Result<(), String> {
    let parent = ensure_desktop_host_window().ok_or("desktop host window not found")?;

    unsafe {
        let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
        let visible_style = if show { WS_VISIBLE.0 } else { 0 };
        let desktop_style = (style
            & !WS_POPUP.0
            & !WS_CAPTION.0
            & !WS_SYSMENU.0
            & !WS_THICKFRAME.0
            & !WS_MINIMIZEBOX.0
            & !WS_MAXIMIZEBOX.0)
            | WS_CHILD.0
            | visible_style;
        let _ = SetWindowLongW(hwnd, GWL_STYLE, desktop_style as i32);
        install_desktop_layer_hit_test_guard(hwnd);

        SetParent(hwnd, Some(parent)).map_err(|error| format!("SetParent failed: {error}"))?;

        let (x, y, width, height) = desktop_layer_bounds(parent);
        let show_flag = if show { SWP_SHOWWINDOW } else { SWP_NOACTIVATE };
        SetWindowPos(
            hwnd,
            None,
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_FRAMECHANGED | show_flag,
        )
        .map_err(|error| format!("SetWindowPos failed: {error}"))?;
    }

    Ok(())
}

pub(super) unsafe fn desktop_layer_bounds(parent: HWND) -> (i32, i32, i32, i32) {
    let mut rect = RECT::default();
    if GetClientRect(parent, &mut rect).is_ok() {
        let width = (rect.right - rect.left).max(1);
        let height = (rect.bottom - rect.top).max(1);
        return (
            -DESKTOP_LAYER_EDGE_BLEED_PX,
            -DESKTOP_LAYER_EDGE_BLEED_PX,
            width + DESKTOP_LAYER_EDGE_BLEED_PX * 2,
            height + DESKTOP_LAYER_EDGE_BLEED_PX * 2,
        );
    }

    (
        GetSystemMetrics(SM_XVIRTUALSCREEN) - DESKTOP_LAYER_EDGE_BLEED_PX,
        GetSystemMetrics(SM_YVIRTUALSCREEN) - DESKTOP_LAYER_EDGE_BLEED_PX,
        GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1) + DESKTOP_LAYER_EDGE_BLEED_PX * 2,
        GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1) + DESKTOP_LAYER_EDGE_BLEED_PX * 2,
    )
}

pub(super) fn virtual_screen_bounds() -> WindowBounds {
    unsafe {
        WindowBounds {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN).max(0),
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN).max(0),
        }
    }
}

pub(super) fn window_bounds(hwnd: HWND) -> Option<WindowBounds> {
    unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }

        Some(WindowBounds {
            x: rect.left,
            y: rect.top,
            width: (rect.right - rect.left).max(0),
            height: (rect.bottom - rect.top).max(0),
        })
    }
}

pub(super) fn ensure_desktop_host_window() -> Option<HWND> {
    unsafe {
        let progman = FindWindowW(w!("Progman"), PCWSTR::null()).ok()?;
        let mut result = 0usize;
        let _ = SendMessageTimeoutW(
            progman,
            0x052C,
            WPARAM(0),
            LPARAM(0),
            SMTO_NORMAL,
            1000,
            Some(&mut result),
        );

        let preferred = find_shell_desktop_host()
            .or_else(find_workerw_desktop_host)
            .or(Some(progman))?;

        if window_covers_virtual_screen(preferred) {
            return Some(preferred);
        }

        if let Some(full_size_worker) = find_full_size_workerw_host() {
            return Some(full_size_worker);
        }

        if window_covers_virtual_screen(progman) {
            return Some(progman);
        }

        Some(preferred)
    }
}

pub(super) fn window_covers_virtual_screen(hwnd: HWND) -> bool {
    let Some(bounds) = window_bounds(hwnd) else {
        return false;
    };
    let screen = virtual_screen_bounds();
    const TOLERANCE_PX: i32 = 2;

    bounds.x <= screen.x + TOLERANCE_PX
        && bounds.y <= screen.y + TOLERANCE_PX
        && bounds.x + bounds.width >= screen.x + screen.width - TOLERANCE_PX
        && bounds.y + bounds.height >= screen.y + screen.height - TOLERANCE_PX
}

pub(super) fn find_shell_desktop_host() -> Option<HWND> {
    unsafe {
        if let Ok(progman) = FindWindowW(w!("Progman"), PCWSTR::null()) {
            if find_shell_def_view(progman).is_some() {
                return Some(progman);
            }
        }
    }

    let mut found = HWND(std::ptr::null_mut());
    unsafe {
        let _ = EnumWindows(
            Some(enum_shell_desktop_host),
            LPARAM(&mut found as *mut HWND as isize),
        );
    }

    if found.0.is_null() {
        None
    } else {
        Some(found)
    }
}

pub(super) unsafe extern "system" fn enum_shell_desktop_host(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if window_class_name(hwnd) == "WorkerW" && find_shell_def_view(hwnd).is_some() {
        let output = lparam.0 as *mut HWND;
        *output = hwnd;
        return BOOL(0);
    }

    BOOL(1)
}

pub(super) fn find_workerw_desktop_host() -> Option<HWND> {
    let mut search = WorkerSearch {
        saw_shell_view: false,
        first_plain_worker: HWND(std::ptr::null_mut()),
        host: HWND(std::ptr::null_mut()),
    };

    unsafe {
        let _ = EnumWindows(
            Some(enum_worker_desktop_host),
            LPARAM(&mut search as *mut WorkerSearch as isize),
        );
    }

    if !search.host.0.is_null() {
        Some(search.host)
    } else if !search.first_plain_worker.0.is_null() {
        Some(search.first_plain_worker)
    } else {
        None
    }
}

pub(super) struct WorkerSearch {
    saw_shell_view: bool,
    first_plain_worker: HWND,
    host: HWND,
}

pub(super) unsafe extern "system" fn enum_worker_desktop_host(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if window_class_name(hwnd) != "WorkerW" {
        return BOOL(1);
    }

    let search = &mut *(lparam.0 as *mut WorkerSearch);
    if find_shell_def_view(hwnd).is_some() {
        search.saw_shell_view = true;
        return BOOL(1);
    }

    if search.first_plain_worker.0.is_null() {
        search.first_plain_worker = hwnd;
    }

    if search.saw_shell_view {
        search.host = hwnd;
        return BOOL(0);
    }

    BOOL(1)
}

pub(super) fn find_full_size_workerw_host() -> Option<HWND> {
    let mut found = HWND(std::ptr::null_mut());
    unsafe {
        let _ = EnumWindows(
            Some(enum_full_size_workerw_host),
            LPARAM(&mut found as *mut HWND as isize),
        );
    }

    if found.0.is_null() {
        None
    } else {
        Some(found)
    }
}

pub(super) unsafe extern "system" fn enum_full_size_workerw_host(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if window_class_name(hwnd) == "WorkerW" && window_covers_virtual_screen(hwnd) {
        let output = lparam.0 as *mut HWND;
        *output = hwnd;
        return BOOL(0);
    }

    BOOL(1)
}

pub(super) fn find_desktop_list_view() -> Option<HWND> {
    unsafe {
        if let Ok(progman) = FindWindowW(w!("Progman"), PCWSTR::null()) {
            let direct = find_shell_list_view(progman);
            if direct.is_some() {
                return direct;
            }
        }
    }

    let mut found = HWND(std::ptr::null_mut());
    unsafe {
        let _ = EnumWindows(
            Some(enum_worker_windows),
            LPARAM(&mut found as *mut HWND as isize),
        );
    }

    if found.0.is_null() {
        None
    } else {
        Some(found)
    }
}

pub(super) unsafe extern "system" fn enum_worker_windows(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if window_class_name(hwnd) == "WorkerW" {
        if let Some(list) = find_shell_list_view(hwnd) {
            let output = lparam.0 as *mut HWND;
            *output = list;
            return BOOL(0);
        }
    }

    BOOL(1)
}

pub(super) unsafe fn window_class_name(hwnd: HWND) -> String {
    let mut class_name = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut class_name);
    String::from_utf16_lossy(&class_name[..len as usize])
}

pub(super) unsafe fn find_shell_list_view(parent: HWND) -> Option<HWND> {
    let def_view = find_shell_def_view(parent)?;
    FindWindowExW(Some(def_view), None, w!("SysListView32"), PCWSTR::null()).ok()
}

pub(super) unsafe fn find_shell_def_view(parent: HWND) -> Option<HWND> {
    if parent.0.is_null() {
        return None;
    }

    FindWindowExW(Some(parent), None, w!("SHELLDLL_DefView"), PCWSTR::null()).ok()
}
