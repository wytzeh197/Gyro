//! Local efficiency policies. Accounting never implies provider billing or verified success.
pub mod accounting;
pub mod cache;
pub mod checkpoint;
pub mod context;
pub mod evidence;
pub mod pricing;
pub mod progress;
pub mod retrieval;
pub mod routing;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Support {
    Supported,
    Unsupported,
    #[default]
    Unknown,
}
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Controls {
    pub owns_requests: bool,
    pub native_continuation: Support,
    pub effort: Support,
    pub cache_controls: Support,
    pub usage: Support,
    pub hidden_context: bool,
}
pub fn controls(provider: &str) -> Controls {
    use crate::provider_registry::{
        is_custom_provider_id, provider_descriptor, ProviderExecutionKind as K,
    };
    if is_custom_provider_id(provider) {
        return Controls {
            owns_requests: true,
            ..Default::default()
        };
    }
    let Some(p) = provider_descriptor(provider) else {
        return Controls::default();
    };
    let direct = matches!(p.execution_kind, K::OllamaApi | K::OpenAiCompatibleApi);
    Controls {
        owns_requests: direct,
        native_continuation: if direct {
            Support::Unsupported
        } else if p.supports_resume {
            Support::Supported
        } else {
            Support::Unsupported
        },
        effort: if matches!(provider, "openai" | "anthropic" | "deepseek") {
            Support::Supported
        } else {
            Support::Unknown
        },
        cache_controls: if direct {
            Support::Unknown
        } else {
            Support::Unsupported
        },
        usage: if p.supports_usage
            || matches!(p.execution_kind, K::OllamaApi | K::OpenAiCompatibleApi)
        {
            Support::Supported
        } else {
            Support::Unknown
        },
        hidden_context: !direct,
    }
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Profile {
    Routine,
    #[default]
    Standard,
    Deep,
}
impl Profile {
    /// An explicit model/effort choice always wins. Unsupported profiles never guess flags.
    pub fn effort<'a>(self, explicit: Option<&'a str>, supported: &[&'a str]) -> Option<&'a str> {
        if explicit.is_some() {
            return explicit;
        }
        let desired = match self {
            Self::Routine => "low",
            Self::Standard => return None,
            Self::Deep => "high",
        };
        supported.iter().copied().find(|e| *e == desired)
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    /// Policies stay experimental until paired live evaluation passes the quality gate.
    pub experimental: bool,
    pub profile: Profile,
    pub parallel_agents: bool,
    pub prices: Vec<pricing::PriceSnapshot>,
    pub structured_evidence: bool,
    pub cache_assembly: bool,
    pub task_state: bool,
    pub repository_retrieval: bool,
    pub progress_detection: bool,
    pub routing: routing::Policy,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: true,
            experimental: false,
            profile: Profile::Standard,
            parallel_agents: false,
            prices: Vec::new(),
            structured_evidence: true,
            cache_assembly: true,
            task_state: true,
            repository_retrieval: true,
            progress_detection: true,
            routing: routing::Policy::default(),
        }
    }
}
impl Config {
    pub fn policies(&self) -> bool {
        self.enabled && self.experimental
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_preserve_selection() {
        assert!(!Config::default().policies());
        assert_eq!(
            Profile::Deep.effort(Some("max"), &["low", "high"]),
            Some("max")
        );
        assert_eq!(Profile::Deep.effort(None, &["low"]), None);
    }
    #[test]
    fn custom_support_is_unknown() {
        let c = controls("custom:test");
        assert!(c.owns_requests);
        assert_eq!(c.cache_controls, Support::Unknown);
        assert!(controls("openai").hidden_context);
    }
}
