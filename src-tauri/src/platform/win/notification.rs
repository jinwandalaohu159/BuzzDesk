// Toast notifications through WinRT. An unpackaged app needs an
// AppUserModelID registered under HKCU for its toasts to be shown.
use super::*;
use std::time::Duration;
use windows::core::HSTRING;
use windows::Data::Xml::Dom::XmlDocument;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_OPTION_NON_VOLATILE,
    REG_SZ,
};
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

const APP_USER_MODEL_ID: &str = "local.buzzdesk";

fn register_app_user_model_id() {
    let subkey = to_wide(&format!(r"Software\Classes\AppUserModelId\{APP_USER_MODEL_ID}"));
    let name = to_wide("DisplayName");
    let value = to_wide("BuzzDesk");

    unsafe {
        let mut key = HKEY::default();
        let created = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut key,
            None,
        );
        if created.is_err() {
            return;
        }

        let bytes = std::slice::from_raw_parts(value.as_ptr() as *const u8, value.len() * 2);
        let _ = RegSetValueExW(key, PCWSTR(name.as_ptr()), None, REG_SZ, Some(bytes));
        let _ = RegCloseKey(key);
    }
}

// Blocks for a moment: call from a worker thread.
pub fn show_toast(title: &str, body: &str) -> Result<(), String> {
    let _com = ComApartment::enter_multithreaded();
    register_app_user_model_id();

    let content = format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        xml_escape(title),
        xml_escape(body)
    );
    let document = XmlDocument::new().map_err(|error| error.to_string())?;
    document
        .LoadXml(&HSTRING::from(content))
        .map_err(|error| error.to_string())?;
    let toast = ToastNotification::CreateToastNotification(&document).map_err(|error| error.to_string())?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_USER_MODEL_ID))
        .map_err(|error| error.to_string())?;
    notifier.Show(&toast).map_err(|error| error.to_string())?;
    // The notifier must outlive the async delivery on some Windows builds.
    std::thread::sleep(Duration::from_millis(500));
    Ok(())
}
