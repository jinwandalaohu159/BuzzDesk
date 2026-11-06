// Append-only startup trace in %TEMP%, used to diagnose boot problems on
// machines where no console or devtools are available.
use std::{
    fs::OpenOptions,
    io::Write,
    time::{SystemTime, UNIX_EPOCH},
};

const STARTUP_LOG_FILE_NAME: &str = "buzzdesk-startup.log";

pub fn trace_startup(event: impl AsRef<str>) {
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
