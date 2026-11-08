// Launch-at-logon registration: a per-user logon task (registered through the
// Task Scheduler COM API from XML), with the HKCU Run key as a fallback.
//
// The logon task starts right after sign-in; Run key entries wait for the
// shell to finish loading. Everything here talks to Task Scheduler and the
// registry in-process: no schtasks.exe / reg.exe, so no console code page
// mangling the paths we compare, and no process spawns on every boot.
use super::*;
use windows::core::BSTR;
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, E_ACCESSDENIED, WIN32_ERROR};
use windows::Win32::System::Registry::{
    RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
};
use windows::Win32::System::TaskScheduler::{
    ITaskFolder, ITaskService, TaskScheduler, TASK_CREATE_OR_UPDATE, TASK_LOGON_INTERACTIVE_TOKEN,
};
use windows::Win32::System::Variant::VARIANT;

// Task name in the Task Scheduler root folder.
const STARTUP_TASK_NAME: &str = "BuzzDesk";

const STARTUP_RUN_VALUE_NAME: &str = "BuzzDesk";

const STARTUP_RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

pub fn get_startup_enabled() -> bool {
    startup_task_exists() || read_run_value().is_some()
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
            let _ = delete_run_value();
            Ok(())
        }
        Err(task_error) => write_run_value(exe_path)
            .map_err(|run_error| format!("{task_error}; run key fallback failed: {run_error}")),
    }
}

// Runs at every launch: keeps an enabled startup entry pointing at this
// executable (e.g. after moving from Program Files to the per-user install)
// and upgrades Run key entries to the faster logon task. Returns whether
// anything was changed.
pub fn repair_startup_entry() -> Result<bool, String> {
    // A development build must never take over the user's real startup entry.
    if cfg!(debug_assertions) {
        return Ok(false);
    }

    let exe_path = env::current_exe()
        .map_err(|error| format!("failed to resolve current executable: {error}"))?;

    if let Some(xml) = startup_task_xml_text() {
        let mut changed = false;
        if !task_command_matches(&xml, &exe_path) {
            enable_startup_for(&exe_path)?;
            changed = true;
        }
        // A leftover Run value would start a second copy at logon.
        if read_run_value().is_some() && delete_run_value().is_ok() {
            changed = true;
        }
        return Ok(changed);
    }

    let Some(run_value) = read_run_value() else {
        // Startup is off: leave it off.
        return Ok(false);
    };

    match create_startup_task(&exe_path) {
        Ok(()) => {
            delete_run_value()?;
            Ok(true)
        }
        Err(_) if same_executable(&run_value, &exe_path) => Ok(false),
        Err(_) => write_run_value(&exe_path).map(|()| true),
    }
}

fn delete_startup_entries() -> Result<(), String> {
    let task_result = delete_startup_task();
    let run_key_result = delete_run_value();

    match (task_result, run_key_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(task_error), Ok(())) => Err(task_error),
        (Ok(()), Err(run_key_error)) => Err(run_key_error),
        (Err(task_error), Err(run_key_error)) => Err(format!("{task_error}; {run_key_error}")),
    }
}

// --- Task Scheduler ------------------------------------------------------------

fn task_root_folder() -> Result<ITaskFolder, String> {
    unsafe {
        let service: ITaskService = CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| format!("Task Scheduler unavailable: {error}"))?;
        let empty = VARIANT::default();
        service
            .Connect(&empty, &empty, &empty, &empty)
            .map_err(|error| format!("failed to connect to Task Scheduler: {error}"))?;
        service
            .GetFolder(&BSTR::from("\\"))
            .map_err(|error| format!("failed to open the Task Scheduler root folder: {error}"))
    }
}

// Registered XML of a task, or None when it doesn't exist (or can't be read).
fn task_xml_text(name: &str) -> Option<String> {
    let _com = ComApartment::enter();
    let folder = task_root_folder().ok()?;
    unsafe {
        let task = folder.GetTask(&BSTR::from(name)).ok()?;
        task.Xml().ok().map(|xml| xml.to_string())
    }
}

fn register_task_xml(name: &str, xml: &str) -> Result<(), String> {
    let _com = ComApartment::enter();
    let folder = task_root_folder()?;
    let empty = VARIANT::default();
    unsafe {
        folder
            .RegisterTask(
                &BSTR::from(name),
                &BSTR::from(xml),
                TASK_CREATE_OR_UPDATE.0,
                &empty,
                &empty,
                TASK_LOGON_INTERACTIVE_TOKEN,
                &empty,
            )
            .map(|_| ())
            .map_err(|error| format!("failed to register startup task: {error}"))
    }
}

enum DeleteOutcome {
    Deleted,
    Missing,
    AccessDenied,
}

fn delete_task(name: &str) -> Result<DeleteOutcome, String> {
    let _com = ComApartment::enter();
    let folder = task_root_folder()?;
    match unsafe { folder.DeleteTask(&BSTR::from(name), 0) } {
        Ok(()) => Ok(DeleteOutcome::Deleted),
        Err(error) if error.code() == ERROR_FILE_NOT_FOUND.to_hresult() => Ok(DeleteOutcome::Missing),
        Err(error) if error.code() == E_ACCESSDENIED => Ok(DeleteOutcome::AccessDenied),
        Err(error) => Err(format!("failed to delete startup task: {error}")),
    }
}

fn startup_task_exists() -> bool {
    startup_task_xml_text().is_some()
}

fn startup_task_xml_text() -> Option<String> {
    task_xml_text(STARTUP_TASK_NAME)
}

fn create_startup_task(exe_path: &Path) -> Result<(), String> {
    register_task_xml(STARTUP_TASK_NAME, &startup_task_xml(exe_path))
}

fn delete_startup_task() -> Result<(), String> {
    match delete_task(STARTUP_TASK_NAME)? {
        DeleteOutcome::Deleted | DeleteOutcome::Missing => Ok(()),
        // A task left behind by an elevated (per-machine) install.
        DeleteOutcome::AccessDenied => {
            let name = format!("\\{STARTUP_TASK_NAME}");
            schtasks_elevated(&["/Delete", "/TN", &name, "/F"])
        }
    }
}

// Binding the trigger and principal to the current user is what lets a
// non-elevated process register a logon task (an "any user" logon trigger
// requires administrator rights).
fn current_user_id() -> Option<String> {
    let user = env::var("USERNAME").ok().filter(|value| !value.trim().is_empty())?;
    Some(match env::var("USERDOMAIN").ok().filter(|value| !value.trim().is_empty()) {
        Some(domain) => format!("{domain}\\{user}"),
        None => user,
    })
}

pub(super) fn startup_task_xml(exe_path: &Path) -> String {
    logon_task_xml(exe_path, true)
}

// Priority 4 is the normal process priority. Anything above normal (0-3)
// needs administrator rights, and registering such a task without them fails
// with "access denied".
fn logon_task_xml(exe_path: &Path, enabled: bool) -> String {
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
    <Enabled>{enabled}</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
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

// Whether a registered task's (first) <Command> launches `exe_path`.
fn task_command_matches(xml: &str, exe_path: &Path) -> bool {
    let Some(start) = xml.find("<Command>") else {
        return false;
    };
    let rest = &xml[start + "<Command>".len()..];
    let Some(end) = rest.find("</Command>") else {
        return false;
    };
    same_executable(&xml_unescape(&rest[..end]), exe_path)
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

// Paths compare case-insensitively on Windows; launch commands may be quoted.
fn same_executable(command: &str, exe_path: &Path) -> bool {
    let command = command.trim().trim_matches('"').trim();
    command.to_lowercase() == exe_path.to_string_lossy().to_lowercase()
}

// --- HKCU Run key ----------------------------------------------------------------

fn read_run_value() -> Option<String> {
    let subkey = to_wide(STARTUP_RUN_SUBKEY);
    let name = to_wide(STARTUP_RUN_VALUE_NAME);
    let mut buffer = vec![0u16; 2048];
    let mut size = (buffer.len() * 2) as u32;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    let len = (size as usize / 2).saturating_sub(1).min(buffer.len());
    let value = String::from_utf16_lossy(&buffer[..len]);
    (!value.trim().is_empty()).then_some(value)
}

fn write_run_value(exe_path: &Path) -> Result<(), String> {
    let subkey = to_wide(STARTUP_RUN_SUBKEY);
    let name = to_wide(STARTUP_RUN_VALUE_NAME);
    let data = to_wide(&format!("\"{}\"", exe_path.to_string_lossy()));
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(name.as_ptr()),
            REG_SZ.0,
            Some(data.as_ptr().cast()),
            (data.len() * 2) as u32,
        )
        .ok()
        .map_err(|error| format!("failed to write startup registry value: {error}"))
    }
}

fn delete_run_value() -> Result<(), String> {
    let subkey = to_wide(STARTUP_RUN_SUBKEY);
    let name = to_wide(STARTUP_RUN_VALUE_NAME);
    let result: WIN32_ERROR = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, PCWSTR(subkey.as_ptr()), PCWSTR(name.as_ptr())) };
    if result == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    result
        .ok()
        .map_err(|error| format!("failed to delete startup registry value: {error}"))
}

// --- Elevated fallback -----------------------------------------------------------

// Only for a task an elevated (per-machine) install left behind, which this
// user may not delete. Runs System32's schtasks.exe through a UAC prompt.
fn schtasks_elevated(args: &[&str]) -> Result<(), String> {
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

fn windows_command_arg(value: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_user_scoped_startup_task() {
        let exe = Path::new(r"C:\Users\me\AppData\Local\BuzzDesk\buzzdesk.exe");
        let xml = startup_task_xml(exe);
        assert!(xml.contains("<UserId>"));
        assert!(xml.contains("<Priority>4</Priority>"));
        assert!(!xml.contains("<Delay>"));
        assert!(task_command_matches(&xml, exe));
    }

    #[test]
    fn compares_task_commands_like_windows_paths() {
        let exe = Path::new(r"C:\Users\Zhang & Co\AppData\Local\BuzzDesk\buzzdesk.exe");
        let xml = startup_task_xml(exe);
        assert!(xml.contains("&amp;"));
        assert!(task_command_matches(&xml, exe));
        assert!(task_command_matches(&xml, Path::new(r"c:\USERS\zhang & co\AppData\Local\BuzzDesk\BUZZDESK.EXE")));
        assert!(!task_command_matches(&xml, Path::new(r"D:\Programs\BuzzDesk\buzzdesk.exe")));
        assert!(same_executable("\"D:\\Programs\\BuzzDesk\\BuzzDesk.exe\"", Path::new(r"d:\programs\buzzdesk\buzzdesk.exe")));
    }

    // Registers a disabled throwaway logon task through COM without elevation,
    // reads it back and removes it. Never touches the real "BuzzDesk" task.
    // Run with `cargo test registers_logon_task_without_elevation -- --ignored`.
    #[test]
    #[ignore]
    fn registers_logon_task_without_elevation() {
        const NAME: &str = "BuzzDeskTestTask";
        let notepad = system_tool("notepad.exe");
        let _ = delete_task(NAME);

        register_task_xml(NAME, &logon_task_xml(&notepad, false)).expect("register task without elevation");
        let xml = task_xml_text(NAME).expect("read registered task back");
        let deleted = delete_task(NAME);

        assert!(task_command_matches(&xml, &notepad), "registered XML: {xml}");
        assert!(xml.contains("<Priority>4</Priority>"));
        assert!(matches!(deleted, Ok(DeleteOutcome::Deleted)));
        assert!(task_xml_text(NAME).is_none());
    }
}
