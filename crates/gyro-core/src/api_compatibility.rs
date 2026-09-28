//! Remember a confirmed optional-field rejection briefly, scoped to endpoint,
//! model and credential identity. No keys, bodies or observations reach disk.
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

fn cache() -> &'static Mutex<HashMap<u64, Instant>> {
    static CACHE: OnceLock<Mutex<HashMap<u64, Instant>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}
pub(crate) fn identity(url: &str, model: &str, key: &str) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (url, model, key).hash(&mut hash);
    hash.finish()
}
pub(crate) fn include_usage(identity: u64) -> bool {
    let Ok(mut entries) = cache().lock() else {
        return true;
    };
    entries.retain(|_, at| at.elapsed() < Duration::from_secs(15 * 60));
    !entries.contains_key(&identity)
}
pub(crate) fn remember_usage_rejection(identity: u64) {
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
        entries.insert(identity, Instant::now());
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
}
