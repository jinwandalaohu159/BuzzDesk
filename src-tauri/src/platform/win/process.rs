// Child processes for the update helper: waiting for BuzzDesk to exit and
// running an installer (or an elevated command) to completion.
use super::*;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};

// True once the process is gone (or never existed); false if it is still
// running after `timeout`.
pub fn wait_for_process_exit(pid: u32, timeout: Duration, on_tick: impl Fn(Duration)) -> bool {
    if pid == 0 {
        return true;
    }

    unsafe {
        // No handle: the process has already exited (or the pid was reused by
        // something we may not open, which equally means BuzzDesk is gone).
        let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else {
            return true;
        };
        let started = Instant::now();
        let mut exited = false;
        while started.elapsed() < timeout {
            let result = WaitForSingleObject(handle, 100);
            if result == WAIT_OBJECT_0 {
                exited = true;
                break;
            }
            if result != WAIT_TIMEOUT {
                break;
            }
            on_tick(started.elapsed());
        }
        let _ = CloseHandle(handle);
        exited
    }
}

pub fn run_installer_and_wait(installer: &Path, on_tick: impl Fn(Duration)) -> Result<(), String> {
    let exit_code = shell_execute_and_wait(&installer.to_string_lossy(), "/S", "open", on_tick)?;
    if exit_code != 0 {
        return Err(format!("installer exited with code {exit_code}"));
    }
    Ok(())
}

// Runs `file` via ShellExecuteEx (so manifests/`runas` can elevate) and waits
// for it, returning its exit code. Anything that prevents knowing the exit
// code is an error, never a silent success.
pub(super) fn shell_execute_and_wait(
    file: &str,
    parameters: &str,
    verb: &str,
    on_tick: impl Fn(Duration),
) -> Result<u32, String> {
    let file = to_wide(file);
    let verb = to_wide(verb);
    let parameters = to_wide(parameters);

    unsafe {
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(parameters.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };

        ShellExecuteExW(&mut info).map_err(|error| format!("failed to start process: {error}"))?;
        if info.hProcess.is_invalid() {
            return Err("started process returned no handle".to_string());
        }

        let started = Instant::now();
        loop {
            let result = WaitForSingleObject(info.hProcess, 100);
            if result == WAIT_OBJECT_0 {
                break;
            }
            if result != WAIT_TIMEOUT {
                let _ = CloseHandle(info.hProcess);
                return Err("failed while waiting for process".to_string());
            }
            on_tick(started.elapsed());
        }

        let mut exit_code = 0u32;
        let read = GetExitCodeProcess(info.hProcess, &mut exit_code);
        let _ = CloseHandle(info.hProcess);
        read.map_err(|error| format!("failed to read process exit code: {error}"))?;
        Ok(exit_code)
    }
}
