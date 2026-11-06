// Downloads the release installer with progress events.
use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

use super::{sanitize_installer_name, update_dir};
use crate::release;

const DOWNLOAD_PROGRESS_EVENT: &str = "update-download-progress";

// One download at a time: the automatic check and a click on "update" would
// otherwise write the same .part file concurrently.
static DOWNLOAD_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
pub async fn download_update_installer(
    app: AppHandle,
    url: String,
    file_name: String,
) -> Result<String, String> {
    let url = release::validate_installer_url(&url)?;
    let name = sanitize_installer_name(&file_name)?;
    tauri::async_runtime::spawn_blocking(move || download_installer_blocking(&app, url.as_str(), &name))
        .await
        .map_err(|error| format!("download task failed: {error}"))?
}

fn download_installer_blocking(app: &AppHandle, url: &str, name: &str) -> Result<String, String> {
    let _exclusive = DOWNLOAD_LOCK
        .try_lock()
        .map_err(|_| "an update download is already in progress".to_string())?;

    let dir = update_dir();
    fs::create_dir_all(&dir).map_err(|error| format!("failed to create update directory: {error}"))?;
    let final_path = dir.join(name);
    let partial_path = dir.join(format!("{name}.part"));

    let response = ureq::get(url)
        .timeout(Duration::from_secs(900))
        .call()
        .map_err(|error| format!("failed to download installer: {error}"))?;
    // GitHub redirects asset downloads to its CDN; make sure we ended up there.
    if !release::is_trusted_download_host(response.get_url()) {
        return Err("installer download was redirected to an untrusted host".to_string());
    }
    let total = response
        .header("Content-Length")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0);

    let mut reader = response.into_reader();
    let mut file = fs::File::create(&partial_path)
        .map_err(|error| format!("failed to create installer file: {error}"))?;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut downloaded = 0u64;
    let mut header = [0u8; 2];
    let mut last_emit = Instant::now() - Duration::from_secs(1);

    let _ = app.emit(DOWNLOAD_PROGRESS_EVENT, DownloadProgress { downloaded, total });
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("failed to read installer download: {error}"))?;
        if read == 0 {
            break;
        }

        for (offset, byte) in buffer[..read].iter().enumerate() {
            let position = downloaded as usize + offset;
            if position >= header.len() {
                break;
            }
            header[position] = *byte;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("failed to write installer file: {error}"))?;
        downloaded += read as u64;

        if last_emit.elapsed() >= Duration::from_millis(80) {
            last_emit = Instant::now();
            let _ = app.emit(DOWNLOAD_PROGRESS_EVENT, DownloadProgress { downloaded, total });
        }
    }

    file.sync_all()
        .map_err(|error| format!("failed to flush installer file: {error}"))?;
    drop(file);

    // Without a Content-Length a truncated body can't be detected by size; at
    // least require a Windows executable.
    let incomplete = match total {
        Some(expected) => downloaded != expected,
        None => false,
    };
    if incomplete || downloaded < header.len() as u64 || &header != b"MZ" {
        let _ = fs::remove_file(&partial_path);
        return Err(match total {
            Some(expected) if incomplete => format!("installer download incomplete: {downloaded}/{expected} bytes"),
            _ => "downloaded installer is not a Windows executable".to_string(),
        });
    }

    let _ = fs::remove_file(&final_path);
    fs::rename(&partial_path, &final_path)
        .map_err(|error| format!("failed to finalize installer file: {error}"))?;
    let _ = app.emit(
        DOWNLOAD_PROGRESS_EVENT,
        DownloadProgress {
            downloaded,
            total: Some(total.unwrap_or(downloaded)),
        },
    );

    Ok(final_path.to_string_lossy().into_owned())
}
