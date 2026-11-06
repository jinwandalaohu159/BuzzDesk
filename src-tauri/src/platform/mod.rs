// OS integration behind a single API; only Windows has a real implementation.
#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
pub use stub::*;

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::*;
