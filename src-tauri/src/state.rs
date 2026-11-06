// Persistence of the desktop layout (virtual folders, order, settings) as JSON
// in the app data directory.
use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

const DESKTOP_STATE_FILE_NAME: &str = "desktop-state.json";

// Saves run on worker threads and may overlap. The frontend stamps every
// snapshot with `updatedAt`; we keep the newest one written so a slow, older
// save can never overwrite a newer layout.
static WRITE_GUARD: Mutex<Option<f64>> = Mutex::new(None);

pub fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(DESKTOP_STATE_FILE_NAME))
        .map_err(|error| format!("failed to resolve app data directory: {error}"))
}

pub fn load(path: &Path) -> Result<Option<serde_json::Value>, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read desktop state: {error}")),
    };

    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| format!("failed to parse desktop state: {error}"))
}

pub fn save(path: &Path, state: &serde_json::Value) -> Result<(), String> {
    let stamp = state.get("updatedAt").and_then(serde_json::Value::as_f64);
    let mut last_written = WRITE_GUARD
        .lock()
        .map_err(|_| "desktop state writer is unavailable".to_string())?;
    if let (Some(stamp), Some(previous)) = (stamp, *last_written) {
        if stamp < previous {
            return Ok(());
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create app data directory: {error}"))?;
    }

    let content = serde_json::to_string(state)
        .map_err(|error| format!("failed to serialize desktop state: {error}"))?;
    // Write, flush to disk, then rename: a crash or power loss mid-save leaves
    // either the old file or the new one, never a truncated or empty file.
    let temp_path = path.with_extension("json.tmp");
    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&temp_path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()
    };
    write().map_err(|error| format!("failed to write desktop state: {error}"))?;
    fs::rename(&temp_path, path).map_err(|error| format!("failed to write desktop state: {error}"))?;

    if stamp.is_some() {
        *last_written = stamp;
    }
    Ok(())
}
