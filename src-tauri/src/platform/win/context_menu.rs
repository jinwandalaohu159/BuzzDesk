// Native Explorer context menus for desktop items and the desktop background.
use super::*;

pub fn show_native_item_context_menu(
    launch_id: &str,
    owner: HWND,
    x: i32,
    y: i32,
) -> Result<NativeContextMenuResult, String> {
    validate_launch_id(launch_id)?;
    let _com = ComApartment::enter();
    unsafe { show_native_item_context_menu_inner(launch_id, owner, x, y) }
}

pub fn list_native_desktop_context_menu(
    owner: HWND,
) -> Result<Vec<NativeContextMenuItem>, String> {
    let _com = ComApartment::enter();
    unsafe { list_native_desktop_context_menu_inner(owner) }
}

pub fn invoke_native_desktop_context_menu_command(
    owner: HWND,
    command_id: u32,
    label: Option<&str>,
) -> Result<NativeContextMenuResult, String> {
    // Offsets we handed to QueryContextMenu (ids 1..=0x7fff, minus one). The id
    // goes into CMINVOKECOMMANDINFO.lpVerb, where anything >= 0x10000 would be
    // read as a string pointer.
    if command_id >= LAST_MENU_COMMAND_ID {
        return Err(format!("unknown context menu command {command_id}"));
    }
    let _com = ComApartment::enter();
    unsafe { invoke_native_desktop_context_menu_command_inner(owner, command_id, label) }
}

pub(super) unsafe fn list_native_desktop_context_menu_inner(
    owner: HWND,
) -> Result<Vec<NativeContextMenuItem>, String> {
    let (context_menu, menu) = desktop_context_menu(owner)?;
    let items = enumerate_native_context_menu(&context_menu, menu, 1, &[]);
    let _ = DestroyMenu(menu);
    Ok(items)
}

pub(super) unsafe fn invoke_native_desktop_context_menu_command_inner(
    owner: HWND,
    command_id: u32,
    label: Option<&str>,
) -> Result<NativeContextMenuResult, String> {
    let (context_menu, menu) = desktop_context_menu(owner)?;
    initialize_native_context_menu_submenus(&context_menu, menu, 1);
    // The menu is rebuilt for every call and its numbering can differ from the
    // listing the user clicked in: shell extensions register in the background
    // after a process first asks for the desktop menu, and each one that
    // arrives shifts the ids after it. Run the command the user actually saw.
    let Some(command) = resolve_menu_command(menu, command_id + FIRST_MENU_COMMAND_ID, label)
    else {
        let _ = DestroyMenu(menu);
        return Err(format!("context menu command {command_id} is no longer available"));
    };
    let result = invoke_context_menu_command(
        &context_menu,
        owner,
        (command - FIRST_MENU_COMMAND_ID) as usize,
        false,
        None,
    );
    let _ = DestroyMenu(menu);
    result
}

pub(super) unsafe fn desktop_context_menu(owner: HWND) -> Result<(IContextMenu, HMENU), String> {
    let desktop =
        SHGetDesktopFolder().map_err(|error| format!("SHGetDesktopFolder failed: {error}"))?;
    let context_menu: IContextMenu = desktop
        .CreateViewObject(owner)
        .map_err(|error| format!("CreateViewObject(IContextMenu) failed: {error}"))?;
    let menu = CreatePopupMenu().map_err(|error| format!("CreatePopupMenu failed: {error}"))?;
    let query = context_menu.QueryContextMenu(
        menu,
        0,
        FIRST_MENU_COMMAND_ID,
        LAST_MENU_COMMAND_ID,
        CMF_NORMAL | CMF_CANRENAME,
    );
    if query.is_err() {
        let _ = DestroyMenu(menu);
        return Err(format!("QueryContextMenu failed: {query:?}"));
    }

    Ok((context_menu, menu))
}

pub(super) unsafe fn show_native_item_context_menu_inner(
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

    let result =
        native_context_menu_for_pidl(pidl, owner, x, y, is_recycle_bin_launch_id(launch_id));
    ILFree(Some(pidl));
    result
}

pub(super) unsafe fn native_context_menu_for_pidl(
    pidl: *const ITEMIDLIST,
    owner: HWND,
    x: i32,
    y: i32,
    is_recycle_bin: bool,
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

    show_context_menu(context_menu, owner, x, y, is_recycle_bin)
}

pub(super) unsafe fn enumerate_native_context_menu(
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
        let command_id = if (FIRST_MENU_COMMAND_ID..=LAST_MENU_COMMAND_ID).contains(&info.wID) {
            Some(info.wID - FIRST_MENU_COMMAND_ID)
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

pub(super) unsafe fn initialize_native_context_menu_submenus(
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

pub(super) unsafe fn initialize_native_submenu(context_menu: &IContextMenu, submenu: HMENU, index: i32) {
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

pub(super) unsafe fn invoke_context_menu_command(
    context_menu: &IContextMenu,
    owner: HWND,
    command_id: usize,
    is_recycle_bin: bool,
    command_label: Option<&str>,
) -> Result<NativeContextMenuResult, String> {
    let canonical_verb = context_menu_command_verb(context_menu, command_id);
    if canonical_verb.as_deref() == Some("rename") {
        return Ok(NativeContextMenuResult {
            invoked: true,
            verb: canonical_verb,
        });
    }

    if is_recycle_bin && is_empty_recycle_bin_command(canonical_verb.as_deref(), command_label)
    {
        empty_recycle_bin_with_tool_owner().map_err(|error| {
            format!("SHEmptyRecycleBinW failed for recycle bin context command: {error}")
        })?;
        return Ok(NativeContextMenuResult {
            invoked: true,
            verb: canonical_verb,
        });
    }

    if command_id > 0xffff {
        return Err(format!("invalid context menu command {command_id}"));
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

pub(super) unsafe fn empty_recycle_bin_with_tool_owner() -> Result<(), String> {
    let owner = CreateWindowExW(
        WS_EX_TOOLWINDOW,
        w!("STATIC"),
        w!("BuzzDesk Shell Owner"),
        WS_OVERLAPPED,
        0,
        0,
        0,
        0,
        None,
        None,
        None,
        None,
    )
    .map_err(|error| format!("CreateWindowExW failed: {error}"))?;

    const HRESULT_FROM_WIN32_ERROR_CANCELLED: i32 = 0x800704C7u32 as i32;
    let result = match SHEmptyRecycleBinW(Some(owner), PCWSTR::null(), 0) {
        Ok(()) => Ok(()),
        Err(error) if error.code().0 == HRESULT_FROM_WIN32_ERROR_CANCELLED => Ok(()),
        Err(error) => Err(error.to_string()),
    };
    let _ = DestroyWindow(owner);
    result
}

pub(super) fn is_empty_recycle_bin_command(verb: Option<&str>, label: Option<&str>) -> bool {
    if matches!(
        verb,
        Some("empty") | Some("emptyrecyclebin") | Some("emptyrecyclebinfolder")
    ) {
        return true;
    }

    let Some(label) = label else {
        return false;
    };

    let normalized = label
        .replace('\u{2026}', "")
        .replace("...", "")
        .trim()
        .to_ascii_lowercase();

    (normalized.contains("empty") && normalized.contains("recycle"))
        || (label.contains('\u{6e05}')
            && label.contains('\u{7a7a}')
            && label.contains("\u{56de}\u{6536}\u{7ad9}"))
}

pub(super) fn is_recycle_bin_launch_id(launch_id: &str) -> bool {
    shell_virtual_id(launch_id).as_deref() == Some("shell:recycle-bin")
        || launch_id.trim().eq_ignore_ascii_case("shell:recycle-bin")
}

pub(super) unsafe fn show_context_menu(
    context_menu: IContextMenu,
    owner: HWND,
    x: i32,
    y: i32,
    is_recycle_bin: bool,
) -> Result<NativeContextMenuResult, String> {
    let menu = CreatePopupMenu().map_err(|error| format!("CreatePopupMenu failed: {error}"))?;
    let first_command = FIRST_MENU_COMMAND_ID;
    let last_command = LAST_MENU_COMMAND_ID;

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
    let command_label = native_menu_command_label(menu, command);
    let invoke_result = invoke_context_menu_command(
        &context_menu,
        owner,
        command_id,
        is_recycle_bin,
        command_label.as_deref(),
    );
    let _ = DestroyMenu(menu);
    invoke_result
}

pub(super) unsafe fn cursor_point_or_client_point_to_screen(owner: HWND, x: i32, y: i32) -> POINT {
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

pub(super) unsafe fn context_menu_command_verb(
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
