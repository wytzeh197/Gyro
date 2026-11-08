//! Shared provider execution limits.
pub const MAX_CHAT_MESSAGE_CHARS: usize = 24_000;

pub const MAX_CHAT_RESPONSE_CHARS: usize = 64_000;

pub const TEXT_TRUNCATION_SUFFIX: &str = "...";
pub const PROVIDER_CHAT_MAX_RUNTIME_SECS: u64 = 24 * 60 * 60;

pub const PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS: u64 = 30 * 60;

/// The phrase every stop message opens with.
///
/// A stop travels the rest of the way as an error string, and several places
/// have to tell one from a genuine failure. They match this rather than the
/// whole sentence so the sentence stays free to say what actually happened.
pub const PROVIDER_STOP_MARKER: &str = "chat cancelled by";

/// The stable phrase of a turn Gyro ended because the provider went silent.
pub const PROVIDER_STALL_MARKER: &str = "the provider sent nothing for";

pub const MAX_CHAT_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
