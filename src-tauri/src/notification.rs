// Windows toast notifications (update available, update finished).
use crate::{platform, startup_log::trace_startup};

#[tauri::command]
pub fn show_system_notification(title: String, body: String) -> Result<(), String> {
    // Delivery is asynchronous and the notifier must stay alive briefly.
    std::thread::spawn(move || {
        if let Err(error) = platform::show_toast(&title, &body) {
            trace_startup(format!("notification failed: {error}"));
        }
    });
    Ok(())
}
