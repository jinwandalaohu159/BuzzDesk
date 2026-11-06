// BuzzDesk — a glass desktop layer with virtual folders, built with Tauri 2.
//
// Module map:
//   backdrop      desktop snapshots for the frontend's frosted glass
//   commands      Tauri command surface (frontend contract)
//   layer_window  the main window as the desktop layer (attach/show/restore)
//   notification  Windows toast notifications
//   platform      OS integration; Windows implementation under platform/win
//   release       which URLs count as BuzzDesk's GitHub releases
//   state         desktop layout persistence
//   tray          system tray menu
//   updater       self-update: download, helper process, legacy-install cleanup
mod backdrop;
mod commands;
mod layer_window;
mod notification;
mod platform;
mod release;
mod startup_log;
mod state;
mod tray;
mod updater;

use serde::{Deserialize, Serialize};

use startup_log::trace_startup;

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

pub fn run() {
    let context = tauri::generate_context!();
    // The same binary doubles as the update helper; it must never start the
    // desktop layer.
    if let Some(helper_args) = updater::helper_args() {
        updater::run_helper(helper_args, context);
        return;
    }

    if !platform::claim_single_instance() {
        trace_startup("run:another instance is already running");
        return;
    }

    trace_startup("run:enter");
    // Whatever happens, never leave the user with a desktop without icons.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let _ = platform::set_native_desktop_icons_visible(true);
        default_hook(panic_info);
    }));

    let app = tauri::Builder::default()
        .setup(|app| {
            trace_startup("setup:enter");
            // The main window is declared with `create: false` so the update helper
            // (same binary) never spins up the desktop layer.
            if let Some(config) = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == layer_window::MAIN_WINDOW_LABEL)
            {
                tauri::WebviewWindowBuilder::from_config(app.handle(), config)?.build()?;
            }
            let _ = platform::set_native_desktop_icons_visible(true);

            if let Err(error) = tray::setup_tray(app) {
                eprintln!("failed to create tray icon: {error}");
            }

            trace_startup("setup:done");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_desktop_state,
            commands::save_desktop_state,
            commands::log_startup_event,
            commands::scan_desktop_items,
            commands::scan_desktop_items_fast,
            commands::desktop_diagnostics,
            commands::open_desktop_item,
            commands::copy_desktop_item,
            commands::paste_desktop_items,
            commands::create_desktop_folder,
            commands::rename_desktop_item,
            commands::delete_desktop_item,
            commands::show_desktop_item_properties,
            commands::set_app_process_priority,
            commands::get_startup_enabled,
            commands::set_startup_enabled,
            commands::repair_startup_entry,
            commands::open_update_release_page,
            commands::show_native_item_context_menu,
            commands::list_native_desktop_context_menu,
            commands::invoke_native_desktop_context_menu_command,
            commands::hide_native_desktop_icons,
            commands::show_native_desktop_icons,
            commands::attach_desktop_layer_window,
            commands::show_desktop_layer_window,
            updater::download::download_update_installer,
            updater::helper::launch_update_helper,
            updater::legacy::detect_legacy_install,
            updater::legacy::cleanup_legacy_install,
            notification::show_system_notification,
            backdrop::get_desktop_backdrop_info,
            backdrop::desktop_backdrop_clear,
            backdrop::capture_desktop_backdrop,
            backdrop::load_desktop_backdrop
        ])
        .on_window_event(|_, event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                let _ = platform::set_native_desktop_icons_visible(true);
            }
        })
        .build(context)
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
