// The Windows clipboard as a list of files (CF_HDROP), the way Explorer
// copies and pastes them.
use super::*;
use windows::Win32::UI::WindowsAndMessaging::{HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE};

// Another process may hold the clipboard for a moment; retry briefly.
fn open_clipboard_with_retry(owner: Option<HWND>) -> bool {
    for attempt in 0..8 {
        if unsafe { OpenClipboard(owner) }.is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(10 + attempt * 10));
    }
    false
}

struct ClipboardOwnerWindow(Option<HWND>);

impl ClipboardOwnerWindow {
    fn new() -> Self {
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                PCWSTR::null(),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
        };
        Self(hwnd.ok())
    }

    fn hwnd(&self) -> Option<HWND> {
        self.0
    }
}

impl Drop for ClipboardOwnerWindow {
    fn drop(&mut self) {
        if let Some(hwnd) = self.0 {
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
        }
    }
}

pub(super) fn clipboard_file_paths() -> Result<Vec<PathBuf>, String> {
    if !open_clipboard_with_retry(None) {
        return Ok(Vec::new());
    }

    let result = unsafe {
        let paths = if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_ok() {
            match GetClipboardData(CF_HDROP.0 as u32) {
                // DragQueryFileW takes the clipboard's HDROP handle itself.
                Ok(handle) if !handle.0.is_null() => hdrop_file_paths(HDROP(handle.0)),
                _ => Vec::new(),
            }
        } else {
            Vec::new()
        };

        let _ = CloseClipboard();
        paths
    };

    Ok(result)
}

pub(super) unsafe fn hdrop_file_paths(drop: HDROP) -> Vec<PathBuf> {
    let count = DragQueryFileW(drop, u32::MAX, None);
    let mut paths = Vec::new();

    for index in 0..count {
        let len = DragQueryFileW(drop, index, None);
        if len == 0 {
            continue;
        }

        let mut buffer = vec![0u16; len as usize + 1];
        let copied = DragQueryFileW(drop, index, Some(&mut buffer));
        if copied == 0 {
            continue;
        }

        paths.push(PathBuf::from(wide_buffer_to_string(&buffer)));
    }

    paths
}

pub(super) fn set_clipboard_file_paths(paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut file_list = Vec::<u16>::new();
    for path in paths {
        file_list.extend(path.as_os_str().encode_wide());
        file_list.push(0);
    }
    file_list.push(0);

    let header_size = std::mem::size_of::<DROPFILES>();
    let total_size = header_size + file_list.len() * std::mem::size_of::<u16>();
    let global = unsafe { GlobalAlloc(GMEM_MOVEABLE, total_size) }
        .map_err(|error| format!("GlobalAlloc failed: {error}"))?;

    let locked = unsafe { GlobalLock(global) };
    if locked.is_null() {
        unsafe {
            let _ = GlobalFree(Some(global));
        }
        return Err("GlobalLock failed".to_string());
    }

    unsafe {
        let header = DROPFILES {
            pFiles: header_size as u32,
            pt: POINT { x: 0, y: 0 },
            fNC: BOOL(0),
            fWide: BOOL(1),
        };
        std::ptr::write_unaligned(locked as *mut DROPFILES, header);
        std::ptr::copy_nonoverlapping(
            file_list.as_ptr(),
            (locked as *mut u8).add(header_size) as *mut u16,
            file_list.len(),
        );
        let _ = GlobalUnlock(global);
    }

    // EmptyClipboard makes the window passed to OpenClipboard the owner; with no
    // window, SetClipboardData is documented to fail. A throwaway message-only
    // window owns it for the duration; already-set data outlives that window.
    let owner = ClipboardOwnerWindow::new();
    if !open_clipboard_with_retry(owner.hwnd()) {
        unsafe {
            let _ = GlobalFree(Some(global));
        }
        return Err("OpenClipboard failed".to_string());
    }

    let result = unsafe {
        let result = EmptyClipboard()
            .and_then(|_| SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(global.0))));
        let _ = CloseClipboard();
        result
    };
    drop(owner);

    if let Err(error) = result {
        unsafe {
            let _ = GlobalFree(Some(global));
        }
        return Err(format!("SetClipboardData failed: {error}"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    // Overwrites the real clipboard: run explicitly with `-- --ignored`.
    #[test]
    #[ignore]
    fn writes_file_paths_to_windows_clipboard() {
        let path = std::env::temp_dir().join("buzzdesk-clipboard-probe.txt");
        std::fs::write(&path, b"probe").unwrap();
        super::set_clipboard_file_paths(std::slice::from_ref(&path)).expect("clipboard write");
        let read_back = super::clipboard_file_paths().expect("clipboard read");
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_back, vec![path]);
    }
}
