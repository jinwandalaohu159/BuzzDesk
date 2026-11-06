// Small Win32 string helpers shared by the platform modules.
use super::*;
use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows::Win32::System::Com::COINIT_MULTITHREADED;

pub(super) fn wide_buffer_to_string(buffer: &[u16]) -> String {
    let len = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

pub(super) fn to_wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

// Joins the calling thread to a COM single-threaded apartment for the guard's
// lifetime. Shell APIs (SHGetFileInfo, IShellLink, SHFileOperation, ...) need
// COM, and commands may run on worker threads that never initialized it. On a
// thread that is already STA this is a balanced no-op.
pub(super) struct ComApartment {
    initialized: bool,
}

impl ComApartment {
    pub(super) fn enter() -> Self {
        let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
        Self { initialized }
    }

    // For WinRT and other free-threaded APIs used from plain worker threads.
    pub(super) fn enter_multithreaded() -> Self {
        let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        Self { initialized }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { CoUninitialize() };
        }
    }
}

pub(super) fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

// Full path of a Windows tool in System32. Bare names would also search the
// application directory first, which a per-user install lets the user write.
pub(super) fn system_tool(name: &str) -> PathBuf {
    let mut buffer = [0u16; 260];
    let len = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    let system = if len > 0 && len < buffer.len() {
        PathBuf::from(String::from_utf16_lossy(&buffer[..len]))
    } else {
        PathBuf::from(r"C:\Windows\System32")
    };
    system.join(name)
}
