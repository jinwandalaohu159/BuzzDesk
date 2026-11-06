// One BuzzDesk per user session: a second copy (Start menu while the logon
// task already started one) would stack a second desktop layer and tray icon,
// and both would write the same layout file.
use windows::core::w;
use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
use windows::Win32::System::Threading::CreateMutexW;

// False if another instance already holds the session mutex. The mutex is
// released by Windows when this process exits.
pub fn claim_single_instance() -> bool {
    unsafe {
        match CreateMutexW(None, false, w!("Local\\BuzzDesk.DesktopLayer")) {
            // The handle is deliberately never closed: it holds the mutex for
            // the life of the process.
            Ok(_handle) => GetLastError() != ERROR_ALREADY_EXISTS,
            // Can't tell; don't refuse to start over it.
            Err(_) => true,
        }
    }
}
