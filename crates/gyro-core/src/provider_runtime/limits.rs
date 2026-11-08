//! Shared provider execution limits.
pub const MAX_CHAT_MESSAGE_CHARS: usize = 24_000;

pub const MAX_CHAT_RESPONSE_CHARS: usize = 64_000;

pub const TEXT_TRUNCATION_SUFFIX: &str = "...";
pub const PROVIDER_CHAT_MAX_RUNTIME_SECS: u64 = 24 * 60 * 60;

pub const PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS: u64 = 30 * 60;
