// Launch-at-logon registration (per-user scheduled task, HKCU Run key fallback).
use super::*;

pub(super) const STARTUP_TASK_NAME: &str = "\\BuzzDesk";

pub(super) const STARTUP_RUN_VALUE_NAME: &str = "BuzzDesk";

pub(super) const STARTUP_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

pub(super) const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn get_startup_enabled() -> bool {
    startup_task_exists() || startup_run_key_exists()
}

pub fn set_startup_enabled(enabled: bool) -> Result<(), String> {
    if enabled {
        let exe_path = env::current_exe()
            .map_err(|error| format!("failed to resolve current executable: {error}"))?;
        enable_startup_for(&exe_path)
    } else {
        delete_startup_entries()
    }
}

// Registers BuzzDesk to start at logon without ever asking for elevation: a
// per-user logon task first, the HKCU Run key if that is refused.
pub fn enable_startup_for(exe_path: &Path) -> Result<(), String> {
    match create_startup_task(exe_path) {
        Ok(()) => {
            let _ = delete_startup_run_key();
            Ok(())
        }
        Err(task_error) => create_startup_run_key(exe_path)
            .map_err(|run_error| format!("{task_error}; run key fallback failed: {run_error}")),
    }
}

// Points an existing startup entry at this executable (e.g. after moving
// from a Program Files install to the per-user one).
pub fn repair_startup_entry() -> Result<bool, String> {
    let exe_path = env::current_exe()
        .map_err(|error| format!("failed to resolve current executable: {error}"))?;
    let exe_text = exe_path.to_string_lossy().to_lowercase();

    if startup_task_exists() {
        let output = schtasks()
            .args(["/Query", "/TN", STARTUP_TASK_NAME, "/XML"])
            .output()
            .map_err(|error| format!("failed to query startup task: {error}"))?;
        let xml = String::from_utf8_lossy(&output.stdout).to_lowercase();
        if xml.contains(&exe_text) {
            return Ok(false);
        }
        enable_startup_for(&exe_path)?;
        return Ok(true);
    }

    if startup_run_key_exists() {
        let output = reg()
            .args(["QUERY", STARTUP_RUN_KEY, "/V", STARTUP_RUN_VALUE_NAME])
            .output()
            .map_err(|error| format!("failed to query startup registry value: {error}"))?;
        let value = String::from_utf8_lossy(&output.stdout).to_lowercase();
        if value.contains(&exe_text) {
            return Ok(false);
        }
        create_startup_run_key(&exe_path)?;
        return Ok(true);
    }

    Ok(false)
}

pub(super) fn startup_task_exists() -> bool {
    schtasks()
        .args(["/Query", "/TN", STARTUP_TASK_NAME])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub(super) fn create_startup_task(exe_path: &Path) -> Result<(), String> {
    let xml_path = env::temp_dir().join("buzzdesk-startup.xml");
    write_utf16_xml(&xml_path, &startup_task_xml(exe_path))
        .map_err(|error| format!("failed to write startup task XML: {error}"))?;

    let xml_path_text = xml_path.to_string_lossy().to_string();
    let result = schtasks_ok(&[
        "/Create",
        "/TN",
        STARTUP_TASK_NAME,
        "/XML",
        &xml_path_text,
        "/F",
    ]);

    let _ = fs::remove_file(xml_path);
    result
}

pub(super) fn delete_startup_entries() -> Result<(), String> {
    let task_result = delete_startup_task();
    let run_key_result = delete_startup_run_key();

    match (task_result, run_key_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(task_error), Ok(())) => Err(task_error),
        (Ok(()), Err(run_key_error)) => Err(run_key_error),
        (Err(task_error), Err(run_key_error)) => Err(format!("{task_error}; {run_key_error}")),
    }
}

pub(super) fn delete_startup_task() -> Result<(), String> {
    if !startup_task_exists() {
        return Ok(());
    }

    schtasks_ok_allow_elevation(&["/Delete", "/TN", STARTUP_TASK_NAME, "/F"])
}

// Binding the trigger and principal to the current user is what lets a
// non-elevated process register a logon task (an "any user" logon trigger
// requires administrator rights).
pub(super) fn current_user_id() -> Option<String> {
    let user = env::var("USERNAME").ok().filter(|value| !value.trim().is_empty())?;
    Some(match env::var("USERDOMAIN").ok().filter(|value| !value.trim().is_empty()) {
        Some(domain) => format!("{domain}\\{user}"),
        None => user,
    })
}

pub(super) fn startup_task_xml(exe_path: &Path) -> String {
    let command = xml_escape(&format!("\"{}\"", exe_path.to_string_lossy()));
    let user_id = current_user_id()
        .map(|user| format!("\n      <UserId>{}</UserId>", xml_escape(&user)))
        .unwrap_or_default();
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
<LogonTrigger>
  <Enabled>true</Enabled>{user_id}
</LogonTrigger>
  </Triggers>
  <Principals>
<Principal id="Author">{user_id}
  <LogonType>InteractiveToken</LogonType>
  <RunLevel>LeastPrivilege</RunLevel>
</Principal>
  </Principals>
  <Settings>
<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
<AllowHardTerminate>true</AllowHardTerminate>
<StartWhenAvailable>false</StartWhenAvailable>
<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
<IdleSettings>
  <StopOnIdleEnd>false</StopOnIdleEnd>
  <RestartOnIdle>false</RestartOnIdle>
</IdleSettings>
<AllowStartOnDemand>true</AllowStartOnDemand>
<Enabled>true</Enabled>
<Hidden>false</Hidden>
<RunOnlyIfIdle>false</RunOnlyIfIdle>
<WakeToRun>false</WakeToRun>
<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
<Priority>0</Priority>
  </Settings>
  <Actions Context="Author">
<Exec>
  <Command>{command}</Command>
</Exec>
  </Actions>
</Task>
"#
    )
}

pub(super) fn write_utf16_xml(path: &Path, xml: &str) -> std::io::Result<()> {
    let mut bytes = Vec::with_capacity(xml.len() * 2 + 2);
    bytes.extend_from_slice(&[0xff, 0xfe]);
    for code in xml.encode_utf16() {
        bytes.extend_from_slice(&code.to_le_bytes());
    }

    fs::write(path, bytes)
}

pub(super) fn startup_run_key_exists() -> bool {
    reg()
        .args(["QUERY", STARTUP_RUN_KEY, "/V", STARTUP_RUN_VALUE_NAME])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub(super) fn create_startup_run_key(exe_path: &Path) -> Result<(), String> {
    let value = format!("\"{}\"", exe_path.to_string_lossy());
    let status = reg()
        .args([
            "ADD",
            STARTUP_RUN_KEY,
            "/V",
            STARTUP_RUN_VALUE_NAME,
            "/T",
            "REG_SZ",
            "/D",
            &value,
            "/F",
        ])
        .status()
        .map_err(|error| format!("failed to write startup registry value: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("failed to write startup registry value".to_string())
    }
}

pub(super) fn delete_startup_run_key() -> Result<(), String> {
    if !startup_run_key_exists() {
        return Ok(());
    }

    let status = reg()
        .args([
            "DELETE",
            STARTUP_RUN_KEY,
            "/V",
            STARTUP_RUN_VALUE_NAME,
            "/F",
        ])
        .status()
        .map_err(|error| format!("failed to delete startup registry value: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("failed to delete startup registry value".to_string())
    }
}

pub(super) fn schtasks_ok_allow_elevation(args: &[&str]) -> Result<(), String> {
    match schtasks_ok(args) {
        Ok(()) => Ok(()),
        Err(error) => schtasks_ok_elevated(args).map_err(|elevated_error| {
            format!("{error}; elevated retry failed: {elevated_error}")
        }),
    }
}

pub(super) fn schtasks_ok(args: &[&str]) -> Result<(), String> {
    let output = schtasks()
        .args(args)
        .output()
        .map_err(|error| format!("failed to run schtasks: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let message = format!("{stderr}{stdout}").trim().to_string();
    Err(if message.is_empty() {
        "schtasks failed".to_string()
    } else {
        message
    })
}

pub(super) fn schtasks_ok_elevated(args: &[&str]) -> Result<(), String> {
    let parameters = args
        .iter()
        .map(|arg| windows_command_arg(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let verb = to_wide("runas");
    let file = to_wide(&system_tool("schtasks.exe").to_string_lossy());
    let params = to_wide(&parameters);

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };

    unsafe {
        ShellExecuteExW(&mut info)
            .map_err(|error| format!("failed to request startup task elevation: {error}"))?;

        if info.hProcess.is_invalid() {
            return Err("startup task elevation did not return a process handle".to_string());
        }

        WaitForSingleObject(info.hProcess, INFINITE);

        let mut exit_code = 1;
        let read_result = GetExitCodeProcess(info.hProcess, &mut exit_code);
        let _ = CloseHandle(info.hProcess);
        read_result
            .map_err(|error| format!("failed to read elevated startup task result: {error}"))?;

        if exit_code == 0 {
            Ok(())
        } else {
            Err(format!("elevated schtasks exited with code {exit_code}"))
        }
    }
}

pub(super) fn windows_command_arg(value: &str) -> String {
    if !value.is_empty()
        && !value
            .chars()
            .any(|ch| ch.is_whitespace() || ch == '\"' || ch == '\\')
    {
        return value.to_string();
    }

    let mut escaped = String::from("\"");
    let mut backslashes = 0;

    for ch in value.chars() {
        match ch {
            '\\' => backslashes += 1,
            '\"' => {
                escaped.push_str(&"\\".repeat(backslashes * 2 + 1));
                escaped.push('\"');
                backslashes = 0;
            }
            _ => {
                escaped.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                escaped.push(ch);
            }
        }
    }

    escaped.push_str(&"\\".repeat(backslashes * 2));
    escaped.push('\"');
    escaped
}

pub(super) fn schtasks() -> Command {
    let mut command = Command::new(system_tool("schtasks.exe"));
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

pub(super) fn reg() -> Command {
    let mut command = Command::new(system_tool("reg.exe"));
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(test)]
mod tests {
    #[test]
    fn builds_user_scoped_startup_task() {
        let xml = super::startup_task_xml(std::path::Path::new(r"C:\Users\me\AppData\Local\BuzzDesk\buzzdesk.exe"));
        assert!(xml.contains("<UserId>"));
        assert!(xml.contains("buzzdesk.exe"));
    }
}
