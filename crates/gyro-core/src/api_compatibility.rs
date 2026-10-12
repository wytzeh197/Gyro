//! Remember a confirmed optional-field rejection briefly, scoped to endpoint,
//! model and credential identity. No keys, bodies or observations reach disk.
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
enum RejectedField {
    Usage,
    Tools,
}

fn cache() -> &'static Mutex<HashMap<(u64, RejectedField), Instant>> {
    static CACHE: OnceLock<Mutex<HashMap<(u64, RejectedField), Instant>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}
pub(crate) fn identity(url: &str, model: &str, key: &str) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (url, model, key).hash(&mut hash);
    hash.finish()
}
pub(crate) fn include_usage(identity: u64) -> bool {
    field_available(identity, RejectedField::Usage)
}
pub(crate) fn native_tools_available(identity: u64) -> bool {
    field_available(identity, RejectedField::Tools)
}
fn field_available(identity: u64, field: RejectedField) -> bool {
    let Ok(mut entries) = cache().lock() else {
        return true;
    };
    entries.retain(|_, at| at.elapsed() < Duration::from_secs(15 * 60));
    !entries.contains_key(&(identity, field))
}
pub(crate) fn remember_usage_rejection(identity: u64) {
    remember_rejection(identity, RejectedField::Usage);
}
pub(crate) fn remember_tools_rejection(identity: u64) {
    remember_rejection(identity, RejectedField::Tools);
}
fn remember_rejection(identity: u64, field: RejectedField) {
    if let Ok(mut entries) = cache().lock() {
        if entries.len() >= 128 {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(key, _)| *key)
            {
                entries.remove(&oldest);
            }
        }
        entries.insert((identity, field), Instant::now());
    }
}
pub(crate) fn rejects_usage_field(body: &str) -> bool {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("message"))
        })
        .and_then(serde_json::Value::as_str)
        .unwrap_or(body);
    let text = message.to_ascii_lowercase();
    text.contains("stream_options")
        && [
            "unknown",
            "unsupported",
            "not supported",
            "unrecognized",
            "not permitted",
            "not allowed",
            "unexpected",
            "extra inputs",
        ]
        .iter()
        .any(|word| text.contains(word))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_an_explicit_optional_field_rejection_can_change_a_request() {
        assert!(rejects_usage_field("unknown field stream_options"));
        for error in [
            "unsupported tools",
            "unknown model",
            "invalid stream_options value",
            "context too long",
            "unsupported reasoning_effort",
        ] {
            assert!(!rejects_usage_field(error), "{error}");
        }
        assert_ne!(
            identity("https://a/v1", "m", "a"),
            identity("https://a/v1", "m", "b")
        );
    }

    #[test]
    fn tool_rejection_isolated_from_usage_endpoint_model_and_credential() {
        let id = identity("https://tools-fixture/v1", "model-a", "key-a");
        assert!(native_tools_available(id));
        remember_tools_rejection(id);
        assert!(!native_tools_available(id));
        assert!(include_usage(id));
        for other in [
            identity("https://other-tools-fixture/v1", "model-a", "key-a"),
            identity("https://tools-fixture/v1", "model-b", "key-a"),
            identity("https://tools-fixture/v1", "model-a", "key-b"),
        ] {
            assert!(native_tools_available(other));
        }
        remember_usage_rejection(id);
        assert!(!include_usage(id));
        assert!(!native_tools_available(id));
    }

    #[test]
    fn tool_support_is_probed_again_when_the_rejection_expires() {
        let id = identity("https://expiring-tools-fixture/v1", "m", "k");
        cache().lock().unwrap().insert(
            (id, RejectedField::Tools),
            Instant::now() - Duration::from_secs(15 * 60 + 1),
        );
        assert!(native_tools_available(id));
    }
}
