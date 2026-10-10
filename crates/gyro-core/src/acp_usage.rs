//! Provider-specific ACP token contracts. Context occupancy is never billed usage.
//! Primary contracts:
//! https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md
//! https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/acp/acpSession.ts
//! https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/acp/usage.ts
//! https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/acp/session.py
//!
//! Grok ACP PromptUsage uses inclusive input; its headless projector differs.
//!
//! Kimi's ACPSession.prompt and replay_history discard StatusUpdate. A Wire
//! transport replacement would also need parity for ACPKaos/client filesystem,
//! approvals, MCP configuration and session resume. The ACP handshake exposes no
//! authenticated Wire journal path or turn boundary; guessing private session
//! files is not a safe bridge. Preserve the existing ACP transport and report
//! UnsupportedRuntime until a reviewed bridge supplies that contract.
use crate::usage::{UsageCoverage, UsageReason, UsageScope, UsageTokens};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcpProvider {
    Grok,
    Gemini,
    OpenCode,
    Cursor,
    Kimi,
    Unknown,
}

impl AcpProvider {
    pub fn from_label(label: &str) -> Self {
        match label.to_ascii_lowercase().as_str() {
            "xai" | "x.ai" | "grok" => Self::Grok,
            "google" | "gemini" | "google gemini" => Self::Gemini,
            "opencode" => Self::OpenCode,
            "cursor" | "cursor-agent" => Self::Cursor,
            "kimi" | "kimi-cli" | "kimi-code" | "moonshot" | "moonshot ai" => Self::Kimi,
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum AcpUsageContract {
    GrokPrompt,
    GeminiQuota062,
    GeminiStandard,
    OpenCodeLastStep,
    CursorUnverified,
    KimiAcpUnavailable,
    Unknown,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRuntimeInfo {
    pub agent_name: Option<String>,
    pub agent_version: Option<String>,
    pub model_id: Option<String>,
    pub protocol_version: Option<u64>,
}

impl AcpRuntimeInfo {
    pub fn observe(&mut self, value: &Value) {
        let text = |pointer: &str| {
            value.pointer(pointer).and_then(Value::as_str).map(|text| {
                crate::security::redact_secrets(&text.chars().take(200).collect::<String>())
            })
        };
        self.agent_name = text("/agentInfo/name").or(self.agent_name.take());
        self.agent_version = text("/agentInfo/version")
            .or_else(|| text("/_meta/agentVersion"))
            .or(self.agent_version.take());
        // These are advertised/returned runtime values, never the requested model.
        self.model_id = text("/models/currentModelId")
            .or_else(|| text("/_meta/modelId"))
            .or(self.model_id.take());
        self.protocol_version = value
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .or(self.protocol_version);
    }
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpContextUsage {
    pub used: u64,
    pub size: u64,
}

pub fn context_usage(update: &Value) -> Option<AcpContextUsage> {
    (update.get("sessionUpdate")?.as_str()? == "usage_update").then_some(())?;
    let used = update.get("used")?.as_u64()?;
    let size = update.get("size")?.as_u64()?;
    (size > 0 && used <= size).then_some(AcpContextUsage { used, size })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpModelUsage {
    pub model: String,
    pub tokens: UsageTokens,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpUsageObservation {
    pub contract: AcpUsageContract,
    pub tokens: UsageTokens,
    pub runtime: AcpRuntimeInfo,
    pub usage_is_incomplete: bool,
    pub model_calls: Option<u64>,
    pub model_usage: Vec<AcpModelUsage>,
    /// A bounded, numeric-only observation; no prompt, output or error text.
    pub provenance: &'static str,
}

impl AcpUsageObservation {
    pub fn interrupted(&mut self) {
        if self.contract != AcpUsageContract::KimiAcpUnavailable {
            if self.tokens.effective_accounting().coverage == UsageCoverage::Unavailable {
                self.tokens = UsageTokens::unavailable(UsageReason::Interrupted);
            } else {
                self.tokens = self.tokens.partial(UsageReason::Interrupted);
            }
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PromptCounts {
    #[serde(alias = "input_tokens")]
    input_tokens: Option<u64>,
    #[serde(alias = "output_tokens")]
    output_tokens: Option<u64>,
    #[serde(alias = "total_tokens")]
    total_tokens: Option<u64>,
    #[serde(
        alias = "cached_read_tokens",
        alias = "cachedInputTokens",
        alias = "cacheReadTokens"
    )]
    cached_read_tokens: Option<u64>,
    #[serde(
        alias = "cached_write_tokens",
        alias = "cacheCreationTokens",
        alias = "cacheWriteTokens"
    )]
    cached_write_tokens: Option<u64>,
    #[serde(
        alias = "reasoningTokens",
        alias = "reasoning_tokens",
        alias = "reasoningOutputTokens"
    )]
    thought_tokens: Option<u64>,
    model_calls: Option<u64>,
    usage_is_incomplete: bool,
}

impl PromptCounts {
    fn tokens(&self, additive_cache: bool, additive_thoughts: bool) -> UsageTokens {
        let input = self.input_tokens.map(|input| {
            if additive_cache {
                input
                    .saturating_add(self.cached_read_tokens.unwrap_or_default())
                    .saturating_add(self.cached_write_tokens.unwrap_or_default())
            } else {
                input
            }
        });
        let output = self.output_tokens.map(|output| {
            if additive_thoughts {
                output.saturating_add(self.thought_tokens.unwrap_or_default())
            } else {
                output
            }
        });
        let overflow = (additive_cache
            && self.input_tokens.is_some_and(|n| {
                n.checked_add(self.cached_read_tokens.unwrap_or_default())
                    .and_then(|n| n.checked_add(self.cached_write_tokens.unwrap_or_default()))
                    .is_none()
            }))
            || (additive_thoughts
                && self.output_tokens.is_some_and(|n| {
                    n.checked_add(self.thought_tokens.unwrap_or_default())
                        .is_none()
                }));
        let inconsistent = overflow
            || input.zip(output).is_some_and(|(i, o)| {
                i.checked_add(o).is_none()
                    || self.total_tokens.is_some_and(|t| t != i.saturating_add(o))
            })
            || input.is_some_and(|i| {
                self.cached_read_tokens
                    .unwrap_or_default()
                    .checked_add(self.cached_write_tokens.unwrap_or_default())
                    .is_none_or(|cache| cache > i)
            })
            || output.is_some_and(|o| self.thought_tokens.is_some_and(|r| r > o));
        let mut tokens = UsageTokens::measured(
            input,
            self.cached_read_tokens,
            output,
            self.thought_tokens,
            self.total_tokens,
        )
        .with_cache_write(self.cached_write_tokens);
        if inconsistent {
            tokens = tokens.partial(UsageReason::InconsistentCounts);
        }
        if self.usage_is_incomplete {
            tokens = tokens.partial(UsageReason::ProviderIncomplete);
        }
        tokens
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct GeminiQuotaCounts {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}
#[derive(Clone, Debug, Deserialize)]
struct GeminiModelQuota {
    model: String,
    token_count: GeminiQuotaCounts,
}

fn object_at<'a>(value: &'a Value, pointers: &[&str]) -> Option<(&'a Value, usize)> {
    pointers.iter().enumerate().find_map(|(index, pointer)| {
        value
            .pointer(pointer)
            .filter(|value| value.is_object())
            .map(|value| (value, index))
    })
}

/// Compatibility extraction: null/malformed higher-priority siblings never
/// mask a valid usage object. Flat _meta.totalTokens is context, not billing.
pub fn prompt_usage_object(value: &Value) -> Option<Value> {
    object_at(
        value,
        &[
            "/_meta/usage",
            "/usage",
            "/promptUsage",
            "/error/data/promptUsage",
            "/data/promptUsage",
            "/_meta/quota/token_count",
        ],
    )
    .map(|(value, _)| value.clone())
}

pub fn normalize_prompt_usage(
    provider: AcpProvider,
    value: &Value,
    mut runtime: AcpRuntimeInfo,
) -> AcpUsageObservation {
    runtime.observe(value);
    let contract = match provider {
        AcpProvider::Grok => AcpUsageContract::GrokPrompt,
        AcpProvider::Gemini => AcpUsageContract::GeminiQuota062,
        AcpProvider::OpenCode => AcpUsageContract::OpenCodeLastStep,
        AcpProvider::Cursor => AcpUsageContract::CursorUnverified,
        AcpProvider::Kimi => AcpUsageContract::KimiAcpUnavailable,
        AcpProvider::Unknown => AcpUsageContract::Unknown,
    };
    let incomplete = [
        "/_meta/usageIsIncomplete",
        "/usageIsIncomplete",
        "/error/data/usageIsIncomplete",
        "/data/usageIsIncomplete",
    ]
    .iter()
    .any(|p| value.pointer(p).and_then(Value::as_bool) == Some(true));
    let model_calls = ["/_meta/modelCalls", "/modelCalls", "/error/data/modelCalls"]
        .iter()
        .find_map(|p| value.pointer(p).and_then(Value::as_u64));
    let mut observed = AcpUsageObservation {
        contract,
        tokens: UsageTokens::unavailable(if incomplete {
            UsageReason::ProviderIncomplete
        } else {
            UsageReason::MissingUsage
        }),
        runtime,
        usage_is_incomplete: incomplete,
        model_calls,
        model_usage: Vec::new(),
        provenance: "ACP prompt response",
    };
    if provider == AcpProvider::Kimi {
        observed.tokens = UsageTokens::unavailable(UsageReason::UnsupportedRuntime);
        observed.provenance = "Kimi ACP discards Wire StatusUpdate; no safe journal binding";
        return observed;
    }
    if provider == AcpProvider::Gemini {
        // Prefer the standard contract when supplied. Do not add the quota
        // mirror or its per-model rows to it.
        if let Some((usage, _)) = object_at(value, &["/usage"]) {
            observed.contract = AcpUsageContract::GeminiStandard;
            observed.provenance = "PromptResponse.usage (Gemini standard)";
            match serde_json::from_value::<PromptCounts>(usage.clone()) {
                Ok(counts) => {
                    observed.tokens = counts.tokens(false, true).with_scope(UsageScope::Turn);
                    if counts.thought_tokens.is_none() {
                        observed.tokens = observed.tokens.partial(UsageReason::ProviderIncomplete);
                    }
                    observed.usage_is_incomplete |= counts.usage_is_incomplete;
                    if observed.usage_is_incomplete {
                        observed.tokens = observed.tokens.partial(UsageReason::ProviderIncomplete);
                    }
                }
                Err(_) => {
                    observed.tokens = UsageTokens::unavailable(UsageReason::InconsistentCounts)
                }
            }
            return observed;
        }
        observed.provenance = "PromptResponse._meta.quota (Gemini v0.62 contract)";
        let quota = value.pointer("/_meta/quota");
        let rows = quota
            .and_then(|q| q.get("model_usage"))
            .and_then(Value::as_array);
        let mut bad_rows = rows.is_some_and(|rows| rows.len() > 128);
        if let Some(rows) = rows {
            for row in rows.iter().take(128) {
                match serde_json::from_value::<GeminiModelQuota>(row.clone()) {
                    Ok(row) => observed.model_usage.push(AcpModelUsage {
                        model: crate::security::redact_secrets(
                            &row.model.chars().take(200).collect::<String>(),
                        ),
                        tokens: UsageTokens::measured(
                            row.token_count.input_tokens,
                            None,
                            row.token_count.output_tokens,
                            None,
                            None,
                        )
                        .with_scope(UsageScope::Turn)
                        .partial(UsageReason::ProviderIncomplete),
                    }),
                    Err(_) => bad_rows = true,
                }
            }
        }
        if let Some(counts) = quota
            .and_then(|q| q.get("token_count"))
            .filter(|v| v.is_object())
        {
            observed.tokens = match serde_json::from_value::<GeminiQuotaCounts>(counts.clone()) {
                Ok(counts) => UsageTokens::measured(
                    counts.input_tokens,
                    None,
                    counts.output_tokens,
                    None,
                    None,
                )
                .with_scope(UsageScope::Turn)
                .partial(UsageReason::ProviderIncomplete),
                Err(_) => UsageTokens::unavailable(UsageReason::InconsistentCounts),
            };
        } else if let Some(tokens) = observed
            .model_usage
            .iter()
            .map(|row| row.tokens)
            .reduce(UsageTokens::combine)
        {
            observed.tokens = tokens;
        }
        // v0.62 drops cachedContentTokenCount and thoughtsTokenCount. Retain the
        // measured prompt/candidate counts as partial, never invent zero buckets.
        if bad_rows {
            observed.tokens = observed.tokens.partial(UsageReason::ProviderIncomplete);
        }
        return observed;
    }
    let pointers = if provider == AcpProvider::Grok {
        &[
            "/_meta/usage",
            "/usage",
            "/promptUsage",
            "/error/data/promptUsage",
            "/data/promptUsage",
        ][..]
    } else {
        &["/usage", "/promptUsage", "/error/data/promptUsage"][..]
    };
    if let Some((usage, index)) = object_at(value, pointers) {
        observed.provenance = match pointers[index] {
            "/_meta/usage" => "PromptResponse._meta.usage",
            "/error/data/promptUsage" | "/data/promptUsage" => "JSON-RPC error.data.promptUsage",
            "/promptUsage" => "PromptResponse.promptUsage",
            _ => "PromptResponse.usage",
        };
        match serde_json::from_value::<PromptCounts>(usage.clone()) {
            Ok(counts) => {
                observed.model_calls = counts.model_calls.or(observed.model_calls);
                observed.usage_is_incomplete |= counts.usage_is_incomplete;
                observed.tokens = counts
                    .tokens(
                        provider == AcpProvider::OpenCode,
                        provider == AcpProvider::OpenCode,
                    )
                    .with_scope(if provider == AcpProvider::OpenCode {
                        UsageScope::Request
                    } else {
                        UsageScope::Turn
                    });
                if observed.usage_is_incomplete {
                    observed.tokens = observed.tokens.partial(UsageReason::ProviderIncomplete);
                }
                if provider == AcpProvider::OpenCode {
                    // buildUsage(latestAssistantMessage): a single final step.
                    // Notifications supply context occupancy, not earlier spend.
                    observed.tokens = observed.tokens.partial(UsageReason::ProviderIncomplete);
                }
                if matches!(provider, AcpProvider::Cursor | AcpProvider::Unknown) {
                    // Unknown ACP scope cannot establish even a turn lower bound.
                    observed.tokens = UsageTokens::unavailable(UsageReason::UnverifiedRuntime);
                }
            }
            Err(_) => observed.tokens = UsageTokens::unavailable(UsageReason::InconsistentCounts),
        }
    } else if matches!(provider, AcpProvider::Cursor | AcpProvider::Unknown) {
        observed.tokens = UsageTokens::unavailable(UsageReason::UnverifiedRuntime);
    }
    observed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn read(provider: AcpProvider, value: Value) -> AcpUsageObservation {
        normalize_prompt_usage(provider, &value, AcpRuntimeInfo::default())
    }
    #[test]
    fn gemini_outer_incomplete_flag_demotes_the_standard_receipt() {
        let observed = read(AcpProvider::Gemini, json!({
            "usageIsIncomplete": true,
            "usage": {"inputTokens": 100, "outputTokens": 20, "thoughtTokens": 0, "totalTokens": 120}
        }));
        assert_eq!(observed.tokens.total_tokens, 120);
        assert!(observed.usage_is_incomplete);
        assert_eq!(observed.tokens.effective_accounting().coverage, UsageCoverage::Partial);
        assert!(!observed.tokens.measured);
    }
    #[test]
    fn grok_nested_prompt_is_inclusive_and_retains_incomplete_calls() {
        let observed = read(
            AcpProvider::Grok,
            json!({"_meta":{"totalTokens":99999,
            "usage":{"inputTokens":100,"cachedReadTokens":60,"cachedWriteTokens":10,
                "outputTokens":25,"thoughtTokens":5,"totalTokens":125,"modelCalls":3},
            "usageIsIncomplete":true}}),
        );
        assert_eq!(
            (
                observed.tokens.input_tokens,
                observed.tokens.output_tokens,
                observed.tokens.total_tokens
            ),
            (100, 25, 125)
        );
        assert_eq!(observed.tokens.cache_write_tokens, 10);
        assert_eq!(observed.model_calls, Some(3));
        assert!(observed.usage_is_incomplete);
        assert_eq!(
            observed.tokens.effective_accounting().coverage,
            UsageCoverage::Partial
        );
    }
    #[test]
    fn null_usage_does_not_hide_prompt_usage_or_error_spend() {
        let v =
            json!({"usage":null,"promptUsage":{"inputTokens":0,"outputTokens":0,"totalTokens":0}});
        assert_eq!(prompt_usage_object(&v).unwrap()["inputTokens"], 0);
        let zero = read(AcpProvider::Grok, v);
        assert_eq!(
            zero.tokens.effective_accounting().coverage,
            UsageCoverage::Complete
        );
        let error = read(
            AcpProvider::Grok,
            json!({"error":{"data":{"promptUsage":{
            "inputTokens":100,"outputTokens":25,"totalTokens":125,"modelCalls":2}}}}),
        );
        assert_eq!(error.tokens.total_tokens, 125);
        assert_eq!(error.model_calls, Some(2));
    }
    #[test]
    fn context_update_cannot_become_spend() {
        let update = json!({"sessionUpdate":"usage_update","used":50000,"size":100000});
        assert_eq!(
            context_usage(&update),
            Some(AcpContextUsage {
                used: 50000,
                size: 100000
            })
        );
        let observed = read(AcpProvider::Grok, json!({"_meta":{"totalTokens":50000}}));
        assert_eq!(observed.tokens.total_tokens, 0);
        assert_eq!(
            observed.tokens.effective_accounting().coverage,
            UsageCoverage::Unavailable
        );
    }
    #[test]
    fn opencode_adds_cache_and_thoughts_once_and_is_only_last_step() {
        let observed = read(
            AcpProvider::OpenCode,
            json!({"usage":{
            "inputTokens":100,"outputTokens":20,"cachedReadTokens":60,"cachedWriteTokens":10,
            "thoughtTokens":5,"totalTokens":195}}),
        );
        assert_eq!(
            (
                observed.tokens.input_tokens,
                observed.tokens.output_tokens,
                observed.tokens.total_tokens
            ),
            (170, 25, 195)
        );
        let a = observed.tokens.effective_accounting();
        assert_eq!(a.scope, UsageScope::Request);
        assert_eq!(a.coverage, UsageCoverage::Partial);
        assert_eq!(observed.tokens.cache_write_tokens, 10);
    }
    #[test]
    fn gemini_quota_and_models_are_alternatives_not_additive() {
        let observed = read(
            AcpProvider::Gemini,
            json!({"usage":null,"_meta":{"quota":{
            "token_count":{"input_tokens":100,"output_tokens":20},
            "model_usage":[{"model":"gemini-a","token_count":{"input_tokens":60,"output_tokens":10}},
                {"model":"gemini-b","token_count":{"input_tokens":40,"output_tokens":10}}]}}}),
        );
        assert_eq!(observed.tokens.total_tokens, 120);
        assert_eq!(observed.model_usage.len(), 2);
        assert_eq!(observed.contract, AcpUsageContract::GeminiQuota062);
        let a = observed.tokens.effective_accounting();
        assert_eq!(a.coverage, UsageCoverage::Partial);
        assert!(!a.known.reasoning && !a.known.cache_read);
        let rows = read(
            AcpProvider::Gemini,
            json!({"_meta":{"quota":{"model_usage":[{
            "model":"gemini-a","token_count":{"input_tokens":100,"output_tokens":20}}]}}}),
        );
        assert_eq!(rows.tokens.total_tokens, 120);
    }
    #[test]
    fn gemini_standard_normalizes_separate_thoughts_and_ignores_quota_mirror() {
        let observed = read(
            AcpProvider::Gemini,
            json!({"usage":{"inputTokens":100,
            "outputTokens":20,"thoughtTokens":5,"cachedReadTokens":60,"totalTokens":125},
            "_meta":{"quota":{"token_count":{"input_tokens":100,"output_tokens":20}}}}),
        );
        assert_eq!(observed.contract, AcpUsageContract::GeminiStandard);
        assert_eq!(observed.tokens.output_tokens, 25);
        assert_eq!(observed.tokens.input_tokens, 100);
        assert_eq!(observed.tokens.total_tokens, 125);
        assert_eq!(
            observed.tokens.effective_accounting().coverage,
            UsageCoverage::Complete
        );
    }
    #[test]
    fn unknown_cursor_and_kimi_never_claim_complete() {
        let cursor = read(
            AcpProvider::Cursor,
            json!({"usage":{"inputTokens":100,"outputTokens":20}}),
        );
        assert_eq!(
            cursor.tokens.effective_accounting().reason,
            Some(UsageReason::UnverifiedRuntime)
        );
        let kimi = read(
            AcpProvider::Kimi,
            json!({"usage":{"inputTokens":100,"outputTokens":20}}),
        );
        assert_eq!(
            kimi.tokens.effective_accounting().coverage,
            UsageCoverage::Unavailable
        );
        assert_eq!(
            kimi.tokens.effective_accounting().reason,
            Some(UsageReason::UnsupportedRuntime)
        );
    }
    #[test]
    fn contradictory_or_malformed_counts_are_not_complete() {
        for usage in [
            json!({"inputTokens":100,"outputTokens":20,"totalTokens":1}),
            json!({"inputTokens":100,"outputTokens":20,"cachedReadTokens":200}),
            json!({"inputTokens":100,"outputTokens":20,"thoughtTokens":40}),
            json!({"inputTokens":-1,"outputTokens":20}),
        ] {
            let observed = read(AcpProvider::Grok, json!({"usage":usage}));
            assert_ne!(
                observed.tokens.effective_accounting().coverage,
                UsageCoverage::Complete
            );
            assert_eq!(
                observed.tokens.effective_accounting().reason,
                Some(UsageReason::InconsistentCounts)
            );
        }
    }
    #[test]
    fn incomplete_without_usage_is_unavailable_and_preserves_flags() {
        let observed = read(
            AcpProvider::Grok,
            json!({"_meta":{
            "usage":null,"usageIsIncomplete":true,"modelCalls":2,"totalTokens":99999}}),
        );
        assert!(observed.usage_is_incomplete);
        assert_eq!(observed.model_calls, Some(2));
        assert_eq!(observed.tokens.total_tokens, 0);
        assert_eq!(
            observed.tokens.effective_accounting().coverage,
            UsageCoverage::Unavailable
        );
        assert_eq!(
            observed.tokens.effective_accounting().reason,
            Some(UsageReason::ProviderIncomplete)
        );
    }
    #[test]
    fn runtime_info_uses_observed_values_only() {
        let observed = read(
            AcpProvider::Grok,
            json!({"_meta":{"agentVersion":"1.2.3","modelId":"grok-runtime"}}),
        );
        assert_eq!(observed.runtime.agent_version.as_deref(), Some("1.2.3"));
        assert_eq!(observed.runtime.model_id.as_deref(), Some("grok-runtime"));
    }
}
