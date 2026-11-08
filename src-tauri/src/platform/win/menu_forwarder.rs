// While a native context menu is open, owner-drawn items (Send to, Open with,
// shell extensions) need WM_INITMENUPOPUP / WM_DRAWITEM / WM_MEASUREITEM /
// WM_MENUCHAR routed to IContextMenu2/3. This subclasses the owner window for
// the menu's lifetime and undoes it when the guard drops.
use super::*;

thread_local! {
    static MENU_MESSAGE_CONTEXT: RefCell<Option<MenuMessageContext>> = const { RefCell::new(None) };
}

pub(super) struct MenuMessageContext {
    context_menu2: Option<IContextMenu2>,
    context_menu3: Option<IContextMenu3>,
    previous_proc: isize,
}

pub(super) struct MenuMessageForwarderGuard {
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

pub(super) unsafe fn install_menu_message_forwarder(
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

pub(super) unsafe fn remove_menu_message_forwarder(owner: HWND) {
    let previous_proc = MENU_MESSAGE_CONTEXT
        .with(|context| context.borrow_mut().take().map(|state| state.previous_proc));

    if let Some(previous_proc) = previous_proc {
        let _ = SetWindowLongPtrW(owner, GWLP_WNDPROC, previous_proc);
    }
}

pub(super) unsafe extern "system" fn menu_message_forwarder_proc(
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
