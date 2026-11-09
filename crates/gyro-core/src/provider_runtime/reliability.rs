//! Shared provider retry classification and bounded tool-loop policy.
use super::limits::PROVIDER_STOP_MARKER;
pub fn is_provider_cancellation(error: &str) -> bool {
    error.contains(PROVIDER_STOP_MARKER)
}
pub const CAPACITY_RETRY_EXHAUSTED: &str =
    "The model is still busy after three automatic attempts.";

pub const RETRY_EXHAUSTED: &str = "Automatic retries exhausted.";

pub const CONTINUATION_UNAVAILABLE: &str = "Saved provider continuation is unavailable.";
