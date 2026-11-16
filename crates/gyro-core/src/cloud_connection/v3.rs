//! Optional v3 project continuity. Native owns paths, spool files and credentials.
//! The public release remains disabled until hosted and native acceptance.
pub mod connection;
pub mod continuity;
pub mod project;
pub mod transfer;
#[cfg(test)]
mod transfer_tests;
pub const VERSION: &str = "3.0.0";
pub const POLICY: &str = "2026-11-07-v2";
pub const LEGACY_POLICY: &str = "2026-11-06-v1";
pub fn supported_policy(value: &str) -> bool {
    value == POLICY || value == LEGACY_POLICY
}
pub const MAX_PAYLOAD: u64 = 2_000_000_000;
pub const MAX_MANIFEST: usize = 8 * 1024 * 1024;
pub const MAX_FILES: usize = 25_000;
pub const CHUNK: usize = 4 * 1024 * 1024;
pub const MAGIC: &[u8; 8] = b"GYROPRJ1";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("The selected project changed. Review a fresh preview before saving.")]
    Changed,
    #[error("The project contains an unsupported or unsafe path.")]
    Path,
    #[error("The selected snapshot exceeds the supported size or file limit.")]
    Limit,
    #[error("The saved snapshot could not be verified.")]
    Integrity,
    #[error("The restore folder already exists. Choose a new folder.")]
    Destination,
    #[error("Project transfer is paused. Resume it after Cloud becomes available.")]
    Unavailable,
    #[error("Cloud sign-in is unavailable or expired. Reconnect this Mac or request a new email code. Prepared saves are preserved.")]
    SessionUnavailable,
    #[error("This transfer belongs to another Cloud account or device.")]
    Identity,
    #[error("This account has reached its device limit. Revoke a device, then register this Mac.")]
    DeviceLimit,
    #[error("This device was revoked. Sign in again before registering a new device identity.")]
    DeviceRevoked,
    #[error("macOS Keychain could not access the saved Cloud sign-in. Unlock your login keychain, then reconnect and approve any macOS Keychain request. If access is still unavailable, use a new email code after resolving Keychain access. Prepared saves are preserved.")]
    Keychain,
    #[error("This local transfer was stopped. Committed Cloud versions are preserved.")]
    Cancelled,
    #[error("A transfer is already running. Check its status before resuming.")]
    Busy,
    #[error("The local snapshot could not be read or written.")]
    Io(#[from] std::io::Error),
    #[error("The project metadata could not be verified.")]
    Format(#[from] serde_json::Error),
}
