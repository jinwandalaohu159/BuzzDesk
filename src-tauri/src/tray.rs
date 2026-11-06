// System tray icon: entry point to settings and an escape hatch back to the
// native Windows desktop.
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter,
};

use crate::layer_window;

const TRAY_SETTINGS_ID: &str = "settings";
const TRAY_SHOW_LAYER_ID: &str = "show_desktop_layer";
const TRAY_RESTORE_NATIVE_ICONS_ID: &str = "restore_native_desktop_icons";
const TRAY_QUIT_ID: &str = "quit";

pub fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
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
                layer_window::show_virtual_desktop(app);
                let _ = app.emit("desktop-layer-show-settings", ());
            }
            TRAY_SHOW_LAYER_ID => {
                layer_window::show_virtual_desktop(app);
            }
            TRAY_RESTORE_NATIVE_ICONS_ID => {
                layer_window::restore_native_desktop(app);
            }
            TRAY_QUIT_ID => {
                layer_window::restore_native_desktop(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

// Fallback tray glyph (a blue disc) when the bundle has no window icon.
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
