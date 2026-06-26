use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

const TRAY_SETTINGS_ID: &str = "settings";
const TRAY_SHOW_LAYER_ID: &str = "show_desktop_layer";
const TRAY_RESTORE_NATIVE_ICONS_ID: &str = "restore_native_desktop_icons";
const TRAY_QUIT_ID: &str = "quit";
const DESKTOP_STATE_FILE_NAME: &str = "desktop-state.json";
const STARTUP_LOG_FILE_NAME: &str = "buzzdesk-startup.log";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopItem {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: Option<String>,
    pub launch_id: String,
    pub icon_data_url: Option<String>,
    pub is_virtual: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDiagnostics {
    pub desktop_list_view_found: bool,
    pub desktop_host_found: bool,
    pub virtual_screen_bounds: Option<WindowBounds>,
    pub desktop_host_bounds: Option<WindowBounds>,
    pub desktop_layer_bounds: Option<WindowBounds>,
    pub shell_item_count: Option<usize>,
    pub fallback_item_count: Option<usize>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeContextMenuResult {
    pub invoked: bool,
    pub verb: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeContextMenuItem {
    pub key: String,
    pub label: String,
    pub verb: Option<String>,
    pub command_id: Option<u32>,
    pub disabled: bool,
    pub checked: bool,
    pub separator: bool,
    pub submenu: Vec<NativeContextMenuItem>,
}

fn desktop_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(DESKTOP_STATE_FILE_NAME))
        .map_err(|error| format!("failed to resolve app data directory: {error}"))
}

fn trace_startup(event: impl AsRef<str>) {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(STARTUP_LOG_FILE_NAME);

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            file,
            "{timestamp_ms} pid={} {}",
            std::process::id(),
            event.as_ref()
        );
    }
}

#[tauri::command]
fn load_desktop_state(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = desktop_state_path(&app)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read desktop state: {error}")),
    };

    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| format!("failed to parse desktop state: {error}"))
}

#[tauri::command]
fn save_desktop_state(app: AppHandle, state: serde_json::Value) -> Result<(), String> {
    let path = desktop_state_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create app data directory: {error}"))?;
    }

    let content = serde_json::to_string(&state)
        .map_err(|error| format!("failed to serialize desktop state: {error}"))?;
    fs::write(path, content).map_err(|error| format!("failed to write desktop state: {error}"))
}

#[tauri::command]
fn log_startup_event(event: String) {
    trace_startup(event);
}

#[tauri::command]
fn scan_desktop_items() -> Result<Vec<DesktopItem>, String> {
    platform::scan_desktop_items()
}

#[tauri::command]
fn scan_desktop_items_fast() -> Result<Vec<DesktopItem>, String> {
    platform::scan_desktop_items_fast()
}

#[tauri::command]
fn desktop_diagnostics(app: AppHandle) -> DesktopDiagnostics {
    #[cfg(windows)]
    {
        let layer_hwnd = app
            .get_webview_window("main")
            .and_then(|window| window.hwnd().ok());
        return platform::desktop_diagnostics(layer_hwnd);
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        platform::desktop_diagnostics()
    }
}

#[tauri::command]
fn open_desktop_item(launch_id: String) -> Result<(), String> {
    platform::open_desktop_item(&launch_id)
}

#[tauri::command]
fn copy_desktop_item(launch_id: String) -> Result<(), String> {
    platform::copy_desktop_item(&launch_id)
}

#[tauri::command]
fn paste_desktop_items() -> Result<(), String> {
    platform::paste_desktop_items()
}

#[tauri::command]
fn create_desktop_folder() -> Result<(), String> {
    platform::create_desktop_folder()
}

#[tauri::command]
fn rename_desktop_item(launch_id: String, name: String) -> Result<DesktopItem, String> {
    platform::rename_desktop_item(&launch_id, &name)
}

#[tauri::command]
fn delete_desktop_item(launch_id: String) -> Result<(), String> {
    platform::delete_desktop_item(&launch_id)
}

#[tauri::command]
fn show_desktop_item_properties(launch_id: String) -> Result<(), String> {
    platform::show_desktop_item_properties(&launch_id)
}

#[tauri::command]
fn set_app_process_priority(priority: String) -> Result<(), String> {
    platform::set_app_process_priority(&priority)
}

#[tauri::command]
fn get_startup_enabled() -> bool {
    platform::get_startup_enabled()
}

#[tauri::command]
fn set_startup_enabled(enabled: bool) -> Result<(), String> {
    platform::set_startup_enabled(enabled)
}

#[tauri::command]
fn show_native_item_context_menu(
    app: AppHandle,
    launch_id: String,
    x: i32,
    y: i32,
) -> Result<NativeContextMenuResult, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;

    #[cfg(windows)]
    {
        let hwnd = window
            .hwnd()
            .map_err(|error| format!("failed to get main window hwnd: {error}"))?;
        platform::show_native_item_context_menu(&launch_id, hwnd, x, y)
    }

    #[cfg(not(windows))]
    {
        let _ = (launch_id, x, y);
        Ok(NativeContextMenuResult {
            invoked: false,
            verb: None,
        })
    }
}

#[tauri::command]
fn list_native_desktop_context_menu(app: AppHandle) -> Result<Vec<NativeContextMenuItem>, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;

    #[cfg(windows)]
    {
        let hwnd = window
            .hwnd()
            .map_err(|error| format!("failed to get main window hwnd: {error}"))?;
        platform::list_native_desktop_context_menu(hwnd)
    }

    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
fn invoke_native_desktop_context_menu_command(
    app: AppHandle,
    command_id: u32,
) -> Result<NativeContextMenuResult, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;

    #[cfg(windows)]
    {
        let hwnd = window
            .hwnd()
            .map_err(|error| format!("failed to get main window hwnd: {error}"))?;
        platform::invoke_native_desktop_context_menu_command(hwnd, command_id)
    }

    #[cfg(not(windows))]
    {
        let _ = command_id;
        Ok(NativeContextMenuResult {
            invoked: false,
            verb: None,
        })
    }
}

#[tauri::command]
fn hide_native_desktop_icons() -> Result<(), String> {
    platform::set_native_desktop_icons_visible(false)
}

#[tauri::command]
fn show_native_desktop_icons() -> Result<(), String> {
    platform::set_native_desktop_icons_visible(true)
}

#[tauri::command]
fn show_desktop_layer_window(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;

    show_desktop_layer_window_inner(&window)
}

#[tauri::command]
fn attach_desktop_layer_window(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;

    attach_desktop_layer_window_inner(&window)
}

fn attach_desktop_layer_window_inner(window: &tauri::WebviewWindow) -> Result<bool, String> {
    let _ = window.set_resizable(false);

    #[cfg(windows)]
    let attached_to_desktop = match window.hwnd() {
        Ok(hwnd) => match platform::attach_window_to_desktop(hwnd, false) {
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
    let attached_to_desktop = true;

    if !attached_to_desktop {
        let _ = window.hide();
        return Ok(false);
    }

    Ok(true)
}

fn show_desktop_layer_window_inner(window: &tauri::WebviewWindow) -> Result<bool, String> {
    let _ = window.set_resizable(false);

    #[cfg(windows)]
    let attached_to_desktop = match window.hwnd() {
        Ok(hwnd) => match platform::attach_window_to_desktop(hwnd, true) {
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
    let attached_to_desktop = true;

    if !attached_to_desktop {
        let _ = window.hide();
        return Ok(false);
    }

    if let Err(error) = window.show() {
        let _ = window.hide();
        return Err(format!("failed to show desktop layer window: {error}"));
    }

    Ok(true)
}

fn restore_native_desktop_layer(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    #[cfg(windows)]
    {
        let _ = platform::set_native_desktop_icons_visible(true);
    }
}

fn show_virtual_desktop_layer(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match attach_desktop_layer_window_inner(&window) {
            Ok(true) => {
                #[cfg(windows)]
                {
                    if let Err(error) = platform::set_native_desktop_icons_visible(false) {
                        eprintln!("failed to hide native desktop icons: {error}");
                        let _ = window.hide();
                        let _ = platform::set_native_desktop_icons_visible(true);
                        return;
                    }
                }

                if !matches!(show_desktop_layer_window_inner(&window), Ok(true)) {
                    let _ = window.hide();
                    #[cfg(windows)]
                    {
                        let _ = platform::set_native_desktop_icons_visible(true);
                    }
                }
            }
            Ok(false) | Err(_) => {
                #[cfg(windows)]
                {
                    let _ = platform::set_native_desktop_icons_visible(true);
                }
            }
        }
    }
}

pub fn run() {
    trace_startup("run:enter");
    #[cfg(windows)]
    {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic_info| {
            let _ = platform::set_native_desktop_icons_visible(true);
            default_hook(panic_info);
        }));
    }

    let app = tauri::Builder::default()
        .setup(|app| {
            trace_startup("setup:enter");
            #[cfg(windows)]
            {
                let _ = platform::set_native_desktop_icons_visible(true);
            }

            if let Err(error) = setup_tray(app) {
                eprintln!("failed to create tray icon: {error}");
            }

            trace_startup("setup:done");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_desktop_state,
            save_desktop_state,
            log_startup_event,
            scan_desktop_items,
            scan_desktop_items_fast,
            desktop_diagnostics,
            open_desktop_item,
            copy_desktop_item,
            paste_desktop_items,
            create_desktop_folder,
            rename_desktop_item,
            delete_desktop_item,
            show_desktop_item_properties,
            set_app_process_priority,
            get_startup_enabled,
            set_startup_enabled,
            show_native_item_context_menu,
            list_native_desktop_context_menu,
            invoke_native_desktop_context_menu_command,
            hide_native_desktop_icons,
            show_native_desktop_icons,
            attach_desktop_layer_window,
            show_desktop_layer_window
        ])
        .on_window_event(|_, event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                let _ = platform::set_native_desktop_icons_visible(true);
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build BuzzDesk");

    app.run(|_, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            let _ = platform::set_native_desktop_icons_visible(true);
        }
    });
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let settings_item = MenuItem::with_id(
        app,
        TRAY_SETTINGS_ID,
        "\u{8bbe}\u{7f6e}",
        true,
        None::<&str>,
    )?;
    let show_layer_item = MenuItem::with_id(
        app,
        TRAY_SHOW_LAYER_ID,
        "\u{663e}\u{793a} BuzzDesk",
        true,
        None::<&str>,
    )?;
    let restore_item = MenuItem::with_id(
        app,
        TRAY_RESTORE_NATIVE_ICONS_ID,
        "\u{6062}\u{590d} Windows \u{539f}\u{751f}\u{684c}\u{9762}\u{56fe}\u{6807}",
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT_ID, "\u{9000}\u{51fa}", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&settings_item, &show_layer_item, &restore_item, &quit_item],
    )?;

    let tray_icon = app
        .default_window_icon()
        .cloned()
        .map(Image::to_owned)
        .unwrap_or_else(make_tray_icon);

    TrayIconBuilder::with_id("buzzdesk")
        .tooltip("BuzzDesk")
        .icon(tray_icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SETTINGS_ID => {
                show_virtual_desktop_layer(app);
                let _ = app.emit("desktop-layer-show-settings", ());
            }
            TRAY_SHOW_LAYER_ID => {
                show_virtual_desktop_layer(app);
            }
            TRAY_RESTORE_NATIVE_ICONS_ID => {
                restore_native_desktop_layer(app);
            }
            TRAY_QUIT_ID => {
                restore_native_desktop_layer(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn make_tray_icon() -> Image<'static> {
    let size = 32u32;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    let center = (size as f32 - 1.0) / 2.0;

    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let distance = (dx * dx + dy * dy).sqrt();
            let alpha = if distance <= 15.0 { 255 } else { 0 };
            let highlight = ((size - y) as f32 / size as f32 * 44.0) as u8;
            rgba.extend_from_slice(&[
                42u8.saturating_add(highlight),
                122u8.saturating_add(highlight / 2),
                255,
                alpha,
            ]);
        }
    }

    Image::new_owned(rgba, size, size)
}

#[cfg(not(windows))]
mod platform {
    use super::{DesktopDiagnostics, DesktopItem, NativeContextMenuResult};

    pub fn scan_desktop_items() -> Result<Vec<DesktopItem>, String> {
        Ok(Vec::new())
    }

    pub fn scan_desktop_items_fast() -> Result<Vec<DesktopItem>, String> {
        scan_desktop_items()
    }

    pub fn desktop_diagnostics() -> DesktopDiagnostics {
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

    pub fn set_native_desktop_icons_visible(_visible: bool) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use super::{
        DesktopDiagnostics, DesktopItem, NativeContextMenuItem, NativeContextMenuResult,
        WindowBounds,
    };
    use base64::{engine::general_purpose, Engine as _};
    use std::cell::RefCell;
    use std::collections::{BTreeMap, HashMap};
    use std::env;
    use std::ffi::{c_void, OsStr};
    use std::fs;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::{Mutex, OnceLock};
    use windows::core::{w, Interface, BOOL, PCSTR, PCWSTR, PSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::{
        ClientToScreen, DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };

    const MAX_ICON_DATA_URL_CACHE_ENTRIES: usize = 256;
    const DESKTOP_LAYER_EDGE_BLEED_PX: i32 = 20;
    const STARTUP_TASK_NAME: &str = "\\BuzzDesk";
    const STARTUP_RUN_VALUE_NAME: &str = "BuzzDesk";
    const STARTUP_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    static COPIED_DESKTOP_ITEM: Mutex<Option<PathBuf>> = Mutex::new(None);
    static ICON_DATA_URL_CACHE: OnceLock<Mutex<HashMap<i32, String>>> = OnceLock::new();
    static LAYER_WINDOW_PROCS: OnceLock<Mutex<HashMap<isize, isize>>> = OnceLock::new();
    thread_local! {
        static MENU_MESSAGE_CONTEXT: RefCell<Option<MenuMessageContext>> = const { RefCell::new(None) };
    }

    struct MenuMessageContext {
        context_menu2: Option<IContextMenu2>,
        context_menu3: Option<IContextMenu3>,
        previous_proc: isize,
    }

    struct MenuMessageForwarderGuard {
        owner: HWND,
        installed: bool,
    }

    impl Drop for MenuMessageForwarderGuard {
        fn drop(&mut self) {
            if self.installed {
                unsafe {
                    remove_menu_message_forwarder(self.owner);
                }
            }
        }
    }

    use windows::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL,
        FILE_ATTRIBUTE_SYSTEM, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        WIN32_FIND_DATAW,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
        OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetExitCodeProcess, SetPriorityClass, WaitForSingleObject,
        ABOVE_NORMAL_PRIORITY_CLASS, HIGH_PRIORITY_CLASS, INFINITE, NORMAL_PRIORITY_CLASS,
    };
    use windows::Win32::UI::Controls::{IImageList, ILD_TRANSPARENT};
    use windows::Win32::UI::Shell::{
        Common::{ITEMIDLIST, STRRET},
        DragQueryFileW, FOLDERID_Desktop, FOLDERID_PublicDesktop, IContextMenu, IContextMenu2,
        IContextMenu3, ILFree, IShellFolder, IShellLinkW, SHBindToParent, SHFileOperationW,
        SHGetDesktopFolder, SHGetFileInfoW, SHGetImageList, SHGetKnownFolderPath,
        SHGetPathFromIDListW, SHParseDisplayName, ShellExecuteExW, ShellExecuteW, ShellLink,
        StrRetToBufW, CMF_CANRENAME, CMF_NORMAL, CMINVOKECOMMANDINFO, DROPFILES, FOF_ALLOWUNDO,
        FOF_NOCONFIRMATION, FO_DELETE, GCS_VERBW, HDROP, KF_FLAG_DEFAULT, SEE_MASK_IDLIST,
        SEE_MASK_INVOKEIDLIST, SEE_MASK_NOCLOSEPROCESS, SHCONTF_FOLDERS, SHCONTF_NONFOLDERS,
        SHELLEXECUTEINFOW, SHFILEINFOW, SHFILEOPSTRUCTW, SHGDN_FORPARSING, SHGDN_INFOLDER,
        SHGFI_ICON, SHGFI_LARGEICON, SHGFI_PIDL, SHGFI_SYSICONINDEX, SHIL_EXTRALARGE, SHIL_JUMBO,
        SLGP_UNCPRIORITY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, CreatePopupMenu, DefWindowProcW, DestroyIcon, DestroyMenu, EnumWindows,
        FindWindowExW, FindWindowW, GetClassNameW, GetClientRect, GetCursorPos, GetIconInfo,
        GetMenuItemCount, GetMenuItemInfoW, GetSystemMetrics, GetWindowLongW, GetWindowRect,
        PrivateExtractIconsW, SendMessageTimeoutW, SetForegroundWindow, SetParent,
        SetWindowLongPtrW, SetWindowLongW, SetWindowPos, ShowWindow, TrackPopupMenuEx,
        GWLP_WNDPROC, GWL_STYLE, HICON, HMENU, HTCLIENT, ICONINFO, MENUITEMINFOW, MFS_CHECKED,
        MFS_DISABLED, MFS_GRAYED, MFT_SEPARATOR, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING,
        MIIM_SUBMENU, SMTO_NORMAL, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, SW_SHOW,
        SW_SHOWNORMAL, TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_DRAWITEM,
        WM_INITMENUPOPUP, WM_MEASUREITEM, WM_MENUCHAR, WM_NCHITTEST, WNDPROC, WS_CAPTION, WS_CHILD,
        WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME, WS_VISIBLE,
    };

    pub fn scan_desktop_items() -> Result<Vec<DesktopItem>, String> {
        scan_desktop_items_with_icons(true)
    }

    pub fn scan_desktop_items_fast() -> Result<Vec<DesktopItem>, String> {
        scan_desktop_items_with_icons(false)
    }

    fn scan_desktop_items_with_icons(include_icons: bool) -> Result<Vec<DesktopItem>, String> {
        let mut items = BTreeMap::new();

        if let Ok(file_items) = scan_desktop_file_items(include_icons) {
            for item in file_items {
                items.entry(item.id.clone()).or_insert(item);
            }
        }

        for item in virtual_desktop_items(include_icons) {
            items.entry(item.id.clone()).or_insert(item);
        }

        Ok(items.into_values().collect())
    }

    pub fn desktop_diagnostics(layer_hwnd: Option<HWND>) -> DesktopDiagnostics {
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

    fn scan_desktop_file_items(include_icons: bool) -> Result<Vec<DesktopItem>, String> {
        let mut items = BTreeMap::new();

        for dir in desktop_roots() {
            if !dir.exists() {
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

    fn scan_shell_desktop_items(include_icons: bool) -> Result<Vec<DesktopItem>, String> {
        unsafe {
            let com_initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = scan_shell_desktop_items_inner(include_icons);

            if com_initialized {
                CoUninitialize();
            }

            result
        }
    }

    unsafe fn scan_shell_desktop_items_inner(
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

    unsafe fn shell_item_from_pidl(
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

    unsafe fn strret_name(
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

    unsafe fn path_from_pidl(pidl: *const ITEMIDLIST) -> Option<String> {
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

    unsafe fn icon_for_pidl(pidl: *const ITEMIDLIST) -> Option<String> {
        let mut info = SHFILEINFOW::default();
        let result = SHGetFileInfoW(
            PCWSTR(pidl as *const u16),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_PIDL | SHGFI_SYSICONINDEX | SHGFI_ICON | SHGFI_LARGEICON,
        );

        if result == 0 {
            return None;
        }

        icon_from_shell_file_info(info)
    }

    fn wide_buffer_to_string(buffer: &[u16]) -> String {
        let len = buffer
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..len])
    }

    pub fn open_desktop_item(launch_id: &str) -> Result<(), String> {
        shell_execute_launch_id(launch_id, "open")
    }

    fn shell_execute_launch_id(launch_id: &str, verb: &str) -> Result<(), String> {
        let wide = to_wide(launch_id);
        let operation = to_wide(verb);

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
            return Ok(());
        }

        shell_execute_parsed_idlist(launch_id, verb)
            .map_err(|error| format!("ShellExecuteW {verb} failed for {launch_id}; {error}"))
    }

    fn shell_execute_parsed_idlist(launch_id: &str, verb: &str) -> Result<(), String> {
        unsafe {
            let com_initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = shell_execute_parsed_idlist_inner(launch_id, verb);

            if com_initialized {
                CoUninitialize();
            }

            result
        }
    }

    unsafe fn shell_execute_parsed_idlist_inner(launch_id: &str, verb: &str) -> Result<(), String> {
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

    unsafe fn shell_execute_pidl(pidl: *mut ITEMIDLIST, verb: &str) -> Result<(), String> {
        let operation = to_wide(verb);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: if verb == "properties" {
                SEE_MASK_INVOKEIDLIST
            } else {
                SEE_MASK_IDLIST
            },
            lpVerb: PCWSTR(operation.as_ptr()),
            lpIDList: pidl as *mut c_void,
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };

        ShellExecuteExW(&mut info)
            .map_err(|error| format!("ShellExecuteExW {verb} failed: {error}"))
    }

    pub fn copy_desktop_item(launch_id: &str) -> Result<(), String> {
        let path = PathBuf::from(launch_id);
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
            let target = unique_copy_path(&target_dir, &source)?;
            copy_path_recursive(&source, &target)?;
        }

        Ok(())
    }

    pub fn create_desktop_folder() -> Result<(), String> {
        let target_dir = user_desktop_root().ok_or("user desktop folder not found")?;
        let folder = unique_new_folder_path(&target_dir)?;
        fs::create_dir(&folder)
            .map_err(|error| format!("failed to create folder {}: {error}", folder.display()))
    }

    pub fn rename_desktop_item(launch_id: &str, name: &str) -> Result<DesktopItem, String> {
        validate_file_name(name)?;
        let source = PathBuf::from(launch_id);
        if !source.exists() {
            return Err("desktop item no longer exists".to_string());
        }

        let parent = source
            .parent()
            .ok_or("desktop item has no parent folder".to_string())?;
        let target_name = rename_target_name(&source, name);
        let target = parent.join(target_name);
        if target.exists() {
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
        let path = PathBuf::from(launch_id);
        if !path.exists() {
            return Err("desktop item no longer exists".to_string());
        }

        let mut from = to_wide(&path.to_string_lossy());
        from.push(0);

        let mut operation = SHFILEOPSTRUCTW {
            wFunc: FO_DELETE,
            pFrom: PCWSTR(from.as_ptr()),
            fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0) as u16,
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
        shell_execute_launch_id(launch_id, "properties")
    }

    pub fn show_native_item_context_menu(
        launch_id: &str,
        owner: HWND,
        x: i32,
        y: i32,
    ) -> Result<NativeContextMenuResult, String> {
        unsafe {
            let com_initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = show_native_item_context_menu_inner(launch_id, owner, x, y);

            if com_initialized {
                CoUninitialize();
            }

            result
        }
    }

    pub fn list_native_desktop_context_menu(
        owner: HWND,
    ) -> Result<Vec<NativeContextMenuItem>, String> {
        unsafe {
            let com_initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = list_native_desktop_context_menu_inner(owner);

            if com_initialized {
                CoUninitialize();
            }

            result
        }
    }

    pub fn invoke_native_desktop_context_menu_command(
        owner: HWND,
        command_id: u32,
    ) -> Result<NativeContextMenuResult, String> {
        unsafe {
            let com_initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = invoke_native_desktop_context_menu_command_inner(owner, command_id);

            if com_initialized {
                CoUninitialize();
            }

            result
        }
    }

    unsafe fn list_native_desktop_context_menu_inner(
        owner: HWND,
    ) -> Result<Vec<NativeContextMenuItem>, String> {
        let (context_menu, menu) = desktop_context_menu(owner)?;
        let items = enumerate_native_context_menu(&context_menu, menu, 1, &[]);
        let _ = DestroyMenu(menu);
        Ok(items)
    }

    unsafe fn invoke_native_desktop_context_menu_command_inner(
        owner: HWND,
        command_id: u32,
    ) -> Result<NativeContextMenuResult, String> {
        let (context_menu, menu) = desktop_context_menu(owner)?;
        initialize_native_context_menu_submenus(&context_menu, menu, 1);
        let result = invoke_context_menu_command(&context_menu, owner, command_id as usize);
        let _ = DestroyMenu(menu);
        result
    }

    unsafe fn desktop_context_menu(owner: HWND) -> Result<(IContextMenu, HMENU), String> {
        let desktop =
            SHGetDesktopFolder().map_err(|error| format!("SHGetDesktopFolder failed: {error}"))?;
        let context_menu: IContextMenu = desktop
            .CreateViewObject(owner)
            .map_err(|error| format!("CreateViewObject(IContextMenu) failed: {error}"))?;
        let menu = CreatePopupMenu().map_err(|error| format!("CreatePopupMenu failed: {error}"))?;
        let query = context_menu.QueryContextMenu(menu, 0, 1, 0x7fff, CMF_NORMAL | CMF_CANRENAME);
        if query.is_err() {
            let _ = DestroyMenu(menu);
            return Err(format!("QueryContextMenu failed: {query:?}"));
        }

        Ok((context_menu, menu))
    }

    unsafe fn show_native_item_context_menu_inner(
        launch_id: &str,
        owner: HWND,
        x: i32,
        y: i32,
    ) -> Result<NativeContextMenuResult, String> {
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

        let result = native_context_menu_for_pidl(pidl, owner, x, y);
        ILFree(Some(pidl));
        result
    }

    unsafe fn native_context_menu_for_pidl(
        pidl: *const ITEMIDLIST,
        owner: HWND,
        x: i32,
        y: i32,
    ) -> Result<NativeContextMenuResult, String> {
        let mut child: *mut ITEMIDLIST = std::ptr::null_mut();
        let parent: IShellFolder = SHBindToParent(pidl, Some(&mut child))
            .map_err(|error| format!("SHBindToParent failed: {error}"))?;

        if child.is_null() {
            return Err("SHBindToParent returned an empty child pidl".to_string());
        }

        let context_menu: IContextMenu = parent
            .GetUIObjectOf(owner, &[child as *const ITEMIDLIST], None)
            .map_err(|error| format!("GetUIObjectOf(IContextMenu) failed: {error}"))?;

        show_context_menu(context_menu, owner, x, y)
    }

    unsafe fn enumerate_native_context_menu(
        context_menu: &IContextMenu,
        menu: HMENU,
        depth: usize,
        parent_path: &[String],
    ) -> Vec<NativeContextMenuItem> {
        if depth > 4 {
            return Vec::new();
        }

        let count = GetMenuItemCount(Some(menu));
        if count <= 0 {
            return Vec::new();
        }

        let mut items = Vec::new();
        for index in 0..count {
            let mut info = MENUITEMINFOW {
                cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
                fMask: MIIM_FTYPE | MIIM_STATE | MIIM_ID | MIIM_SUBMENU | MIIM_STRING,
                ..Default::default()
            };

            if GetMenuItemInfoW(menu, index as u32, true, &mut info).is_err() {
                continue;
            }

            let separator = (info.fType & MFT_SEPARATOR) == MFT_SEPARATOR;
            let disabled = (info.fState & MFS_DISABLED) == MFS_DISABLED
                || (info.fState & MFS_GRAYED) == MFS_GRAYED;
            let checked = (info.fState & MFS_CHECKED) == MFS_CHECKED;
            let label = native_menu_item_label(menu, index as u32);
            let command_id = if info.wID >= 1 && info.wID <= 0x7fff {
                Some(info.wID - 1)
            } else {
                None
            };
            let verb =
                command_id.and_then(|id| context_menu_command_verb(context_menu, id as usize));
            let key = native_context_menu_item_key(verb.as_deref(), &label, parent_path, index);
            let mut child_path = parent_path.to_vec();
            child_path.push(if label.is_empty() {
                format!("item-{index}")
            } else {
                label.clone()
            });
            let submenu = if !info.hSubMenu.is_invalid() {
                initialize_native_submenu(context_menu, info.hSubMenu, index);
                enumerate_native_context_menu(context_menu, info.hSubMenu, depth + 1, &child_path)
            } else {
                Vec::new()
            };

            if separator || !label.is_empty() || !submenu.is_empty() {
                items.push(NativeContextMenuItem {
                    key,
                    label,
                    verb,
                    command_id,
                    disabled,
                    checked,
                    separator,
                    submenu,
                });
            }
        }

        collapse_menu_separators(items)
    }

    unsafe fn initialize_native_context_menu_submenus(
        context_menu: &IContextMenu,
        menu: HMENU,
        depth: usize,
    ) {
        if depth > 4 {
            return;
        }

        let count = GetMenuItemCount(Some(menu));
        if count <= 0 {
            return;
        }

        for index in 0..count {
            let mut info = MENUITEMINFOW {
                cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
                fMask: MIIM_SUBMENU,
                ..Default::default()
            };

            if GetMenuItemInfoW(menu, index as u32, true, &mut info).is_err()
                || info.hSubMenu.is_invalid()
            {
                continue;
            }

            initialize_native_submenu(context_menu, info.hSubMenu, index);
            initialize_native_context_menu_submenus(context_menu, info.hSubMenu, depth + 1);
        }
    }

    unsafe fn initialize_native_submenu(context_menu: &IContextMenu, submenu: HMENU, index: i32) {
        let message = WM_INITMENUPOPUP;
        let wparam = WPARAM(submenu.0 as usize);
        let lparam = LPARAM(index as isize);

        if let Ok(context_menu3) = context_menu.cast::<IContextMenu3>() {
            let mut result = LRESULT(0);
            if context_menu3
                .HandleMenuMsg2(message, wparam, lparam, Some(&mut result))
                .is_ok()
            {
                return;
            }
        }

        if let Ok(context_menu2) = context_menu.cast::<IContextMenu2>() {
            let _ = context_menu2.HandleMenuMsg(message, wparam, lparam);
        }
    }

    unsafe fn native_menu_item_label(menu: HMENU, index: u32) -> String {
        let mut info = MENUITEMINFOW {
            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_STRING,
            ..Default::default()
        };

        if GetMenuItemInfoW(menu, index, true, &mut info).is_err() || info.cch == 0 {
            return String::new();
        }

        let mut buffer = vec![0u16; info.cch as usize + 1];
        info.dwTypeData = PWSTR(buffer.as_mut_ptr());
        info.cch = buffer.len() as u32;
        if GetMenuItemInfoW(menu, index, true, &mut info).is_err() {
            return String::new();
        }

        let len = buffer
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(buffer.len());
        clean_native_menu_label(&String::from_utf16_lossy(&buffer[..len]))
    }

    fn clean_native_menu_label(label: &str) -> String {
        label
            .split('\t')
            .next()
            .unwrap_or(label)
            .replace("&&", "\u{0}")
            .replace('&', "")
            .replace('\u{0}', "&")
            .trim()
            .to_string()
    }

    fn native_context_menu_item_key(
        verb: Option<&str>,
        label: &str,
        parent_path: &[String],
        index: i32,
    ) -> String {
        if let Some(verb) = verb {
            if !verb.is_empty() {
                return format!("native:verb:{}", stable_menu_key_part(verb));
            }
        }

        let mut parts: Vec<String> = parent_path
            .iter()
            .filter(|part| !part.is_empty())
            .map(|part| stable_menu_key_part(part))
            .collect();
        if !label.is_empty() {
            parts.push(stable_menu_key_part(label));
        }
        if parts.is_empty() {
            parts.push(format!("item-{index}"));
        }

        format!("native:label:{}", parts.join("/"))
    }

    fn stable_menu_key_part(value: &str) -> String {
        let key: String = value
            .trim()
            .to_lowercase()
            .chars()
            .map(|character| {
                if character.is_alphanumeric() {
                    character
                } else {
                    '-'
                }
            })
            .collect();
        let compact = key
            .split('-')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("-");

        if compact.is_empty() {
            "item".to_string()
        } else {
            compact
        }
    }

    fn collapse_menu_separators(items: Vec<NativeContextMenuItem>) -> Vec<NativeContextMenuItem> {
        let mut collapsed = Vec::new();
        let mut previous_separator = true;

        for item in items {
            if item.separator {
                if !previous_separator {
                    collapsed.push(item);
                }
                previous_separator = true;
                continue;
            }

            previous_separator = false;
            collapsed.push(item);
        }

        while collapsed
            .last()
            .is_some_and(|item: &NativeContextMenuItem| item.separator)
        {
            collapsed.pop();
        }

        collapsed
    }

    unsafe fn invoke_context_menu_command(
        context_menu: &IContextMenu,
        owner: HWND,
        command_id: usize,
    ) -> Result<NativeContextMenuResult, String> {
        let canonical_verb = context_menu_command_verb(context_menu, command_id);
        if canonical_verb.as_deref() == Some("rename") {
            return Ok(NativeContextMenuResult {
                invoked: true,
                verb: canonical_verb,
            });
        }

        let _ = SetForegroundWindow(owner);
        let verb = command_id as *const u8;
        let invoke = CMINVOKECOMMANDINFO {
            cbSize: std::mem::size_of::<CMINVOKECOMMANDINFO>() as u32,
            hwnd: owner,
            lpVerb: PCSTR(verb),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };

        context_menu
            .InvokeCommand(&invoke)
            .map_err(|error| format!("IContextMenu InvokeCommand failed: {error}"))?;

        Ok(NativeContextMenuResult {
            invoked: true,
            verb: canonical_verb,
        })
    }

    unsafe fn show_context_menu(
        context_menu: IContextMenu,
        owner: HWND,
        x: i32,
        y: i32,
    ) -> Result<NativeContextMenuResult, String> {
        let menu = CreatePopupMenu().map_err(|error| format!("CreatePopupMenu failed: {error}"))?;
        let first_command = 1u32;
        let last_command = 0x7fffu32;

        let query = context_menu.QueryContextMenu(
            menu,
            0,
            first_command,
            last_command,
            CMF_NORMAL | CMF_CANRENAME,
        );
        if query.is_err() {
            let _ = DestroyMenu(menu);
            return Err(format!("QueryContextMenu failed: {query:?}"));
        }

        let _ = SetForegroundWindow(owner);
        let popup_point = cursor_point_or_client_point_to_screen(owner, x, y);
        let forwarder_guard = install_menu_message_forwarder(owner, &context_menu);
        let command = TrackPopupMenuEx(
            menu,
            (TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_LEFTALIGN).0,
            popup_point.x,
            popup_point.y,
            owner,
            None,
        )
        .0 as u32;
        drop(forwarder_guard);

        if command == 0 {
            let _ = DestroyMenu(menu);
            return Ok(NativeContextMenuResult {
                invoked: false,
                verb: None,
            });
        }

        let command_id = command.saturating_sub(first_command) as usize;
        let invoke_result = invoke_context_menu_command(&context_menu, owner, command_id);
        let _ = DestroyMenu(menu);
        invoke_result
    }

    unsafe fn cursor_point_or_client_point_to_screen(owner: HWND, x: i32, y: i32) -> POINT {
        let mut cursor = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut cursor).is_ok() {
            return cursor;
        }

        let mut point = POINT { x, y };
        if ClientToScreen(owner, &mut point).as_bool() {
            point
        } else {
            POINT { x, y }
        }
    }

    unsafe fn install_menu_message_forwarder(
        owner: HWND,
        context_menu: &IContextMenu,
    ) -> MenuMessageForwarderGuard {
        let context_menu3 = context_menu.cast::<IContextMenu3>().ok();
        let context_menu2 = context_menu.cast::<IContextMenu2>().ok();
        if context_menu2.is_none() && context_menu3.is_none() {
            return MenuMessageForwarderGuard {
                owner,
                installed: false,
            };
        }

        let previous_proc = SetWindowLongPtrW(
            owner,
            GWLP_WNDPROC,
            menu_message_forwarder_proc as *const () as usize as isize,
        );
        if previous_proc == 0 {
            return MenuMessageForwarderGuard {
                owner,
                installed: false,
            };
        }

        MENU_MESSAGE_CONTEXT.with(|context| {
            *context.borrow_mut() = Some(MenuMessageContext {
                context_menu2,
                context_menu3,
                previous_proc,
            });
        });

        MenuMessageForwarderGuard {
            owner,
            installed: true,
        }
    }

    unsafe fn remove_menu_message_forwarder(owner: HWND) {
        let previous_proc = MENU_MESSAGE_CONTEXT
            .with(|context| context.borrow_mut().take().map(|state| state.previous_proc));

        if let Some(previous_proc) = previous_proc {
            let _ = SetWindowLongPtrW(owner, GWLP_WNDPROC, previous_proc);
        }
    }

    unsafe extern "system" fn menu_message_forwarder_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let mut handled = None;
        let mut previous_proc = 0isize;

        MENU_MESSAGE_CONTEXT.with(|context| {
            if let Some(state) = context.borrow().as_ref() {
                previous_proc = state.previous_proc;
                if matches!(
                    message,
                    WM_INITMENUPOPUP | WM_DRAWITEM | WM_MEASUREITEM | WM_MENUCHAR
                ) {
                    if let Some(context_menu3) = state.context_menu3.as_ref() {
                        let mut result = LRESULT(0);
                        if unsafe {
                            context_menu3.HandleMenuMsg2(message, wparam, lparam, Some(&mut result))
                        }
                        .is_ok()
                        {
                            handled = Some(result);
                            return;
                        }
                    }

                    if let Some(context_menu2) = state.context_menu2.as_ref() {
                        let _ = unsafe { context_menu2.HandleMenuMsg(message, wparam, lparam) };
                    }
                }
            }
        });

        if let Some(result) = handled {
            return result;
        }

        if previous_proc == 0 {
            return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
        }

        let previous_proc: WNDPROC = unsafe { std::mem::transmute(previous_proc) };
        unsafe { CallWindowProcW(previous_proc, hwnd, message, wparam, lparam) }
    }

    unsafe fn install_desktop_layer_hit_test_guard(hwnd: HWND) {
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

    unsafe extern "system" fn desktop_layer_window_proc(
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

    unsafe fn context_menu_command_verb(
        context_menu: &IContextMenu,
        command_id: usize,
    ) -> Option<String> {
        let mut buffer = [0u16; 128];
        if context_menu
            .GetCommandString(
                command_id,
                GCS_VERBW,
                None,
                PSTR(buffer.as_mut_ptr() as *mut u8),
                buffer.len() as u32,
            )
            .is_err()
        {
            return None;
        }

        let verb = wide_buffer_to_string(&buffer).to_ascii_lowercase();
        if verb.is_empty() {
            None
        } else {
            Some(verb)
        }
    }

    pub fn set_native_desktop_icons_visible(visible: bool) -> Result<(), String> {
        let hwnd = find_desktop_list_view().ok_or("desktop list view not found")?;
        unsafe {
            let _ = ShowWindow(hwnd, if visible { SW_SHOW } else { SW_HIDE });
        }
        Ok(())
    }

    pub fn set_app_process_priority(priority: &str) -> Result<(), String> {
        let priority_class = match priority {
            "normal" => NORMAL_PRIORITY_CLASS,
            "aboveNormal" => ABOVE_NORMAL_PRIORITY_CLASS,
            "high" => HIGH_PRIORITY_CLASS,
            _ => return Err(format!("unsupported process priority: {priority}")),
        };

        unsafe {
            SetPriorityClass(GetCurrentProcess(), priority_class)
                .map_err(|error| format!("failed to set process priority: {error}"))
        }
    }

    pub fn get_startup_enabled() -> bool {
        startup_task_exists()
    }

    pub fn set_startup_enabled(enabled: bool) -> Result<(), String> {
        if enabled {
            create_startup_task()?;
            let _ = delete_startup_run_key();
            Ok(())
        } else {
            delete_startup_entries()
        }
    }

    fn startup_task_exists() -> bool {
        schtasks()
            .args(["/Query", "/TN", STARTUP_TASK_NAME])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn create_startup_task() -> Result<(), String> {
        let exe_path = env::current_exe()
            .map_err(|error| format!("failed to resolve current executable: {error}"))?;
        let xml_path = env::temp_dir().join("buzzdesk-startup.xml");
        write_utf16_xml(&xml_path, &startup_task_xml(&exe_path))
            .map_err(|error| format!("failed to write startup task XML: {error}"))?;

        let xml_path_text = xml_path.to_string_lossy().to_string();
        let result = schtasks_ok_allow_elevation(&[
            "/Create",
            "/TN",
            STARTUP_TASK_NAME,
            "/XML",
            &xml_path_text,
            "/F",
        ]);

        let _ = fs::remove_file(xml_path);
        result
    }

    fn delete_startup_entries() -> Result<(), String> {
        let task_result = delete_startup_task();
        let run_key_result = delete_startup_run_key();

        match (task_result, run_key_result) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(task_error), Ok(())) => Err(task_error),
            (Ok(()), Err(run_key_error)) => Err(run_key_error),
            (Err(task_error), Err(run_key_error)) => Err(format!("{task_error}; {run_key_error}")),
        }
    }

    fn delete_startup_task() -> Result<(), String> {
        if !startup_task_exists() {
            return Ok(());
        }

        schtasks_ok_allow_elevation(&["/Delete", "/TN", STARTUP_TASK_NAME, "/F"])
    }

    fn startup_task_xml(exe_path: &Path) -> String {
        let command = xml_escape(&format!("\"{}\"", exe_path.to_string_lossy()));
        format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>0</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
    </Exec>
  </Actions>
</Task>
"#
        )
    }

    fn write_utf16_xml(path: &Path, xml: &str) -> std::io::Result<()> {
        let mut bytes = Vec::with_capacity(xml.len() * 2 + 2);
        bytes.extend_from_slice(&[0xff, 0xfe]);
        for code in xml.encode_utf16() {
            bytes.extend_from_slice(&code.to_le_bytes());
        }

        fs::write(path, bytes)
    }

    fn startup_run_key_exists() -> bool {
        reg()
            .args(["QUERY", STARTUP_RUN_KEY, "/V", STARTUP_RUN_VALUE_NAME])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn delete_startup_run_key() -> Result<(), String> {
        if !startup_run_key_exists() {
            return Ok(());
        }

        let status = reg()
            .args([
                "DELETE",
                STARTUP_RUN_KEY,
                "/V",
                STARTUP_RUN_VALUE_NAME,
                "/F",
            ])
            .status()
            .map_err(|error| format!("failed to delete startup registry value: {error}"))?;

        if status.success() {
            Ok(())
        } else {
            Err("failed to delete startup registry value".to_string())
        }
    }

    fn schtasks_ok_allow_elevation(args: &[&str]) -> Result<(), String> {
        match schtasks_ok(args) {
            Ok(()) => Ok(()),
            Err(error) => schtasks_ok_elevated(args).map_err(|elevated_error| {
                format!("{error}; elevated retry failed: {elevated_error}")
            }),
        }
    }

    fn schtasks_ok(args: &[&str]) -> Result<(), String> {
        let output = schtasks()
            .args(args)
            .output()
            .map_err(|error| format!("failed to run schtasks: {error}"))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let message = format!("{stderr}{stdout}").trim().to_string();
        Err(if message.is_empty() {
            "schtasks failed".to_string()
        } else {
            message
        })
    }

    fn schtasks_ok_elevated(args: &[&str]) -> Result<(), String> {
        let parameters = args
            .iter()
            .map(|arg| windows_command_arg(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let verb = to_wide("runas");
        let file = to_wide("schtasks.exe");
        let params = to_wide(&parameters);

        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };

        unsafe {
            ShellExecuteExW(&mut info)
                .map_err(|error| format!("failed to request startup task elevation: {error}"))?;

            if info.hProcess.is_invalid() {
                return Err("startup task elevation did not return a process handle".to_string());
            }

            WaitForSingleObject(info.hProcess, INFINITE);

            let mut exit_code = 1;
            let read_result = GetExitCodeProcess(info.hProcess, &mut exit_code);
            let _ = CloseHandle(info.hProcess);
            read_result
                .map_err(|error| format!("failed to read elevated startup task result: {error}"))?;

            if exit_code == 0 {
                Ok(())
            } else {
                Err(format!("elevated schtasks exited with code {exit_code}"))
            }
        }
    }

    fn windows_command_arg(value: &str) -> String {
        if !value.is_empty()
            && !value
                .chars()
                .any(|ch| ch.is_whitespace() || ch == '\"' || ch == '\\')
        {
            return value.to_string();
        }

        let mut escaped = String::from("\"");
        let mut backslashes = 0;

        for ch in value.chars() {
            match ch {
                '\\' => backslashes += 1,
                '\"' => {
                    escaped.push_str(&"\\".repeat(backslashes * 2 + 1));
                    escaped.push('\"');
                    backslashes = 0;
                }
                _ => {
                    escaped.push_str(&"\\".repeat(backslashes));
                    backslashes = 0;
                    escaped.push(ch);
                }
            }
        }

        escaped.push_str(&"\\".repeat(backslashes * 2));
        escaped.push('\"');
        escaped
    }

    fn schtasks() -> Command {
        let mut command = Command::new("schtasks.exe");
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    fn reg() -> Command {
        let mut command = Command::new("reg.exe");
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    fn xml_escape(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
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

    unsafe fn desktop_layer_bounds(parent: HWND) -> (i32, i32, i32, i32) {
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

    fn virtual_screen_bounds() -> WindowBounds {
        unsafe {
            WindowBounds {
                x: GetSystemMetrics(SM_XVIRTUALSCREEN),
                y: GetSystemMetrics(SM_YVIRTUALSCREEN),
                width: GetSystemMetrics(SM_CXVIRTUALSCREEN).max(0),
                height: GetSystemMetrics(SM_CYVIRTUALSCREEN).max(0),
            }
        }
    }

    fn window_bounds(hwnd: HWND) -> Option<WindowBounds> {
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

    fn desktop_roots() -> Vec<PathBuf> {
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

    fn user_desktop_root() -> Option<PathBuf> {
        known_folder_path(&FOLDERID_Desktop).or_else(|| {
            std::env::var_os("USERPROFILE").map(|profile| PathBuf::from(profile).join("Desktop"))
        })
    }

    fn public_desktop_root() -> Option<PathBuf> {
        known_folder_path(&FOLDERID_PublicDesktop)
    }

    fn known_folder_path(folder_id: &windows::core::GUID) -> Option<PathBuf> {
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

    fn same_path_key(a: &Path, b: &Path) -> bool {
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

    fn unique_copy_path(target_dir: &Path, source: &Path) -> Result<PathBuf, String> {
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

    fn unique_new_folder_path(target_dir: &Path) -> Result<PathBuf, String> {
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

    fn rename_target_name(source: &Path, name: &str) -> String {
        let has_new_extension = Path::new(name).extension().is_some();
        let original_extension = source.extension().and_then(|extension| extension.to_str());

        if has_new_extension {
            return name.to_string();
        }

        match original_extension {
            Some(extension) if !extension.is_empty() => format!("{name}.{extension}"),
            _ => name.to_string(),
        }
    }

    fn validate_file_name(name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("name cannot be empty".to_string());
        }

        let invalid = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
        if name.chars().any(|character| invalid.contains(&character)) {
            return Err("name contains invalid filename characters".to_string());
        }

        if name == "." || name == ".." || name.ends_with('.') {
            return Err("name is not valid for Windows files".to_string());
        }

        Ok(())
    }

    fn copy_path_recursive(source: &Path, target: &Path) -> Result<(), String> {
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

    fn clipboard_file_paths() -> Result<Vec<PathBuf>, String> {
        if unsafe { OpenClipboard(None) }.is_err() {
            return Ok(Vec::new());
        }

        let result = unsafe {
            let paths = if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_ok() {
                match GetClipboardData(CF_HDROP.0 as u32) {
                    Ok(handle) if !handle.0.is_null() => {
                        let global = HGLOBAL(handle.0);
                        let locked = GlobalLock(global);
                        if locked.is_null() {
                            Vec::new()
                        } else {
                            let drop = HDROP(locked);
                            let paths = hdrop_file_paths(drop);
                            let _ = GlobalUnlock(global);
                            paths
                        }
                    }
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

    unsafe fn hdrop_file_paths(drop: HDROP) -> Vec<PathBuf> {
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

    fn set_clipboard_file_paths(paths: &[PathBuf]) -> Result<(), String> {
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

        if unsafe { OpenClipboard(None) }.is_err() {
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

        if let Err(error) = result {
            unsafe {
                let _ = GlobalFree(Some(global));
            }
            return Err(format!("SetClipboardData failed: {error}"));
        }

        Ok(())
    }

    fn virtual_desktop_items(include_icons: bool) -> Vec<DesktopItem> {
        vec![
            virtual_desktop_item(
                "shell:my-computer",
                "\u{6b64}\u{7535}\u{8111}",
                "shell:MyComputerFolder",
                include_icons,
            ),
            virtual_desktop_item(
                "shell:recycle-bin",
                "\u{56de}\u{6536}\u{7ad9}",
                "shell:RecycleBinFolder",
                include_icons,
            ),
            virtual_desktop_item(
                "shell:user-files",
                "\u{7528}\u{6237}\u{6587}\u{4ef6}\u{5939}",
                "shell:UsersFilesFolder",
                include_icons,
            ),
            virtual_desktop_item(
                "shell:network",
                "\u{7f51}\u{7edc}",
                "shell:NetworkPlacesFolder",
                include_icons,
            ),
            virtual_desktop_item(
                "shell:control-panel",
                "\u{63a7}\u{5236}\u{9762}\u{677f}",
                "shell:ControlPanelFolder",
                include_icons,
            ),
            virtual_desktop_item(
                "shell:downloads",
                "\u{4e0b}\u{8f7d}",
                "shell:Downloads",
                include_icons,
            ),
            virtual_desktop_item(
                "shell:documents",
                "\u{6587}\u{6863}",
                "shell:Personal",
                include_icons,
            ),
            virtual_desktop_item(
                "shell:pictures",
                "\u{56fe}\u{7247}",
                "shell:My Pictures",
                include_icons,
            ),
            virtual_desktop_item(
                "shell:music",
                "\u{97f3}\u{4e50}",
                "shell:My Music",
                include_icons,
            ),
            virtual_desktop_item(
                "shell:videos",
                "\u{89c6}\u{9891}",
                "shell:My Video",
                include_icons,
            ),
        ]
    }

    fn virtual_desktop_item(
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

    fn shell_virtual_id(parsing_name: &str) -> Option<String> {
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

    fn desktop_name(path: &Path) -> String {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();

        file_name
            .strip_suffix(".lnk")
            .unwrap_or(file_name)
            .to_string()
    }

    fn should_skip_desktop_item_name(name: &str) -> bool {
        name.eq_ignore_ascii_case("desktop.ini")
    }

    fn should_skip_desktop_path(path: &Path) -> bool {
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

    fn desktop_item_for_path(path: PathBuf, include_icons: bool) -> DesktopItem {
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

    fn stable_path_id(path: &Path) -> String {
        file_id_for_path(path).unwrap_or_else(|| {
            let canonical_key = path
                .canonicalize()
                .unwrap_or_else(|_| path.to_path_buf())
                .to_string_lossy()
                .to_string();
            format!("path:{canonical_key}")
        })
    }

    fn file_id_for_path(path: &Path) -> Option<String> {
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

    fn item_kind(path: &Path) -> String {
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

    fn to_wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(Some(0)).collect()
    }

    fn icon_for_path(path: &Path) -> Option<String> {
        let wide = to_wide(&path.to_string_lossy());
        if is_shortcut_path(path) {
            if let Some(icon) = icon_for_shortcut(path) {
                return Some(icon);
            }

            if let Some(icon) = icon_for_wide_path(&wide, FILE_ATTRIBUTE_NORMAL) {
                return Some(icon);
            }
        }

        let attributes = if path.is_dir() {
            FILE_ATTRIBUTE_DIRECTORY
        } else {
            FILE_ATTRIBUTE_NORMAL
        };

        icon_for_wide_path(&wide, attributes)
    }

    fn is_shortcut_path(path: &Path) -> bool {
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
    }

    fn icon_for_shortcut(path: &Path) -> Option<String> {
        unsafe {
            let com_initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = icon_for_shortcut_inner(path);

            if com_initialized {
                CoUninitialize();
            }

            result
        }
    }

    unsafe fn icon_for_shortcut_inner(path: &Path) -> Option<String> {
        let shell_link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist_file: IPersistFile = shell_link.cast().ok()?;
        let shortcut_path = to_wide(&path.to_string_lossy());
        persist_file
            .Load(PCWSTR(shortcut_path.as_ptr()), STGM_READ)
            .ok()?;

        let mut icon_path_buffer = [0u16; 520];
        let mut icon_index = 0i32;
        if shell_link
            .GetIconLocation(&mut icon_path_buffer, &mut icon_index)
            .is_ok()
        {
            let icon_path =
                resolve_shortcut_icon_path(path, &wide_buffer_to_string(&icon_path_buffer));
            if !icon_path.is_empty() {
                if let Some(icon) = icon_for_explicit_icon_location(&icon_path, icon_index) {
                    return Some(icon);
                }

                if !Path::new(&icon_path).is_dir() {
                    if let Some(icon) = icon_for_shell_path(&icon_path) {
                        return Some(icon);
                    }
                }
            }
        }

        let mut target_path_buffer = [0u16; 520];
        let mut find_data = WIN32_FIND_DATAW::default();
        if shell_link
            .GetPath(
                &mut target_path_buffer,
                &mut find_data,
                SLGP_UNCPRIORITY.0 as u32,
            )
            .is_ok()
        {
            let target_path = wide_buffer_to_string(&target_path_buffer);
            if !target_path.is_empty() && !Path::new(&target_path).is_dir() {
                if let Some(icon) = icon_for_shell_path(&target_path) {
                    return Some(icon);
                }
            }
        }

        None
    }

    fn resolve_shortcut_icon_path(shortcut_path: &Path, icon_path: &str) -> String {
        let expanded = expand_environment_variables(icon_path);
        let path = PathBuf::from(&expanded);
        if path.is_absolute() {
            return expanded;
        }

        shortcut_path
            .parent()
            .map(|parent| parent.join(path).to_string_lossy().to_string())
            .unwrap_or(expanded)
    }

    fn expand_environment_variables(value: &str) -> String {
        let chars: Vec<char> = value.chars().collect();
        let mut expanded = String::with_capacity(value.len());
        let mut index = 0;

        while index < chars.len() {
            if chars[index] != '%' {
                expanded.push(chars[index]);
                index += 1;
                continue;
            }

            let Some(end_offset) = chars[index + 1..]
                .iter()
                .position(|character| *character == '%')
            else {
                expanded.push(chars[index]);
                index += 1;
                continue;
            };
            let end = index + 1 + end_offset;
            let key: String = chars[index + 1..end].iter().collect();

            if key.is_empty() {
                expanded.push('%');
                index += 1;
                continue;
            }

            if let Some(value) = env::var_os(&key) {
                expanded.push_str(&value.to_string_lossy());
            } else {
                expanded.extend(chars[index..=end].iter());
            }

            index = end + 1;
        }

        expanded
    }

    unsafe fn icon_for_explicit_icon_location(path: &str, icon_index: i32) -> Option<String> {
        let fixed_path = fixed_wide_path(path)?;

        for size in [256, 128, 96, 64, 48, 32] {
            let mut icons = [HICON(std::ptr::null_mut())];
            let count = PrivateExtractIconsW(
                &fixed_path,
                icon_index,
                size,
                size,
                Some(&mut icons),
                None,
                0,
            );

            if count == 0 || icons[0].0.is_null() {
                continue;
            }

            if let Some(data_url) = icon_to_png_data_url(icons[0]) {
                return Some(data_url);
            }
        }

        None
    }

    fn fixed_wide_path(path: &str) -> Option<[u16; 260]> {
        let wide = to_wide(path);
        if wide.len() > 260 {
            return None;
        }

        let mut fixed = [0u16; 260];
        fixed[..wide.len()].copy_from_slice(&wide);
        Some(fixed)
    }

    fn icon_for_shell_path(path: &str) -> Option<String> {
        let wide = to_wide(path);
        if let Some(icon) = icon_for_shell_parse_name(&wide) {
            return Some(icon);
        }

        icon_for_wide_path(&wide, FILE_ATTRIBUTE_NORMAL)
    }

    fn icon_for_shell_parse_name(wide: &[u16]) -> Option<String> {
        unsafe {
            let com_initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
            let result = SHParseDisplayName(
                PCWSTR(wide.as_ptr()),
                None::<&windows::Win32::System::Com::IBindCtx>,
                &mut pidl,
                0,
                None,
            );

            let icon = if result.is_ok() && !pidl.is_null() {
                let icon = icon_for_pidl(pidl);
                ILFree(Some(pidl));
                icon
            } else {
                None
            };

            if com_initialized {
                CoUninitialize();
            }

            icon
        }
    }

    fn icon_for_wide_path(
        wide: &[u16],
        attributes: windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES,
    ) -> Option<String> {
        let mut info = SHFILEINFOW::default();
        let result = unsafe {
            SHGetFileInfoW(
                PCWSTR(wide.as_ptr()),
                attributes,
                Some(&mut info),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_SYSICONINDEX | SHGFI_ICON | SHGFI_LARGEICON,
            )
        };

        if result == 0 {
            return None;
        }

        unsafe { icon_from_shell_file_info(info) }
    }

    unsafe fn icon_from_shell_file_info(info: SHFILEINFOW) -> Option<String> {
        if let Some(data_url) = cached_icon_data_url(info.iIcon) {
            if !info.hIcon.0.is_null() {
                let _ = DestroyIcon(info.hIcon);
            }
            return Some(data_url);
        }

        if let Some(data_url) = high_res_icon_from_system_index(info.iIcon) {
            if !info.hIcon.0.is_null() {
                let _ = DestroyIcon(info.hIcon);
            }
            remember_icon_data_url(info.iIcon, &data_url);
            return Some(data_url);
        }

        let data_url = if info.hIcon.0.is_null() {
            None
        } else {
            icon_to_png_data_url(info.hIcon)
        };

        if let Some(data_url) = data_url.as_ref() {
            remember_icon_data_url(info.iIcon, data_url);
        }

        data_url
    }

    fn cached_icon_data_url(index: i32) -> Option<String> {
        if index < 0 {
            return None;
        }

        ICON_DATA_URL_CACHE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .ok()
            .and_then(|cache| cache.get(&index).cloned())
    }

    fn remember_icon_data_url(index: i32, data_url: &str) {
        if index < 0 {
            return;
        }

        let Ok(mut cache) = ICON_DATA_URL_CACHE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
        else {
            return;
        };

        if cache.len() >= MAX_ICON_DATA_URL_CACHE_ENTRIES && !cache.contains_key(&index) {
            if let Some(first_key) = cache.keys().next().copied() {
                cache.remove(&first_key);
            }
        }

        cache.insert(index, data_url.to_string());
    }

    unsafe fn high_res_icon_from_system_index(index: i32) -> Option<String> {
        for image_list_size in [SHIL_JUMBO, SHIL_EXTRALARGE] {
            let Ok(image_list) = SHGetImageList::<IImageList>(image_list_size as i32) else {
                continue;
            };
            let Ok(hicon) = image_list.GetIcon(index, ILD_TRANSPARENT.0) else {
                continue;
            };
            if !hicon.0.is_null() {
                if let Some(data_url) = icon_to_png_data_url(hicon) {
                    return Some(data_url);
                }
            }
        }

        None
    }

    unsafe fn icon_to_png_data_url(
        hicon: windows::Win32::UI::WindowsAndMessaging::HICON,
    ) -> Option<String> {
        let mut icon_info = ICONINFO::default();
        if GetIconInfo(hicon, &mut icon_info).is_err() {
            let _ = DestroyIcon(hicon);
            return None;
        }

        let hbitmap = if !icon_info.hbmColor.0.is_null() {
            icon_info.hbmColor
        } else {
            icon_info.hbmMask
        };

        if hbitmap.0.is_null() {
            cleanup_icon(hicon, icon_info);
            return None;
        }

        let mut bitmap = BITMAP::default();
        let object_result = GetObjectW(
            HGDIOBJ(hbitmap.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bitmap as *mut BITMAP as *mut c_void),
        );

        if object_result == 0 || bitmap.bmWidth <= 0 || bitmap.bmHeight <= 0 {
            cleanup_icon(hicon, icon_info);
            return None;
        }

        let width = bitmap.bmWidth;
        let height = if icon_info.hbmColor.0.is_null() {
            bitmap.bmHeight / 2
        } else {
            bitmap.bmHeight
        };

        if height <= 0 {
            cleanup_icon(hicon, icon_info);
            return None;
        }

        let hdc = GetDC(None);
        if hdc.0.is_null() {
            cleanup_icon(hicon, icon_info);
            return None;
        }

        let mut bitmap_info = BITMAPINFO::default();
        bitmap_info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: (width * height * 4) as u32,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };

        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let copied = GetDIBits(
            hdc,
            hbitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut c_void),
            &mut bitmap_info,
            DIB_RGB_COLORS,
        );
        let _ = ReleaseDC(None, hdc);

        if copied == 0 {
            cleanup_icon(hicon, icon_info);
            return None;
        }

        let png = encode_png(width, height, &pixels);
        cleanup_icon(hicon, icon_info);
        let png = png?;

        Some(format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(png)
        ))
    }

    unsafe fn cleanup_icon(
        hicon: windows::Win32::UI::WindowsAndMessaging::HICON,
        icon_info: ICONINFO,
    ) {
        if !icon_info.hbmColor.0.is_null() {
            let _ = DeleteObject(HGDIOBJ(icon_info.hbmColor.0));
        }

        if !icon_info.hbmMask.0.is_null() {
            let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));
        }

        let _ = DestroyIcon(hicon);
    }

    fn encode_png(width: i32, height: i32, bgra_pixels: &[u8]) -> Option<Vec<u8>> {
        let mut rgba = Vec::with_capacity(bgra_pixels.len());
        for pixel in bgra_pixels.chunks_exact(4) {
            rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }

        let (image_width, image_height, image_pixels) =
            trim_transparent_padding(width, height, rgba)?;
        let mut bytes = Vec::new();
        {
            let mut encoder =
                png::Encoder::new(&mut bytes, image_width as u32, image_height as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().ok()?;
            writer.write_image_data(&image_pixels).ok()?;
        }

        Some(bytes)
    }

    fn trim_transparent_padding(
        width: i32,
        height: i32,
        rgba: Vec<u8>,
    ) -> Option<(i32, i32, Vec<u8>)> {
        if width <= 0 || height <= 0 {
            return None;
        }

        let width_usize = width as usize;
        let height_usize = height as usize;
        let mut min_x = width_usize;
        let mut min_y = height_usize;
        let mut max_x = 0usize;
        let mut max_y = 0usize;
        let mut found = false;

        for y in 0..height_usize {
            for x in 0..width_usize {
                let alpha = rgba[(y * width_usize + x) * 4 + 3];
                if alpha <= 8 {
                    continue;
                }

                found = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }

        if !found {
            return Some((width, height, rgba));
        }

        min_x = min_x.saturating_sub(1);
        min_y = min_y.saturating_sub(1);
        max_x = (max_x + 1).min(width_usize - 1);
        max_y = (max_y + 1).min(height_usize - 1);

        let trim_width = max_x - min_x + 1;
        let trim_height = max_y - min_y + 1;
        let should_trim =
            trim_width * 100 < width_usize * 92 || trim_height * 100 < height_usize * 92;
        if !should_trim {
            return Some((width, height, rgba));
        }

        let mut trimmed = Vec::with_capacity(trim_width * trim_height * 4);
        for y in min_y..=max_y {
            let start = (y * width_usize + min_x) * 4;
            let end = start + trim_width * 4;
            trimmed.extend_from_slice(&rgba[start..end]);
        }

        Some((trim_width as i32, trim_height as i32, trimmed))
    }

    fn ensure_desktop_host_window() -> Option<HWND> {
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

    fn window_covers_virtual_screen(hwnd: HWND) -> bool {
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

    fn find_shell_desktop_host() -> Option<HWND> {
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

    unsafe extern "system" fn enum_shell_desktop_host(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if window_class_name(hwnd) == "WorkerW" && find_shell_def_view(hwnd).is_some() {
            let output = lparam.0 as *mut HWND;
            *output = hwnd;
            return BOOL(0);
        }

        BOOL(1)
    }

    fn find_workerw_desktop_host() -> Option<HWND> {
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

    struct WorkerSearch {
        saw_shell_view: bool,
        first_plain_worker: HWND,
        host: HWND,
    }

    unsafe extern "system" fn enum_worker_desktop_host(hwnd: HWND, lparam: LPARAM) -> BOOL {
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

    fn find_full_size_workerw_host() -> Option<HWND> {
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

    unsafe extern "system" fn enum_full_size_workerw_host(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if window_class_name(hwnd) == "WorkerW" && window_covers_virtual_screen(hwnd) {
            let output = lparam.0 as *mut HWND;
            *output = hwnd;
            return BOOL(0);
        }

        BOOL(1)
    }

    fn find_desktop_list_view() -> Option<HWND> {
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

    unsafe extern "system" fn enum_worker_windows(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if window_class_name(hwnd) == "WorkerW" {
            if let Some(list) = find_shell_list_view(hwnd) {
                let output = lparam.0 as *mut HWND;
                *output = list;
                return BOOL(0);
            }
        }

        BOOL(1)
    }

    unsafe fn window_class_name(hwnd: HWND) -> String {
        let mut class_name = [0u16; 256];
        let len = GetClassNameW(hwnd, &mut class_name);
        String::from_utf16_lossy(&class_name[..len as usize])
    }

    unsafe fn find_shell_list_view(parent: HWND) -> Option<HWND> {
        let def_view = find_shell_def_view(parent)?;
        FindWindowExW(Some(def_view), None, w!("SysListView32"), PCWSTR::null()).ok()
    }

    unsafe fn find_shell_def_view(parent: HWND) -> Option<HWND> {
        if parent.0.is_null() {
            return None;
        }

        FindWindowExW(Some(parent), None, w!("SHELLDLL_DefView"), PCWSTR::null()).ok()
    }
}
