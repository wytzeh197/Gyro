//! Per-route prefix-cache plan. Planning is local: no request is sent to discover it, no per-model
//! price table is consulted, and one route's answer never changes another route's cost.
//!
//! The distinction that matters is explicit vs implicit prefix caching:
//! * `Explicit` — the provider needs markers in the request (Anthropic-style `cache_control`).
//! * `Implicit` — the provider caches a stable prefix on its own, so the only thing that can break
//!   the cache is *us* rewriting early messages. That makes prefix stability our responsibility.
//! * `None` — nothing to cache; shaping would only add bytes.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

/// Hosts that accept an explicit `prompt_cache_key`. Kept narrow: only send a field to a provider
/// whose API is documented to accept it, because a rejected unknown field is a hard request error.
pub const KEY_HOSTS: [&str; 1] = ["api.openai.com"];
/// Models that additionally accept `prompt_cache_options`.
pub const OPTION_MODELS: [&str; 3] = ["gpt-5.6", "gpt-6", "gpt-6-mini"];
/// Hosts with documented automatic prefix caching. Sending nothing is correct here; rewriting the
/// prefix is what costs money.
pub const IMPLICIT_HOSTS: [&str; 3] = [
    "api.deepseek.com",
    "api.mistral.ai",
    "generativelanguage.googleapis.com",
];
pub const CACHE_TTL: &str = "30m";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum PrefixCaching {
    #[default]
    None,
    Implicit,
    Explicit,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    pub caching: PrefixCaching,
    /// `prompt_cache_key` to place in the body, if this route takes one.
    pub key: Option<String>,
    /// `prompt_cache_options` to place in the body, if this route takes them.
    pub options: Option<Value>,
    /// How many `cache_control` breakpoints this route wants; 0 for OpenAI-style routes.
    pub breakpoints: usize,
    pub reason: &'static str,
}

impl Plan {
    /// True when the plan tells us the prefix must stay byte-identical to keep hitting the cache.
    pub fn wants_stable_prefix(&self) -> bool {
        !matches!(self.caching, PrefixCaching::None)
    }
    /// True when the plan actually changes the request body.
    pub fn shapes_request(&self) -> bool {
        self.key.is_some() || self.options.is_some() || self.breakpoints > 0
    }
}

/// The `prompt_cache_key` for an OpenAI Chat Completions body.
///
/// These bytes are deliberately the ones this route has always sent — `gyro:` followed by the
/// SHA-256 of the stable instruction prefix and the tool schema — because changing them, even to
/// something tidier, would invalidate every cache the fleet is currently holding. Anything that
/// rewrites an early message changes this key, which is exactly the churn
/// [`Plan::wants_stable_prefix`] exists to warn about.
pub fn openai_prefix_key(payload: &Value) -> String {
    let stable = payload["messages"]
        .as_array()
        .map(|m| {
            m.iter()
                .filter(|v| matches!(v["role"].as_str(), Some("system" | "developer")))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let prefix = json!({"instructions":stable,"tools":payload["tools"]});
    format!(
        "gyro:{:x}",
        Sha256::digest(serde_json::to_vec(&prefix).unwrap_or_default())
    )
}

/// `prompt_cache_options` for a model that accepts them, or `None` for one that does not.
pub fn openai_cache_options(model: &str) -> Option<Value> {
    OPTION_MODELS
        .iter()
        .any(|prefix| model == *prefix || model.starts_with(&format!("{prefix}-")))
        .then(|| json!({"mode":"implicit","ttl":CACHE_TTL}))
}

pub fn host_of(endpoint: &Url) -> &str {
    endpoint.host_str().unwrap_or_default()
}

pub fn prefix_caching(endpoint: &Url) -> PrefixCaching {
    let host = host_of(endpoint);
    if host == "api.openai.com" {
        PrefixCaching::Explicit
    } else if IMPLICIT_HOSTS.contains(&host) {
        PrefixCaching::Implicit
    } else {
        PrefixCaching::None
    }
}

/// Stable key for one cached prefix. Salted with a version tag so this key can never collide with a
/// key derived for another purpose from the same bytes.
pub fn digest(seed: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"gyro-prefix-v1");
    for part in seed {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    let hex = format!("{:x}", hasher.finalize());
    hex[..32].to_owned()
}

/// Decide what this route needs. `seed` is the prefix-defining content (instructions, then tools) in
/// a stable order; it is only hashed when the route actually accepts a key.
pub fn plan(endpoint: &Url, model: &str, seed: &[&str], enabled: bool) -> Plan {
    if !enabled {
        return Plan::default();
    }
    let host = host_of(endpoint);
    let caching = prefix_caching(endpoint);
    let key = if KEY_HOSTS.contains(&host) && !seed.is_empty() {
        Some(digest(seed))
    } else {
        None
    };
    let options = if key.is_some() && OPTION_MODELS.contains(&model) {
        Some(json!({ "mode": "implicit", "ttl": CACHE_TTL }))
    } else {
        None
    };
    let reason = match (caching, key.is_some()) {
        (PrefixCaching::Explicit, true) => "explicit key",
        (PrefixCaching::Explicit, false) => "explicit route without a prefix seed",
        (PrefixCaching::Implicit, _) => "automatic prefix cache, keep the prefix stable",
        (PrefixCaching::None, _) => "no prefix cache on this route",
    };
    Plan {
        caching,
        key,
        options,
        breakpoints: 0,
        reason,
    }
}

/// Apply the plan to a request body and return it, so the caller can record what it did.
pub fn apply(
    payload: &mut Value,
    endpoint: &Url,
    model: &str,
    seed: &[&str],
    enabled: bool,
) -> Plan {
    let plan = plan(endpoint, model, seed, enabled);
    if let Some(key) = &plan.key {
        payload["prompt_cache_key"] = json!(key);
    }
    if let Some(options) = &plan.options {
        payload["prompt_cache_options"] = options.clone();
    }
    plan
}

/// Length of the leading run of messages that is byte-identical between two rounds.
pub fn stable_prefix_len(previous: &[Value], current: &[Value]) -> usize {
    previous
        .iter()
        .zip(current.iter())
        .take_while(|(left, right)| left == right)
        .count()
}

/// True when the new round only appended: every earlier message survived untouched.
pub fn appended_only(previous: &[Value], current: &[Value]) -> bool {
    current.len() >= previous.len() && stable_prefix_len(previous, current) == previous.len()
}

/// Byte range that a provider could serve from cache, given how much of the prefix held still.
pub fn cacheable_bytes(previous: &[Value], current: &[Value]) -> usize {
    let stable = stable_prefix_len(previous, current);
    current
        .iter()
        .take(stable)
        .map(|message| message.to_string().len())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("valid url")
    }

    fn message(role: &str, body: &str) -> Value {
        json!({ "role": role, "content": body })
    }

    #[test]
    fn openai_route_gets_a_key_and_options() {
        let plan = plan(
            &url("https://api.openai.com/v1/chat/completions"),
            "gpt-6",
            &["instructions", "tools"],
            true,
        );
        assert_eq!(plan.caching, PrefixCaching::Explicit);
        assert!(plan.key.is_some());
        assert_eq!(plan.options.as_ref().unwrap()["ttl"], CACHE_TTL);
        assert!(plan.shapes_request());
    }

    #[test]
    fn openai_route_without_options_model_still_gets_a_key() {
        let plan = plan(
            &url("https://api.openai.com/v1/chat/completions"),
            "gpt-4o",
            &["instructions"],
            true,
        );
        assert!(plan.key.is_some());
        assert!(plan.options.is_none());
    }

    #[test]
    fn implicit_route_sends_nothing_but_still_demands_a_stable_prefix() {
        let plan = plan(
            &url("https://api.deepseek.com/v1/chat/completions"),
            "deepseek-chat",
            &["instructions"],
            true,
        );
        assert_eq!(plan.caching, PrefixCaching::Implicit);
        assert!(plan.key.is_none(), "no undocumented field on the wire");
        assert!(plan.options.is_none());
        assert!(!plan.shapes_request());
        assert!(plan.wants_stable_prefix());
    }

    #[test]
    fn unknown_route_plans_nothing() {
        let plan = plan(
            &url("http://127.0.0.1:11434/v1/chat/completions"),
            "llama3",
            &["instructions"],
            true,
        );
        assert_eq!(plan.caching, PrefixCaching::None);
        assert!(!plan.shapes_request());
        assert!(!plan.wants_stable_prefix());
    }

    #[test]
    fn disabled_plan_touches_nothing() {
        let mut payload = json!({ "model": "gpt-6" });
        let plan = apply(
            &mut payload,
            &url("https://api.openai.com/v1/chat/completions"),
            "gpt-6",
            &["instructions"],
            false,
        );
        assert_eq!(plan, Plan::default());
        assert!(payload.get("prompt_cache_key").is_none());
        assert!(payload.get("prompt_cache_options").is_none());
    }

    #[test]
    fn apply_writes_the_same_fields_the_plan_names() {
        let mut payload = json!({ "model": "gpt-6" });
        let plan = apply(
            &mut payload,
            &url("https://api.openai.com/v1/chat/completions"),
            "gpt-6",
            &["instructions", "tools"],
            true,
        );
        assert_eq!(payload["prompt_cache_key"], json!(plan.key.unwrap()));
        assert_eq!(payload["prompt_cache_options"], plan.options.unwrap());
    }

    #[test]
    fn same_seed_same_key_different_seed_different_key() {
        let seed = ["instructions", "tools"];
        let first = digest(&seed);
        assert_eq!(first, digest(&seed));
        assert_ne!(first, digest(&["instructions", "other tools"]));
        assert_eq!(first.len(), 32);
    }

    #[test]
    fn appended_round_keeps_the_whole_prefix_cacheable() {
        let previous = vec![message("system", "sys"), message("user", "do it")];
        let mut current = previous.clone();
        current.push(message("assistant", "working"));
        current.push(message("tool", "result"));
        assert_eq!(stable_prefix_len(&previous, &current), 2);
        assert!(appended_only(&previous, &current));
        assert!(cacheable_bytes(&previous, &current) > 0);
    }

    #[test]
    fn rewriting_an_old_message_is_visible_as_prefix_churn() {
        let previous = vec![
            message("system", "sys"),
            message("tool", "the original long output"),
            message("user", "do it"),
        ];
        let current = vec![
            message("system", "sys"),
            message("tool", "[retired]"),
            message("user", "do it"),
        ];
        assert_eq!(stable_prefix_len(&previous, &current), 1);
        assert!(!appended_only(&previous, &current));
        assert_eq!(
            cacheable_bytes(&previous, &current),
            previous[0].to_string().len()
        );
    }
}
