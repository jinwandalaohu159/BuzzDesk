// Reading Win32 popup menus built by shell context menus: labels, command ids,
// stable keys for the user's layout, and finding the command the user clicked.
use super::*;

// Command id range handed to IContextMenu::QueryContextMenu.
pub(super) const FIRST_MENU_COMMAND_ID: u32 = 1;
pub(super) const LAST_MENU_COMMAND_ID: u32 = 0x7fff;

// The id when it still names the item labelled `label`; otherwise the item
// with that label wherever it is now. Without a label the id is trusted as is.
pub(super) unsafe fn resolve_menu_command(menu: HMENU, command: u32, label: Option<&str>) -> Option<u32> {
    let label = label.map(clean_native_menu_label).filter(|label| !label.is_empty());
    if menu_has_command(menu, command) {
        match &label {
            None => return Some(command),
            Some(label) if native_menu_command_label(menu, command).as_deref() == Some(label.as_str()) => {
                return Some(command)
            }
            _ => {}
        }
    }
    find_menu_command_by_label(menu, label.as_deref()?, 1)
}

pub(super) unsafe fn find_menu_command_by_label(menu: HMENU, label: &str, depth: usize) -> Option<u32> {
    if depth > 4 {
        return None;
    }
    for index in 0..GetMenuItemCount(Some(menu)).max(0) {
        let mut info = MENUITEMINFOW {
            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_ID | MIIM_SUBMENU,
            ..Default::default()
        };
        if GetMenuItemInfoW(menu, index as u32, true, &mut info).is_err() {
            continue;
        }
        if !info.hSubMenu.is_invalid() {
            if let Some(command) = find_menu_command_by_label(info.hSubMenu, label, depth + 1) {
                return Some(command);
            }
        } else if (FIRST_MENU_COMMAND_ID..=LAST_MENU_COMMAND_ID).contains(&info.wID)
            && native_menu_item_label(menu, index as u32) == label
        {
            return Some(info.wID);
        }
    }
    None
}

pub(super) unsafe fn native_menu_label(menu: HMENU, item: u32, by_position: bool) -> Option<String> {
    let mut info = MENUITEMINFOW {
        cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
        fMask: MIIM_STRING,
        ..Default::default()
    };

    if GetMenuItemInfoW(menu, item, by_position, &mut info).is_err() || info.cch == 0 {
        return None;
    }

    let mut buffer = vec![0u16; info.cch as usize + 1];
    info.dwTypeData = PWSTR(buffer.as_mut_ptr());
    info.cch = buffer.len() as u32;
    if GetMenuItemInfoW(menu, item, by_position, &mut info).is_err() {
        return None;
    }

    let len = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    let label = clean_native_menu_label(&String::from_utf16_lossy(&buffer[..len]));
    if label.is_empty() {
        None
    } else {
        Some(label)
    }
}

// Whether the menu (or one of its submenus) has an item with this command id.
pub(super) unsafe fn menu_has_command(menu: HMENU, command: u32) -> bool {
    let mut info = MENUITEMINFOW {
        cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
        fMask: MIIM_ID,
        ..Default::default()
    };
    GetMenuItemInfoW(menu, command, false, &mut info).is_ok() && info.wID == command
}

pub(super) unsafe fn native_menu_item_label(menu: HMENU, index: u32) -> String {
    native_menu_label(menu, index, true).unwrap_or_default()
}

pub(super) unsafe fn native_menu_command_label(menu: HMENU, command: u32) -> Option<String> {
    native_menu_label(menu, command, false)
}

pub(super) fn clean_native_menu_label(label: &str) -> String {
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

pub(super) fn native_context_menu_item_key(
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

pub(super) fn stable_menu_key_part(value: &str) -> String {
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

pub(super) fn collapse_menu_separators(items: Vec<NativeContextMenuItem>) -> Vec<NativeContextMenuItem> {
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

#[cfg(test)]
mod resolve_tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{AppendMenuW, MF_POPUP, MF_STRING};

    unsafe fn append(menu: HMENU, id: usize, label: &str, flags: windows::Win32::UI::WindowsAndMessaging::MENU_ITEM_FLAGS) {
        let wide = to_wide(label);
        AppendMenuW(menu, flags, id, PCWSTR(wide.as_ptr())).unwrap();
    }

    #[test]
    fn finds_the_clicked_command_after_ids_shift() {
        unsafe {
            let menu = CreatePopupMenu().unwrap();
            let submenu = CreatePopupMenu().unwrap();
            append(menu, 1, "在终端中打开(&T)", MF_STRING);
            append(menu, 2, "显示设置(&D)", MF_STRING);
            append(submenu, 5, "文件夹(&F)", MF_STRING);
            append(menu, submenu.0 as usize, "新建(&W)", MF_POPUP);

            // Same id, same item.
            assert_eq!(resolve_menu_command(menu, 2, Some("显示设置(D)")), Some(2));
            // The listing said 2 was "在终端中打开": ids moved, follow the label.
            assert_eq!(resolve_menu_command(menu, 2, Some("在终端中打开(T)")), Some(1));
            // Inside a submenu.
            assert_eq!(resolve_menu_command(menu, 1, Some("文件夹(F)")), Some(5));
            // Gone: never run something else.
            assert_eq!(resolve_menu_command(menu, 2, Some("个性化(R)")), None);
            // No label (older callers): trust the id.
            assert_eq!(resolve_menu_command(menu, 2, None), Some(2));

            let _ = DestroyMenu(menu);
        }
    }
}
