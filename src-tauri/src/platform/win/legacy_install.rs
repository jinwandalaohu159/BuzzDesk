// The old per-machine (Program Files) install: found through its HKLM
// uninstall entry, removed with one elevated command.
use super::*;
use crate::updater::legacy::LegacyInstall;
use std::time::Duration;
use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

const LEGACY_UNINSTALL_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\BuzzDesk";

fn read_hklm_string(subkey: &str, name: &str) -> Option<String> {
    let subkey = to_wide(subkey);
    let name = to_wide(name);
    let mut buffer = vec![0u16; 1024];
    let mut size = (buffer.len() * 2) as u32;
    unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    let len = (size as usize / 2).saturating_sub(1).min(buffer.len());
    let value = String::from_utf16_lossy(&buffer[..len]);
    let value = value.trim().trim_matches('"').trim().to_string();
    (!value.is_empty()).then_some(value)
}

// Characters that would let a path break out of the cmd.exe line we build.
fn is_cmd_safe_path(value: &str) -> bool {
    !value
        .chars()
        .any(|ch| matches!(ch, '"' | '&' | '|' | '<' | '>' | '^' | '%' | '!' | '\r' | '\n'))
}

pub fn legacy_install() -> Option<LegacyInstall> {
    let location = read_hklm_string(LEGACY_UNINSTALL_KEY, "InstallLocation")?;
    let uninstaller = read_hklm_string(LEGACY_UNINSTALL_KEY, "UninstallString")?;
    let version = read_hklm_string(LEGACY_UNINSTALL_KEY, "DisplayVersion").unwrap_or_default();

    let location_path = Path::new(&location);
    let uninstaller_path = Path::new(&uninstaller);
    if !uninstaller_path.is_file() || uninstaller_path.parent() != Some(location_path) {
        return None;
    }
    if !is_cmd_safe_path(&location) || !is_cmd_safe_path(&uninstaller) {
        return None;
    }

    // Only a *different* copy counts as legacy; never offer to remove ourselves.
    let current = env::current_exe().ok()?;
    let current_text = current.to_string_lossy().to_lowercase();
    let location_text = location.trim_end_matches('\\').to_lowercase();
    if current_text.starts_with(&format!("{location_text}\\")) {
        return None;
    }

    Some(LegacyInstall {
        version,
        location,
        uninstaller,
    })
}

// One elevated cmd.exe run (a single UAC prompt) that uninstalls the old
// per-machine copy and removes its logon task. `_?=` keeps the NSIS
// uninstaller in place so we can wait for it to really finish.
pub fn run_legacy_uninstall(uninstaller: &Path, location: &Path, on_tick: impl Fn(Duration)) -> Result<(), String> {
    let uninstaller_text = uninstaller.to_string_lossy().to_string();
    let location_text = location.to_string_lossy().trim_end_matches('\\').to_string();
    let schtasks = system_tool("schtasks.exe").to_string_lossy().to_string();
    if !is_cmd_safe_path(&uninstaller_text) || !is_cmd_safe_path(&location_text) || !is_cmd_safe_path(&schtasks) {
        return Err("legacy install path contains unsupported characters".to_string());
    }

    let script = format!(
        "/d /s /c \"\"{uninstaller_text}\" /S _?={location_text}& del /f /q \"{uninstaller_text}\" & rmdir \"{location_text}\" & \"{schtasks}\" /Delete /TN \\BuzzDesk /F\""
    );
    let cmd = system_tool("cmd.exe");
    super::process::shell_execute_and_wait(&cmd.to_string_lossy(), &script, "runas", on_tick)?;

    if uninstaller.is_file() {
        return Err("legacy uninstaller did not complete".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // Reads HKLM on this machine: run explicitly with `-- --ignored`.
    #[test]
    #[ignore]
    fn detects_per_machine_install() {
        // Informational: prints the legacy install found on this machine, if any.
        let legacy = super::legacy_install();
        println!("legacy install: {legacy:?}");
    }
}
