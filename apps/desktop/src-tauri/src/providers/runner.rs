//! Shared dispatch with the desktop's host implementation kept separately.
pub(crate) use gyro_core::provider_runtime::host::{ProviderHeartbeat, RunEvent, RunnerHost};
pub(crate) use gyro_core::provider_runtime::registry::runner_for;
#[cfg(test)]
use gyro_core::provider_runtime::types::{
    ProviderAdapterKind, ProviderChatRequest, ProviderResumeCursor, ProviderRunAttempt,
};
#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;
