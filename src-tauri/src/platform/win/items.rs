// Desktop item discovery: file-system and shell enumeration of the user and public desktops.
use super::*;

pub fn scan_desktop_items() -> Result<Vec<DesktopItem>, String> {
    let _com = ComApartment::enter();
    scan_desktop_items_with_icons(true)
}

pub fn scan_desktop_items_fast() -> Result<Vec<DesktopItem>, String> {
    let _com = ComApartment::enter();
    scan_desktop_items_with_icons(false)
}

pub(super) fn scan_desktop_items_with_icons(include_icons: bool) -> Result<Vec<DesktopItem>, String> {
    let mut items = BTreeMap::new();

    // A partial scan must fail as a whole: the frontend reconciles its layout
    // against the result, and a desktop folder that could not be read would
    // look like every item on it had been deleted.
    for item in scan_desktop_file_items(include_icons)? {
        items.entry(item.id.clone()).or_insert(item);
    }

    for item in virtual_desktop_items(include_icons) {
        items.entry(item.id.clone()).or_insert(item);
    }

    Ok(items.into_values().collect())
}

pub(super) fn scan_desktop_file_items(include_icons: bool) -> Result<Vec<DesktopItem>, String> {
    let mut items = BTreeMap::new();
    let user_desktop = user_desktop_root().ok_or("user desktop folder not found")?;

    for dir in desktop_roots() {
        if !dir.exists() {
            // The user's desktop always exists; if it seems not to (a redirected
            // or network desktop not reachable yet), the scan is not trustworthy.
            if same_path_key(&dir, &user_desktop) {
                return Err(format!("desktop folder {} is not available", dir.display()));
            }
            continue;
        }

        let entries = fs::read_dir(&dir).map_err(|error| {
            format!("failed to read desktop folder {}: {error}", dir.display())
        })?;

        for entry in entries.flatten() {
            let path = entry.path();
            let name = desktop_name(&path);
            if name.is_empty() || should_skip_desktop_path(&path) {
                continue;
            }

            let item = desktop_item_for_path(path, include_icons);
            items.entry(item.id.clone()).or_insert(item);
        }
    }

    Ok(items.into_values().collect())
}

pub(super) fn scan_shell_desktop_items(include_icons: bool) -> Result<Vec<DesktopItem>, String> {
    let _com = ComApartment::enter();
    unsafe { scan_shell_desktop_items_inner(include_icons) }
}

pub(super) unsafe fn scan_shell_desktop_items_inner(
    include_icons: bool,
) -> Result<Vec<DesktopItem>, String> {
    let desktop =
        SHGetDesktopFolder().map_err(|error| format!("SHGetDesktopFolder failed: {error}"))?;
    let mut enum_list = None;
    let flags = (SHCONTF_FOLDERS.0 | SHCONTF_NONFOLDERS.0) as u32;
    let enum_result = desktop.EnumObjects(HWND(std::ptr::null_mut()), flags, &mut enum_list);

    if enum_result.is_err() {
        return Err(format!("desktop EnumObjects failed: {enum_result:?}"));
    }

    let Some(enum_list) = enum_list else {
        return Ok(Vec::new());
    };

    let mut items = BTreeMap::new();

    loop {
        let mut fetched = 0u32;
        let mut pidls: [*mut ITEMIDLIST; 1] = [std::ptr::null_mut()];
        let next_result = enum_list.Next(&mut pidls, Some(&mut fetched));

        if next_result.is_err() || fetched == 0 || pidls[0].is_null() {
            break;
        }

        let pidl = pidls[0];
        if let Some(item) = shell_item_from_pidl(&desktop, pidl, include_icons) {
            items.insert(item.id.clone(), item);
        }

        ILFree(Some(pidl));
    }

    Ok(items.into_values().collect())
}

pub(super) unsafe fn shell_item_from_pidl(
    desktop: &windows::Win32::UI::Shell::IShellFolder,
    pidl: *const ITEMIDLIST,
    include_icons: bool,
) -> Option<DesktopItem> {
    let name = strret_name(desktop, pidl, SHGDN_INFOLDER)?;
    if name.is_empty() || should_skip_desktop_item_name(&name) {
        return None;
    }

    let path = path_from_pidl(pidl);
    if path
        .as_ref()
        .is_some_and(|path| should_skip_desktop_path(Path::new(path)))
    {
        return None;
    }

    let parsing_name =
        strret_name(desktop, pidl, SHGDN_FORPARSING).unwrap_or_else(|| name.clone());
    let id = if let Some(path) = path.as_ref() {
        stable_path_id(Path::new(path))
    } else {
        shell_virtual_id(&parsing_name).unwrap_or_else(|| format!("shell:{parsing_name}"))
    };

    let launch_id = path.clone().unwrap_or(parsing_name);
    let kind = path
        .as_ref()
        .map(|path| item_kind(Path::new(path)))
        .unwrap_or_else(|| "system".to_string());

    let icon_data_url = if include_icons {
        icon_for_pidl(pidl).or_else(|| {
            path.as_ref()
                .and_then(|path| icon_for_path(Path::new(path)))
        })
    } else {
        None
    };

    Some(DesktopItem {
        id,
        name,
        kind,
        path,
        launch_id,
        icon_data_url,
        is_virtual: false,
    })
}

pub(super) unsafe fn strret_name(
    desktop: &windows::Win32::UI::Shell::IShellFolder,
    pidl: *const ITEMIDLIST,
    flags: windows::Win32::UI::Shell::SHGDNF,
) -> Option<String> {
    let mut strret = STRRET::default();
    desktop.GetDisplayNameOf(pidl, flags, &mut strret).ok()?;

    let mut buffer = [0u16; 520];
    StrRetToBufW(&mut strret, Some(pidl), &mut buffer).ok()?;
    Some(wide_buffer_to_string(&buffer))
}

pub(super) unsafe fn path_from_pidl(pidl: *const ITEMIDLIST) -> Option<String> {
    let mut buffer = [0u16; 260];
    if !SHGetPathFromIDListW(pidl, &mut buffer).as_bool() {
        return None;
    }

    let path = wide_buffer_to_string(&buffer);
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

pub(super) fn desktop_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Some(user_desktop) = user_desktop_root() {
        roots.push(user_desktop);
    }

    if let Some(public_desktop) = public_desktop_root() {
        if !roots
            .iter()
            .any(|root| same_path_key(root, &public_desktop))
        {
            roots.push(public_desktop);
        }
    } else if let Some(public) = std::env::var_os("PUBLIC") {
        let fallback = PathBuf::from(public).join("Desktop");
        if !roots.iter().any(|root| same_path_key(root, &fallback)) {
            roots.push(fallback);
        }
    }

    roots
}

pub(super) fn user_desktop_root() -> Option<PathBuf> {
    known_folder_path(&FOLDERID_Desktop).or_else(|| {
        std::env::var_os("USERPROFILE").map(|profile| PathBuf::from(profile).join("Desktop"))
    })
}

pub(super) fn public_desktop_root() -> Option<PathBuf> {
    known_folder_path(&FOLDERID_PublicDesktop)
}

pub(super) fn known_folder_path(folder_id: &windows::core::GUID) -> Option<PathBuf> {
    unsafe {
        let path = SHGetKnownFolderPath(folder_id, KF_FLAG_DEFAULT, None).ok()?;
        let mut len = 0usize;
        while *path.0.add(len) != 0 {
            len += 1;
        }

        let value = String::from_utf16_lossy(std::slice::from_raw_parts(path.0, len));
        CoTaskMemFree(Some(path.0 as *const c_void));

        if value.is_empty() {
            None
        } else {
            Some(PathBuf::from(value))
        }
    }
}

// System items shown on the desktop: (id, display name, shell launch id).
const VIRTUAL_DESKTOP_ITEMS: [(&str, &str, &str); 10] = [
    ("shell:my-computer", "\u{6b64}\u{7535}\u{8111}", "shell:MyComputerFolder"),
    ("shell:recycle-bin", "\u{56de}\u{6536}\u{7ad9}", "shell:RecycleBinFolder"),
    ("shell:user-files", "\u{7528}\u{6237}\u{6587}\u{4ef6}\u{5939}", "shell:UsersFilesFolder"),
    ("shell:network", "\u{7f51}\u{7edc}", "shell:NetworkPlacesFolder"),
    ("shell:control-panel", "\u{63a7}\u{5236}\u{9762}\u{677f}", "shell:ControlPanelFolder"),
    ("shell:downloads", "\u{4e0b}\u{8f7d}", "shell:Downloads"),
    ("shell:documents", "\u{6587}\u{6863}", "shell:Personal"),
    ("shell:pictures", "\u{56fe}\u{7247}", "shell:My Pictures"),
    ("shell:music", "\u{97f3}\u{4e50}", "shell:My Music"),
    ("shell:videos", "\u{89c6}\u{9891}", "shell:My Video"),
];

pub(super) fn virtual_desktop_items(include_icons: bool) -> Vec<DesktopItem> {
    VIRTUAL_DESKTOP_ITEMS
        .iter()
        .map(|(id, name, launch_id)| virtual_desktop_item(id, name, launch_id, include_icons))
        .collect()
}

// Launch ids arrive from the webview. Only act on what the desktop actually
// shows: one of our system items, or an entry directly inside a desktop folder.
pub(super) fn is_virtual_launch_id(launch_id: &str) -> bool {
    let launch_id = launch_id.trim();
    VIRTUAL_DESKTOP_ITEMS
        .iter()
        .any(|(id, _, shell)| shell.eq_ignore_ascii_case(launch_id) || id.eq_ignore_ascii_case(launch_id))
}

pub(super) fn desktop_item_path(launch_id: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(launch_id);
    let parent = path
        .parent()
        .filter(|_| path.is_absolute() && path.file_name().is_some())
        .ok_or("not a desktop item")?;
    if !desktop_roots().iter().any(|root| same_path_key(root, parent)) {
        return Err("not a desktop item".to_string());
    }
    Ok(path)
}

pub(super) fn validate_launch_id(launch_id: &str) -> Result<(), String> {
    if is_virtual_launch_id(launch_id) {
        return Ok(());
    }
    desktop_item_path(launch_id).map(|_| ())
}

pub(super) fn virtual_desktop_item(
    id: &str,
    name: &str,
    launch_id: &str,
    include_icons: bool,
) -> DesktopItem {
    DesktopItem {
        id: id.to_string(),
        name: name.to_string(),
        kind: "system".to_string(),
        path: None,
        launch_id: launch_id.to_string(),
        icon_data_url: include_icons
            .then(|| icon_for_shell_path(launch_id))
            .flatten(),
        is_virtual: true,
    }
}

pub(super) fn shell_virtual_id(parsing_name: &str) -> Option<String> {
    let normalized = parsing_name.to_ascii_lowercase();
    if normalized.contains("20d04fe0-3aea-1069-a2d8-08002b30309d")
        || normalized == "shell:mycomputerfolder"
    {
        return Some("shell:my-computer".to_string());
    }

    if normalized.contains("645ff040-5081-101b-9f08-00aa002f954e")
        || normalized == "shell:recyclebinfolder"
    {
        return Some("shell:recycle-bin".to_string());
    }

    if normalized.contains("59031a47-3f72-44a7-89c5-5595fe6b30ee")
        || normalized == "shell:usersfilesfolder"
    {
        return Some("shell:user-files".to_string());
    }

    if normalized.contains("f02c1a0d-be21-4350-88b0-7367fc96ef3c")
        || normalized == "shell:networkplacesfolder"
    {
        return Some("shell:network".to_string());
    }

    if normalized.contains("5399e694-6ce5-4d6c-8fce-1d8870fdcba0")
        || normalized.contains("26ee0668-a00a-44d7-9371-beb064c98683")
        || normalized == "shell:controlpanelfolder"
    {
        return Some("shell:control-panel".to_string());
    }

    if normalized.contains("374de290-123f-4565-9164-39c4925e467b")
        || normalized == "shell:downloads"
    {
        return Some("shell:downloads".to_string());
    }

    if normalized.contains("fdd39ad0-238f-46af-adb4-6c85480369c7")
        || normalized == "shell:personal"
    {
        return Some("shell:documents".to_string());
    }

    if normalized.contains("33e28130-4e1e-4676-835a-98395c3bc3bb")
        || normalized == "shell:my pictures"
    {
        return Some("shell:pictures".to_string());
    }

    if normalized.contains("4bd8d571-6d19-48d3-be97-422220080e43")
        || normalized == "shell:my music"
    {
        return Some("shell:music".to_string());
    }

    if normalized.contains("18989b1d-99b5-455b-841c-ab7c74e4ddfc")
        || normalized == "shell:my video"
    {
        return Some("shell:videos".to_string());
    }

    None
}

pub(super) fn desktop_name(path: &Path) -> String {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();

    file_name
        .strip_suffix(".lnk")
        .unwrap_or(file_name)
        .to_string()
}

pub(super) fn should_skip_desktop_item_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("desktop.ini")
}

pub(super) fn should_skip_desktop_path(path: &Path) -> bool {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(should_skip_desktop_item_name)
    {
        return true;
    }

    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    let attributes = metadata.file_attributes();
    let hidden_or_system = FILE_ATTRIBUTE_HIDDEN.0 | FILE_ATTRIBUTE_SYSTEM.0;

    attributes & hidden_or_system != 0
}

pub(super) fn desktop_item_for_path(path: PathBuf, include_icons: bool) -> DesktopItem {
    let id = stable_path_id(&path);
    let launch_id = path.to_string_lossy().to_string();

    DesktopItem {
        id,
        name: desktop_name(&path),
        kind: item_kind(&path),
        path: Some(launch_id.clone()),
        launch_id,
        icon_data_url: include_icons.then(|| icon_for_path(&path)).flatten(),
        is_virtual: false,
    }
}

pub(super) fn stable_path_id(path: &Path) -> String {
    file_id_for_path(path).unwrap_or_else(|| {
        let canonical_key = path
            .canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string();
        format!("path:{canonical_key}")
    })
}

pub(super) fn file_id_for_path(path: &Path) -> Option<String> {
    unsafe {
        let wide = to_wide(&path.to_string_lossy());
        let flags = if path.is_dir() {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            FILE_FLAGS_AND_ATTRIBUTES(0)
        };
        let handle = CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            flags,
            None,
        )
        .ok()?;

        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        let result = GetFileInformationByHandle(handle, &mut info).is_ok();
        let _ = CloseHandle(handle);

        if !result {
            return None;
        }

        let file_index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
        Some(format!(
            "fileid:{:x}:{:x}",
            info.dwVolumeSerialNumber, file_index
        ))
    }
}

pub(super) fn item_kind(path: &Path) -> String {
    if path.is_dir() {
        return "directory".to_string();
    }

    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "lnk" | "exe" => "app".to_string(),
        _ => "file".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{user_desktop_root, validate_launch_id};

    #[test]
    fn only_desktop_entries_and_system_items_are_accepted() {
        let desktop = user_desktop_root().expect("desktop folder");
        assert!(validate_launch_id(&desktop.join("notes.txt").to_string_lossy()).is_ok());
        assert!(validate_launch_id("shell:MyComputerFolder").is_ok());
        assert!(validate_launch_id("shell:recycle-bin").is_ok());

        assert!(validate_launch_id(&desktop.join("sub").join("deep.txt").to_string_lossy()).is_err());
        assert!(validate_launch_id(r"C:\Windows\System32\cmd.exe").is_err());
        assert!(validate_launch_id("shell:startup").is_err());
        assert!(validate_launch_id("https://example.com").is_err());
        assert!(validate_launch_id("notes.txt").is_err());
        assert!(validate_launch_id(&desktop.to_string_lossy()).is_err());
    }
}
