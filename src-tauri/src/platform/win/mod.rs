// Windows implementation of the platform layer. Submodules share this module's
// imports through `use super::*` and see each other through the glob imports below.
use crate::{
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
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use windows::core::{w, Interface, BOOL, PCSTR, PCWSTR, PSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GlobalFree, HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};

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
    REALTIME_PRIORITY_CLASS,
};
use windows::Win32::UI::Controls::{IImageList, ILD_TRANSPARENT};
use windows::Win32::UI::Shell::{
    Common::{ITEMIDLIST, STRRET},
    DragQueryFileW, FOLDERID_Desktop, FOLDERID_PublicDesktop, IContextMenu, IContextMenu2,
    IContextMenu3, ILFree, IShellFolder, IShellLinkW, SHBindToParent, SHEmptyRecycleBinW,
    SHFileOperationW, SHGetDesktopFolder, SHGetFileInfoW, SHGetImageList, SHGetKnownFolderPath,
    SHGetPathFromIDListW, SHParseDisplayName, ShellExecuteExW, ShellExecuteW, ShellLink,
    StrRetToBufW, CMF_CANRENAME, CMF_NORMAL, CMINVOKECOMMANDINFO, DROPFILES, FOF_ALLOWUNDO,
    FOF_NOCONFIRMATION, FO_DELETE, GCS_VERBW, HDROP, KF_FLAG_DEFAULT, SEE_MASK_IDLIST,
    SEE_MASK_INVOKEIDLIST, SEE_MASK_NOCLOSEPROCESS, SHCONTF_FOLDERS, SHCONTF_NONFOLDERS,
    SHELLEXECUTEINFOW, SHFILEINFOW, SHFILEOPSTRUCTW, SHGDN_FORPARSING, SHGDN_INFOLDER,
    SHGFI_ICON, SHGFI_LARGEICON, SHGFI_PIDL, SHGFI_SYSICONINDEX, SHIL_EXTRALARGE, SHIL_JUMBO,
    SLGP_UNCPRIORITY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyIcon,
    DestroyMenu, DestroyWindow, EnumWindows, FindWindowExW, FindWindowW, GetClassNameW,
    GetClientRect, GetCursorPos, GetIconInfo, GetMenuItemCount, GetMenuItemInfoW,
    GetSystemMetrics, GetWindowLongW, GetWindowRect, PrivateExtractIconsW, SendMessageTimeoutW,
    SetForegroundWindow, SetParent, SetWindowLongPtrW, SetWindowLongW, SetWindowPos,
    ShowWindow, TrackPopupMenuEx, GWLP_WNDPROC, GWL_STYLE, HICON, HMENU, HTCLIENT, ICONINFO,
    MENUITEMINFOW, MFS_CHECKED, MFS_DISABLED, MFS_GRAYED, MFT_SEPARATOR, MIIM_FTYPE, MIIM_ID,
    MIIM_STATE, MIIM_STRING, MIIM_SUBMENU, SMTO_NORMAL, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    SW_HIDE, SW_SHOW, SW_SHOWNORMAL, TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON,
    WM_DRAWITEM, WM_INITMENUPOPUP, WM_MEASUREITEM, WM_MENUCHAR, WM_NCHITTEST, WNDPROC,
    WS_CAPTION, WS_CHILD, WS_EX_TOOLWINDOW, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_OVERLAPPED,
    WS_POPUP, WS_SYSMENU, WS_THICKFRAME, WS_VISIBLE,
};

mod backdrop;
mod clipboard;
mod context_menu;
mod desktop_layer;
mod diagnostics;
mod icons;
mod instance;
mod items;
mod legacy_install;
mod menu_forwarder;
mod menu_items;
mod notification;
mod process;
mod shell_ops;
mod startup;
mod util;

#[allow(unused_imports)]
use self::{
    clipboard::*, context_menu::*, desktop_layer::*, diagnostics::*, icons::*, items::*,
    menu_forwarder::*, menu_items::*, shell_ops::*, startup::*, util::*,
};

pub use self::context_menu::{invoke_native_desktop_context_menu_command, list_native_desktop_context_menu, show_native_item_context_menu};
pub use self::desktop_layer::{attach_window_to_desktop, set_native_desktop_icons_visible};
pub use self::diagnostics::{desktop_diagnostics};
pub use self::items::{scan_desktop_items, scan_desktop_items_fast};
pub use self::shell_ops::{copy_desktop_item, create_desktop_folder, delete_desktop_item, open_desktop_item, open_update_release_page, paste_desktop_items, rename_desktop_item, show_desktop_item_properties};
pub use self::startup::{enable_startup_for, get_startup_enabled, repair_startup_entry, set_startup_enabled};
pub use self::backdrop::{backdrop_info, capture_desktop, desktop_uncovered};
pub use self::instance::claim_single_instance;
pub use self::legacy_install::{legacy_install, run_legacy_uninstall};
pub use self::notification::show_toast;
pub use self::process::{run_installer_and_wait, set_app_process_priority, wait_for_process_exit};
