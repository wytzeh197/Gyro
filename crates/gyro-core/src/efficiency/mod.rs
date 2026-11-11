//! Local efficiency policies. Accounting never implies provider billing or verified success.
pub mod accounting;
mod arguments;
pub mod cache;
pub mod cache_plan;
pub mod checkpoint;
pub mod compaction;
pub mod context;
pub mod evidence;
pub mod prefix_retention;
pub mod pricing;
pub mod progress;
pub mod retrieval;
pub mod routing;
pub mod spill;
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
    /// Experimental catalog routing for request-owned tool loops only.
    pub compact_tool_catalog: bool,
    pub recoverable_evidence: bool,
    /// Retired results keep identity and a spill address, without a preview.
    /// Off is not written: `deny_unknown_fields` makes an older build reject the key.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub tight_evidence: bool,
    /// Stronger instruction to request known read-only lookups in one response.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub batch_reads: bool,
    /// Serve CLI providers the short tool list, with the rest reached by discovery.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub compact_cli_catalog: bool,
    pub retain_tool_catalog: bool,
    /// Rollback for internal summary and title calls: on restores the full chat
    /// prompt and history they received before isolation.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub full_context_internal_requests: bool,
    /// Inline window, in bytes, for fresh workspace reads before they spill.
    /// Zero selects the 8KiB default; explicit values clamp to 4-16KiB.
    /// Command output still uses the smaller universal preview.
    #[serde(skip_serializing_if = "is_zero")]
    pub fresh_read_inline_bytes: u32,
    /// Repeated-work detection on its own, without `experimental` and the
    /// task-state and retrieval policies that gate brings with it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub repeated_work_detection: bool,
    /// Keep owned API message prefixes stable between bounded retirement checkpoints.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stable_api_prefix: bool,
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
            compact_tool_catalog: false,
            recoverable_evidence: false,
            tight_evidence: false,
            batch_reads: false,
            compact_cli_catalog: false,
            retain_tool_catalog: false,
            full_context_internal_requests: false,
            fresh_read_inline_bytes: 0,
            repeated_work_detection: false,
            stable_api_prefix: false,
            task_state: true,
            repository_retrieval: true,
            progress_detection: true,
            routing: routing::Policy::default(),
        }
    }
}
fn is_zero(value: &u32) -> bool {
    *value == 0
}
/// Capabilities whose result is code or text the model asked to see now.
const FRESH_READ_CAPABILITIES: &[&str] = &[
    "workspace.read",
    "workspace.read_range",
    "workspace.read_editor",
];
impl Config {
    pub fn policies(&self) -> bool {
        self.enabled && self.experimental
    }
    /// Whether the repeated-work detector observes tool results.
    pub fn progress_active(&self) -> bool {
        self.enabled
            && (self.repeated_work_detection || (self.experimental && self.progress_detection))
    }
    /// The widened inline window for this capability's fresh result, if any.
    /// Independent of `experimental`, so it can be measured on its own.
    pub fn fresh_read_window(&self, capability: &str) -> Option<usize> {
        (self.enabled && FRESH_READ_CAPABILITIES.contains(&capability)).then_some(
            if self.fresh_read_inline_bytes == 0 {
                8 * 1024
            } else {
                self.fresh_read_inline_bytes as usize
            },
        )
    }
    /// Tight wins over recoverable because it also spills the complete JSON.
    pub fn evidence_policy(&self) -> context::EvidencePolicy {
        if !self.policies() {
            context::EvidencePolicy::Preview
        } else if self.tight_evidence {
            context::EvidencePolicy::Tight
        } else if self.recoverable_evidence {
            context::EvidencePolicy::Recoverable
        } else {
            context::EvidencePolicy::Preview
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_preserve_selection() {
        assert!(!Config::default().policies());
        assert!(!Config::default().compact_tool_catalog);
        assert!(!Config::default().recoverable_evidence);
        assert!(!Config::default().retain_tool_catalog);
        assert!(!Config::default().tight_evidence);
        assert!(!Config::default().batch_reads);
        assert!(!Config::default().compact_cli_catalog);
        let legacy: Config = serde_json::from_str("{}").unwrap();
        assert!(!legacy.recoverable_evidence && !legacy.retain_tool_catalog);
        assert!(!legacy.tight_evidence && !legacy.batch_reads);
        assert!(!legacy.compact_cli_catalog);
        assert!(
            !serde_json::from_str::<Config>("{}")
                .unwrap()
                .compact_tool_catalog
        );
        assert_eq!(
            Profile::Deep.effort(Some("max"), &["low", "high"]),
            Some("max")
        );
        assert_eq!(Profile::Deep.effort(None, &["low"]), None);
    }
    #[test]
    fn switches_that_are_off_stay_out_of_saved_config() {
        // An installed older build shares this config and rejects unknown keys.
        let saved = serde_json::to_value(Config::default()).unwrap();
        for key in [
            "tightEvidence",
            "batchReads",
            "compactCliCatalog",
            "fullContextInternalRequests",
            "freshReadInlineBytes",
            "repeatedWorkDetection",
            "stableApiPrefix",
        ] {
            assert!(saved.get(key).is_none(), "{key} was written");
        }
        assert_eq!(
            serde_json::from_value::<Config>(saved).unwrap(),
            Config::default()
        );
        let on = Config {
            compact_cli_catalog: true,
            ..Config::default()
        };
        let saved = serde_json::to_value(&on).unwrap();
        assert_eq!(saved["compactCliCatalog"], true);
        assert_eq!(serde_json::from_value::<Config>(saved).unwrap(), on);
    }
    #[test]
    fn standalone_switches_do_not_need_or_enable_experiments() {
        let base = Config::default();
        assert!(!base.progress_active(), "defaults keep detection off");
        let detection = Config {
            repeated_work_detection: true,
            ..Config::default()
        };
        assert!(detection.progress_active() && !detection.policies());
        let experimental = Config {
            experimental: true,
            ..Config::default()
        };
        assert!(
            experimental.progress_active(),
            "existing experimental behavior is kept"
        );
        let off = Config {
            enabled: false,
            repeated_work_detection: true,
            fresh_read_inline_bytes: 8192,
            ..Config::default()
        };
        assert!(!off.progress_active());
        assert_eq!(off.fresh_read_window("workspace.read"), None);
        let reads = Config {
            fresh_read_inline_bytes: 8192,
            ..Config::default()
        };
        assert_eq!(reads.fresh_read_window("workspace.read"), Some(8192));
        assert!(!reads.policies());
        let saved = serde_json::to_value(&reads).unwrap();
        assert_eq!(saved["freshReadInlineBytes"], 8192);
        assert_eq!(serde_json::from_value::<Config>(saved).unwrap(), reads);
    }
    #[test]
    fn default_read_window_is_bounded_and_preserves_config_compatibility() {
        for config in [
            Config::default(),
            serde_json::from_str::<Config>("{}").unwrap(),
        ] {
            for capability in FRESH_READ_CAPABILITIES {
                assert_eq!(config.fresh_read_window(capability), Some(8192));
            }
            for capability in ["terminal.read", "workspace.search", "workspace.edit"] {
                assert_eq!(config.fresh_read_window(capability), None);
            }
            assert!(!config.policies());
            assert!(serde_json::to_value(config)
                .unwrap()
                .get("freshReadInlineBytes")
                .is_none());
        }
        let explicit: Config = serde_json::from_str(r#"{"freshReadInlineBytes":4096}"#).unwrap();
        assert_eq!(explicit.fresh_read_window("workspace.read"), Some(4096));
        let disabled = Config {
            enabled: false,
            ..Config::default()
        };
        assert_eq!(disabled.fresh_read_window("workspace.read"), None);
    }

    #[test]
    fn evidence_policy_needs_experiments_and_tight_wins() {
        use context::EvidencePolicy as P;
        let mut config = Config {
            tight_evidence: true,
            recoverable_evidence: true,
            ..Config::default()
        };
        assert_eq!(config.evidence_policy(), P::Preview);
        config.experimental = true;
        assert_eq!(config.evidence_policy(), P::Tight);
        config.tight_evidence = false;
        assert_eq!(config.evidence_policy(), P::Recoverable);
        config.recoverable_evidence = false;
        assert_eq!(config.evidence_policy(), P::Preview);
    }
    #[test]
    fn custom_support_is_unknown() {
        let c = controls("custom:test");
        assert!(c.owns_requests);
        assert_eq!(c.cache_controls, Support::Unknown);
        assert!(controls("openai").hidden_context);
    }
}
