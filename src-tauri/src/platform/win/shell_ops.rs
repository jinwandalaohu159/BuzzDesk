// File operations on desktop items: open, copy/paste via the clipboard, create, rename, recycle.
use super::*;
use windows::Win32::Foundation::ERROR_CANCELLED;
use windows::Win32::UI::Shell::{FOF_WANTNUKEWARNING, SEE_MASK_NOASYNC};
use windows::Win32::UI::WindowsAndMessaging::{HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE};

pub(super) static COPIED_DESKTOP_ITEM: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn open_desktop_item(launch_id: &str) -> Result<(), String> {
    validate_launch_id(launch_id)?;
    let _com = ComApartment::enter();
    shell_execute_launch_id(launch_id, "open")
}

pub fn open_update_release_page(url: &str) -> Result<(), String> {
    let wide = to_wide(url);
    let operation = to_wide("open");

    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };

    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "ShellExecuteW open failed for update release page: code {}",
            result.0 as isize
        ))
    }
}

// Runs on worker threads (no message loop), so the shell must finish any
// asynchronous activation (DDE, property sheet setup) before returning.
pub(super) fn shell_execute_launch_id(launch_id: &str, verb: &str) -> Result<(), String> {
    let file = to_wide(launch_id);
    let operation = to_wide(verb);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: execute_mask(verb),
        lpVerb: PCWSTR(operation.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };

    match unsafe { ShellExecuteExW(&mut info) } {
        Ok(()) => return Ok(()),
        // The user said no (to a UAC prompt, say): don't ask a second time
        // through the pidl fallback.
        Err(error) if error.code() == ERROR_CANCELLED.to_hresult() => {
            return Err(format!("{verb} was cancelled for {launch_id}"));
        }
        Err(_) => {}
    }

    shell_execute_parsed_idlist(launch_id, verb)
        .map_err(|error| format!("ShellExecuteW {verb} failed for {launch_id}; {error}"))
}

pub(super) fn shell_execute_parsed_idlist(launch_id: &str, verb: &str) -> Result<(), String> {
    let _com = ComApartment::enter();
    unsafe { shell_execute_parsed_idlist_inner(launch_id, verb) }
}

pub(super) unsafe fn shell_execute_parsed_idlist_inner(launch_id: &str, verb: &str) -> Result<(), String> {
    let wide = to_wide(launch_id);
    let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
    SHParseDisplayName(
        PCWSTR(wide.as_ptr()),
        None::<&windows::Win32::System::Com::IBindCtx>,
        &mut pidl,
        0,
        None,
    )
    .map_err(|error| format!("SHParseDisplayName failed: {error}"))?;

    if pidl.is_null() {
        return Err("SHParseDisplayName returned an empty pidl".to_string());
    }

    let result = shell_execute_pidl(pidl, verb);
    ILFree(Some(pidl));
    result
}

pub(super) unsafe fn shell_execute_pidl(pidl: *mut ITEMIDLIST, verb: &str) -> Result<(), String> {
    let operation = to_wide(verb);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: execute_mask(verb) | SEE_MASK_IDLIST,
        lpVerb: PCWSTR(operation.as_ptr()),
        lpIDList: pidl as *mut c_void,
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };

    ShellExecuteExW(&mut info)
        .map_err(|error| format!("ShellExecuteExW {verb} failed: {error}"))
}

fn execute_mask(verb: &str) -> u32 {
    if verb == "properties" {
        SEE_MASK_NOASYNC | SEE_MASK_INVOKEIDLIST
    } else {
        SEE_MASK_NOASYNC
    }
}

pub fn copy_desktop_item(launch_id: &str) -> Result<(), String> {
    let path = desktop_item_path(launch_id)?;
    if !path.exists() {
        return Err("only real desktop files can be copied".to_string());
    }

    let mut copied = COPIED_DESKTOP_ITEM
        .lock()
        .map_err(|_| "copy buffer is unavailable".to_string())?;
    *copied = Some(path.clone());
    if let Err(error) = set_clipboard_file_paths(&[path]) {
        eprintln!("failed to write file copy to Windows clipboard: {error}");
    }
    Ok(())
}

pub fn paste_desktop_items() -> Result<(), String> {
    let sources = clipboard_file_paths()
        .unwrap_or_default()
        .into_iter()
        .filter(|path| path.exists())
        .collect::<Vec<_>>();
    let sources = if sources.is_empty() {
        let source = COPIED_DESKTOP_ITEM
            .lock()
            .map_err(|_| "copy buffer is unavailable".to_string())?
            .clone()
            .ok_or("nothing has been copied in BuzzDesk".to_string())?;

        if !source.exists() {
            return Err("copied item no longer exists".to_string());
        }

        vec![source]
    } else {
        sources
    };
    let target_dir = user_desktop_root().ok_or("user desktop folder not found")?;

    for source in sources {
        // Pasting a folder that contains the desktop (or the desktop itself)
        // would copy it into itself forever.
        if is_inside(&target_dir, &source) {
            return Err(format!("cannot paste {} into itself", source.display()));
        }
        let target = unique_copy_path(&target_dir, &source)?;
        copy_path_recursive(&source, &target)?;
    }

    Ok(())
}

// Whether `path` is `ancestor` or lies inside it.
pub(super) fn is_inside(path: &Path, ancestor: &Path) -> bool {
    match (path.canonicalize(), ancestor.canonicalize()) {
        (Ok(path), Ok(ancestor)) => path.starts_with(&ancestor),
        _ => false,
    }
}

// Symbolic links and junctions: never followed while copying (a junction
// pointing at a parent folder would recurse without end).
pub(super) fn is_link(path: &Path) -> bool {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    fs::symlink_metadata(path)
        .map(|metadata| {
            metadata.file_type().is_symlink() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        })
        .unwrap_or(false)
}

pub fn create_desktop_folder() -> Result<(), String> {
    let target_dir = user_desktop_root().ok_or("user desktop folder not found")?;
    let folder = unique_new_folder_path(&target_dir)?;
    fs::create_dir(&folder)
        .map_err(|error| format!("failed to create folder {}: {error}", folder.display()))
}

pub fn rename_desktop_item(launch_id: &str, name: &str) -> Result<DesktopItem, String> {
    let _com = ComApartment::enter();
    let name = name.trim();
    validate_file_name(name)?;
    let source = desktop_item_path(launch_id)?;
    if !source.exists() {
        return Err("desktop item no longer exists".to_string());
    }

    let parent = source
        .parent()
        .ok_or("desktop item has no parent folder".to_string())?;
    let target_name = rename_target_name(&source, name);
    validate_file_name(&target_name)?;
    let target = parent.join(target_name);
    if target == source {
        return Ok(desktop_item_for_path(source, true));
    }
    // A case-only change ("a.txt" -> "A.txt") finds the item itself.
    if target.exists() && !same_path_key(&target, &source) {
        return Err("another item already has that name".to_string());
    }

    fs::rename(&source, &target).map_err(|error| {
        format!(
            "failed to rename {} to {}: {error}",
            source.display(),
            target.display()
        )
    })?;

    Ok(desktop_item_for_path(target, true))
}

pub fn delete_desktop_item(launch_id: &str) -> Result<(), String> {
    let _com = ComApartment::enter();
    let path = desktop_item_path(launch_id)?;
    if !path.exists() {
        return Err("desktop item no longer exists".to_string());
    }

    let mut from = to_wide(&path.to_string_lossy());
    from.push(0);

    let mut operation = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        // No confirmation for the normal move to the Recycle Bin, but Windows
        // still asks before deleting permanently (an item the bin can't take).
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_WANTNUKEWARNING.0) as u16,
        ..Default::default()
    };

    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 {
        return Err(format!("failed to delete {}: {result}", path.display()));
    }
    if operation.fAnyOperationsAborted.as_bool() {
        return Err("delete operation was cancelled".to_string());
    }

    Ok(())
}

pub fn show_desktop_item_properties(launch_id: &str) -> Result<(), String> {
    validate_launch_id(launch_id)?;
    let _com = ComApartment::enter();
    shell_execute_launch_id(launch_id, "properties")
}

pub fn set_app_process_priority(priority: &str) -> Result<(), String> {
    let priority_class = match priority {
        "normal" => NORMAL_PRIORITY_CLASS,
        "aboveNormal" => ABOVE_NORMAL_PRIORITY_CLASS,
        "high" => HIGH_PRIORITY_CLASS,
        "realtime" => REALTIME_PRIORITY_CLASS,
        _ => return Err(format!("unsupported process priority: {priority}")),
    };

    unsafe {
        SetPriorityClass(GetCurrentProcess(), priority_class)
            .map_err(|error| format!("failed to set process priority: {error}"))
    }
}

pub(super) fn same_path_key(a: &Path, b: &Path) -> bool {
    let a = a
        .canonicalize()
        .unwrap_or_else(|_| a.to_path_buf())
        .to_string_lossy()
        .to_ascii_lowercase();
    let b = b
        .canonicalize()
        .unwrap_or_else(|_| b.to_path_buf())
        .to_string_lossy()
        .to_ascii_lowercase();
    a == b
}

pub(super) fn unique_copy_path(target_dir: &Path, source: &Path) -> Result<PathBuf, String> {
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("copied item has no file name")?;
    let stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(file_name);
    let extension = source.extension().and_then(|extension| extension.to_str());

    let mut candidate = target_dir.join(file_name);
    if !candidate.exists() {
        return Ok(candidate);
    }

    for index in 1..1000 {
        let suffix = if index == 1 {
            " - Copy".to_string()
        } else {
            format!(" - Copy ({index})")
        };
        let next_name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem}{suffix}.{extension}"),
            _ => format!("{stem}{suffix}"),
        };
        candidate = target_dir.join(next_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("unable to create a unique paste name".to_string())
}

pub(super) fn unique_new_folder_path(target_dir: &Path) -> Result<PathBuf, String> {
    let base_name = "\u{65b0}\u{5efa}\u{6587}\u{4ef6}\u{5939}";
    let mut candidate = target_dir.join(base_name);
    if !candidate.exists() {
        return Ok(candidate);
    }

    for index in 2..1000 {
        candidate = target_dir.join(format!("{base_name} ({index})"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("unable to create a unique folder name".to_string())
}

// Shortcut types whose extension the desktop hides or the user never means to
// change: renaming "Chrome" to "Chrome 2.0" must keep it "Chrome 2.0.lnk".
const SHORTCUT_EXTENSIONS: [&str; 3] = ["lnk", "url", "pif"];

pub(super) fn rename_target_name(source: &Path, name: &str) -> String {
    let name = name.trim();
    if source.is_dir() {
        return name.to_string();
    }

    let Some(extension) = source
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
    else {
        return name.to_string();
    };

    let suffix = format!(".{}", extension.to_lowercase());
    let lower = name.to_lowercase();
    let keeps_extension = lower.len() > suffix.len() && lower.ends_with(&suffix);
    let is_shortcut = SHORTCUT_EXTENSIONS
        .iter()
        .any(|shortcut| shortcut.eq_ignore_ascii_case(extension));
    if keeps_extension || (!is_shortcut && Path::new(name).extension().is_some()) {
        return name.to_string();
    }

    format!("{name}.{extension}")
}

pub(super) fn validate_file_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name cannot be empty".to_string());
    }

    let invalid = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    if name.chars().any(|character| invalid.contains(&character) || character.is_control()) {
        return Err("name contains invalid filename characters".to_string());
    }

    if name == "." || name == ".." || name.ends_with('.') {
        return Err("name is not valid for Windows files".to_string());
    }

    // Device names are reserved with any extension ("con.txt" too).
    let stem = name.split('.').next().unwrap_or(name).trim().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        return Err("name is reserved by Windows".to_string());
    }

    Ok(())
}

pub(super) fn copy_path_recursive(source: &Path, target: &Path) -> Result<(), String> {
    if is_link(source) {
        return Ok(());
    }

    if source.is_dir() {
        fs::create_dir(target).map_err(|error| {
            format!("failed to create folder {}: {error}", target.display())
        })?;

        for entry in fs::read_dir(source)
            .map_err(|error| format!("failed to read folder {}: {error}", source.display()))?
        {
            let entry =
                entry.map_err(|error| format!("failed to read folder entry: {error}"))?;
            let child_source = entry.path();
            let child_target = target.join(entry.file_name());
            copy_path_recursive(&child_source, &child_target)?;
        }

        return Ok(());
    }

    fs::copy(source, target)
        .map_err(|error| {
            format!(
                "failed to copy {} to {}: {error}",
                source.display(),
                target.display()
            )
        })
        .map(|_| ())
}

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

#[cfg(test)]
mod rename_tests {
    use super::{rename_target_name, validate_file_name};
    use std::path::Path;

    #[test]
    fn shortcuts_keep_their_extension() {
        let lnk = Path::new(r"C:\nowhere\Chrome.lnk");
        assert_eq!(rename_target_name(lnk, "Chrome 2.0"), "Chrome 2.0.lnk");
        assert_eq!(rename_target_name(lnk, "Chrome.lnk"), "Chrome.lnk");
        let url = Path::new(r"C:\nowhere\Docs.url");
        assert_eq!(rename_target_name(url, "Docs v1.5"), "Docs v1.5.url");
    }

    #[test]
    fn plain_files_keep_or_change_their_extension() {
        let txt = Path::new(r"C:\nowhere\notes.txt");
        assert_eq!(rename_target_name(txt, "todo"), "todo.txt");
        assert_eq!(rename_target_name(txt, "todo.md"), "todo.md");
        assert_eq!(rename_target_name(txt, "  spaced  "), "spaced.txt");
    }

    #[test]
    fn reserved_and_invalid_names_are_rejected() {
        for name in ["CON", "nul.txt", "com1", "LPT9.log", "a|b", "", "dots."] {
            assert!(validate_file_name(name).is_err(), "{name}");
        }
        for name in ["console", "com0", "LPT", "Node.js"] {
            assert!(validate_file_name(name).is_ok(), "{name}");
        }
    }
}
