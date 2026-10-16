//! Provider-specific ACP token contracts. Context occupancy is never billed usage.
//! Primary contracts:
//! https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md
//! https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/acp/acpSession.ts
//! https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/acp/usage.ts
//! https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/acp/session.py
//!
//! Grok ACP PromptUsage uses inclusive input; its headless projector differs.
//!
//! Legacy Kimi's ACPSession.prompt and replay_history discard StatusUpdate. A Wire
//! transport replacement would also need parity for ACPKaos/client filesystem,
//! approvals, MCP configuration and session resume. The ACP handshake exposes no
//! authenticated Wire journal path or turn boundary; guessing private session
//! files is not a safe bridge. Legacy runtimes remain UnsupportedRuntime.
//! The separately pinned Kimi Code local /usage contract below preserves ACP
//! and obtains main-agent consumption without a Wire transport replacement.
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
    KimiCode037SessionDelta,
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

/// Kimi Code is a different runtime from the archived Python kimi-cli. The
/// pinned 0.37.2 ACP implementation executes /usage locally, without launching
/// a model turn, and reports inclusive main-agent session totals. Keep this
/// contract narrow: neither arbitrary versions nor the legacy adapter qualify.
/// https://github.com/MoonshotAI/kimi-code/blob/c41fadf0f78b35ecaf3d613ca26580a9a093de80/packages/acp-server/src/builtin-commands.ts
pub(crate) fn kimi_code_037_usage_supported(runtime: &AcpRuntimeInfo) -> bool {
    runtime.agent_name.as_deref() == Some("Kimi Code CLI")
        && runtime.agent_version.as_deref() == Some("0.37.2")
        && runtime.protocol_version == Some(1)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct KimiCodeUsageSnapshot {
    input: u64,
    output: u64,
    recorded: bool,
    /// `Context: USED / SIZE tokens` when the report names both. Billing stays
    /// on the session-total line; this is occupancy only.
    pub(crate) context: Option<AcpContextUsage>,
}

/// `Context: 99999 / 200000 tokens (50%)`. A line that only says
/// `Context: 0 tokens` has no window, so it stays `None`.
fn kimi_context_occupancy(line: &str) -> Option<AcpContextUsage> {
    let rest = line.strip_prefix("Context: ")?.trim();
    let (used, rest) = rest.split_once(" / ")?;
    let (size, rest) = rest.split_once(" tokens")?;
    if !(rest.is_empty() || rest.starts_with(' ') || rest.starts_with('(')) {
        return None;
    }
    let used = exact_token_count(used)?;
    let size = exact_token_count(size)?;
    (size > 0 && used <= size).then_some(AcpContextUsage {
        used,
        size,
        estimated: false,
    })
}

fn exact_token_count(text: &str) -> Option<u64> {
    // The runtime uses JavaScript numbers; larger values cannot establish
    // exact integer counts even though Rust can represent them.
    (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| text.parse::<u64>().ok())
        .flatten()
        .filter(|count| *count <= 9_007_199_254_740_991)
}

pub(crate) fn parse_kimi_code_037_usage_report(text: &str) -> Option<KimiCodeUsageSnapshot> {
    let mut lines = text.lines();
    let context_line = lines.next()?;
    let context = kimi_context_occupancy(context_line);
    context_line.strip_prefix("Context: ")?;
    let total = lines.next()?.strip_prefix("Session total: ")?;
    if lines.next().is_some() {
        return None;
    }
    if total == "no LLM calls yet" {
        return Some(KimiCodeUsageSnapshot {
            input: 0,
            output: 0,
            recorded: false,
            context,
        });
    }
    let (input, output) = total.split_once(" input, ")?;
    Some(KimiCodeUsageSnapshot {
        input: exact_token_count(input)?,
        output: exact_token_count(output.strip_suffix(" output")?)?,
        recorded: true,
        context,
    })
}

pub(crate) fn kimi_code_037_usage_delta(
    before: KimiCodeUsageSnapshot,
    after: KimiCodeUsageSnapshot,
    runtime: AcpRuntimeInfo,
) -> AcpUsageObservation {
    let tokens = if !after.recorded {
        UsageTokens::unavailable(UsageReason::MissingUsage)
    } else if let Some((input, output)) = after
        .input
        .checked_sub(before.input)
        .zip(after.output.checked_sub(before.output))
    {
        // Native child agents own separate counters. This is a real lower
        // bound for the chat's main agent, not a complete task receipt.
        UsageTokens::measured(Some(input), None, Some(output), None, None)
            .with_scope(UsageScope::Turn)
            .partial(UsageReason::ProviderIncomplete)
    } else {
        UsageTokens::unavailable(UsageReason::InconsistentCounts)
    };
    AcpUsageObservation {
        contract: AcpUsageContract::KimiCode037SessionDelta,
        tokens,
        runtime,
        usage_is_incomplete: true,
        model_calls: None,
        model_usage: Vec::new(),
        provenance: "Kimi Code 0.37.2 ACP /usage session-total delta (main agent)",
    }
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpContextUsage {
    pub used: u64,
    pub size: u64,
    /// `used` is a lower bound counted from traffic Gyro saw, not a provider
    /// measurement. A later wire reading clears it.
    #[serde(default, skip_serializing_if = "skip_false")]
    pub estimated: bool,
}

fn skip_false(value: &bool) -> bool {
    !*value
}

pub fn context_usage(update: &Value) -> Option<AcpContextUsage> {
    (update.get("sessionUpdate")?.as_str()? == "usage_update").then_some(())?;
    let used = update.get("used")?.as_u64()?;
    let size = update.get("size")?.as_u64()?;
    (size > 0 && used <= size).then_some(AcpContextUsage {
        used,
        size,
        estimated: false,
    })
}

/// Occupancy from a live session update.
///
/// Standard `usage_update` is one shape. Grok also sends the window the
/// status line draws (`session_status`: `context_tokens` is the conversation,
/// input only) and one frame per model response. `input_tokens` on those
/// frames is the uncached portion, so cache read and cache creation are added
/// back. A turn total (`turn_completed`, `turn_usage`, session counters) is
/// the bill across every call and is not occupancy.
///
/// `size` is `0` when that frame does not name a window. Callers keep the
/// window an earlier frame already established.
pub fn live_context_usage(update: &Value) -> Option<AcpContextUsage> {
    if let Some(context) = context_usage(update) {
        return Some(context);
    }
    let kind = update.get("sessionUpdate").and_then(Value::as_str)?;
    let context = match kind {
        "session_status" => {
            let window = update.get("context_window")?;
            let used = window.get("context_tokens")?.as_u64()?;
            let size = window
                .get("context_window_size")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            AcpContextUsage {
                used,
                size,
                estimated: false,
            }
        }
        "response_started" => AcpContextUsage {
            used: grok_response_prompt_tokens(update)?,
            size: 0,
            estimated: false,
        },
        "response_completed" => AcpContextUsage {
            used: grok_response_prompt_tokens(update.get("usage")?)?,
            size: 0,
            estimated: false,
        },
        "auto_compact_started" => {
            let used = update.get("tokens_used")?.as_u64()?;
            let size = update.get("context_window")?.as_u64()?;
            AcpContextUsage {
                used,
                size,
                estimated: false,
            }
        }
        "auto_compact_completed" => AcpContextUsage {
            used: update.get("tokens_after")?.as_u64()?,
            size: 0,
            estimated: false,
        },
        _ => return None,
    };
    // A zero-seeded response frame is a placeholder, not an empty conversation.
    if matches!(kind, "response_started" | "response_completed") && context.used == 0 {
        return None;
    }
    (context.size == 0 || context.used <= context.size).then_some(context)
}

/// Full prompt of one Grok response. `input_tokens` is uncached only.
fn grok_response_prompt_tokens(usage: &Value) -> Option<u64> {
    let input = usage.get("input_tokens").and_then(Value::as_u64);
    let read = usage.get("cache_read_input_tokens").and_then(Value::as_u64);
    let created = usage
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64);
    if input.is_none() && read.is_none() && created.is_none() {
        return None;
    }
    Some(
        input
            .unwrap_or(0)
            .saturating_add(read.unwrap_or(0))
            .saturating_add(created.unwrap_or(0)),
    )
}

/// Last-call occupancy carried beside a Grok prompt bill.
///
/// Flat `_meta.totalTokens` is the last model call, not the turn sum in
/// `_meta.usage`. When several calls were billed, a flat total at least as
/// large as that sum is the bill and is rejected.
pub fn grok_prompt_context(result: &Value) -> Option<AcpContextUsage> {
    let meta = result.get("_meta")?;
    let used = meta.get("totalTokens").and_then(Value::as_u64)?;
    if let Some(usage) = meta.get("usage").filter(|usage| usage.is_object()) {
        let calls = usage.get("modelCalls").and_then(Value::as_u64);
        let turn_input = usage.get("inputTokens").and_then(Value::as_u64);
        if calls.is_some_and(|calls| calls > 1) && turn_input.is_some_and(|input| used >= input) {
            return None;
        }
    }
    Some(AcpContextUsage {
        used,
        size: 0,
        estimated: false,
    })
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
    fn kimi_code_runtime() -> AcpRuntimeInfo {
        AcpRuntimeInfo {
            agent_name: Some("Kimi Code CLI".into()),
            agent_version: Some("0.37.2".into()),
            protocol_version: Some(1),
            ..Default::default()
        }
    }
    #[test]
    fn kimi_code_usage_is_bound_to_the_reviewed_runtime_and_exact_report_shape() {
        assert!(kimi_code_037_usage_supported(&kimi_code_runtime()));
        for runtime in [
            AcpRuntimeInfo {
                agent_version: Some("0.37.3".into()),
                ..kimi_code_runtime()
            },
            AcpRuntimeInfo {
                agent_name: Some("kimi-cli".into()),
                ..kimi_code_runtime()
            },
            AcpRuntimeInfo {
                protocol_version: None,
                ..kimi_code_runtime()
            },
        ] {
            assert!(!kimi_code_037_usage_supported(&runtime));
        }
        for text in [
            "Session total: 1 input, 2 output",
            "Context: 10 tokens\nSession total: -1 input, 2 output",
            "Context: 10 tokens\nSession total: 9007199254740992 input, 2 output",
            "Context: 10 tokens\nSession total: 1 input, 2 output\nSession total: 5 input, 6 output",
            "Session usage:\n- Total: input 1, output 2, cache read 0, cache creation 0",
        ] { assert!(parse_kimi_code_037_usage_report(text).is_none()); }
    }
    #[test]
    fn kimi_code_session_delta_keeps_inclusive_multi_request_counts_and_zeroes() {
        let report = |input, output| {
            parse_kimi_code_037_usage_report(&format!(
            "Context: 99999 / 200000 tokens (50%)\nSession total: {input} input, {output} output"))
            .unwrap()
        };
        let observed =
            kimi_code_037_usage_delta(report(1000, 100), report(1470, 145), kimi_code_runtime());
        assert_eq!(
            (
                observed.tokens.input_tokens,
                observed.tokens.output_tokens,
                observed.tokens.total_tokens
            ),
            (470, 45, 515)
        );
        assert_eq!(
            observed.tokens.effective_accounting().source,
            crate::usage::UsageSource::Provider
        );
        assert_eq!(
            observed.tokens.effective_accounting().coverage,
            UsageCoverage::Partial
        );
        // The default report includes input caches exactly once in input, but
        // does not expose a numeric cache breakdown or native child sessions.
        assert!(!observed.tokens.effective_accounting().known.cache_read);
        assert!(!observed.tokens.effective_accounting().known.cache_write);
        let fresh =
            parse_kimi_code_037_usage_report("Context: 0 tokens\nSession total: no LLM calls yet")
                .unwrap();
        let zero = kimi_code_037_usage_delta(fresh, report(0, 0), kimi_code_runtime()).tokens;
        assert_eq!(zero.total_tokens, 0);
        assert!(
            zero.effective_accounting().known.input && zero.effective_accounting().known.output
        );
        assert_eq!(zero.effective_accounting().coverage, UsageCoverage::Partial);
        assert_eq!(
            kimi_code_037_usage_delta(report(100, 20), report(99, 30), kimi_code_runtime())
                .tokens
                .effective_accounting()
                .reason,
            Some(UsageReason::InconsistentCounts)
        );
        assert_eq!(
            kimi_code_037_usage_delta(fresh, fresh, kimi_code_runtime())
                .tokens
                .effective_accounting()
                .coverage,
            UsageCoverage::Unavailable
        );
    }
    #[test]
    fn gemini_outer_incomplete_flag_demotes_the_standard_receipt() {
        let observed = read(
            AcpProvider::Gemini,
            json!({
                "usageIsIncomplete": true,
                "usage": {"inputTokens": 100, "outputTokens": 20, "thoughtTokens": 0, "totalTokens": 120}
            }),
        );
        assert_eq!(observed.tokens.total_tokens, 120);
        assert!(observed.usage_is_incomplete);
        assert_eq!(
            observed.tokens.effective_accounting().coverage,
            UsageCoverage::Partial
        );
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
                size: 100000,
                estimated: false,
            })
        );
        let observed = read(AcpProvider::Grok, json!({"_meta":{"totalTokens":50000}}));
        assert_eq!(observed.tokens.total_tokens, 0);
        assert_eq!(
            observed.tokens.effective_accounting().coverage,
            UsageCoverage::Unavailable
        );
        // The same field is last-call occupancy. It must not be billed.
        assert_eq!(
            grok_prompt_context(&json!({"_meta":{"totalTokens":50000}})),
            Some(AcpContextUsage {
                used: 50000,
                size: 0,
                estimated: false,
            })
        );
    }
    #[test]
    fn live_context_usage_reads_occupancy_and_ignores_turn_bills() {
        let status = json!({
            "sessionUpdate": "session_status",
            "context_window": {"context_tokens": 33022, "context_window_size": 256000},
            "session_input_tokens": 900000,
            "session_output_tokens": 4000
        });
        assert_eq!(
            live_context_usage(&status),
            Some(AcpContextUsage {
                used: 33022,
                size: 256000,
                estimated: false,
            })
        );
        assert_eq!(
            live_context_usage(&json!({
                "sessionUpdate": "response_started",
                "input_tokens": 800,
                "cache_read_input_tokens": 20000,
                "cache_creation_input_tokens": 0
            })),
            Some(AcpContextUsage {
                used: 20800,
                size: 0,
                estimated: false,
            })
        );
        assert_eq!(
            live_context_usage(&json!({
                "sessionUpdate": "response_completed",
                "usage": {
                    "input_tokens": 1000,
                    "output_tokens": 50,
                    "cache_read_input_tokens": 20000,
                    "cache_creation_input_tokens": 500,
                    "reasoning_tokens": 10
                }
            })),
            Some(AcpContextUsage {
                used: 21500,
                size: 0,
                estimated: false,
            })
        );
        assert_eq!(
            live_context_usage(&json!({
                "sessionUpdate": "response_completed",
                "usage": {"input_tokens": 0, "cache_read_input_tokens": 0}
            })),
            None
        );
        assert_eq!(
            live_context_usage(&json!({
                "sessionUpdate": "auto_compact_started",
                "tokens_used": 40000,
                "context_window": 256000
            })),
            Some(AcpContextUsage {
                used: 40000,
                size: 256000,
                estimated: false,
            })
        );
        assert_eq!(
            live_context_usage(&json!({
                "sessionUpdate": "auto_compact_completed",
                "tokens_after": 12000
            })),
            Some(AcpContextUsage {
                used: 12000,
                size: 0,
                estimated: false,
            })
        );
        assert_eq!(
            live_context_usage(&json!({
                "sessionUpdate": "session_status",
                "context_window": {"context_tokens": 300000, "context_window_size": 256000}
            })),
            None
        );
        for kind in ["turn_usage", "turn_completed"] {
            assert_eq!(
                live_context_usage(&json!({
                    "sessionUpdate": kind,
                    "usage": {"input_tokens": 329203, "inputTokens": 329203, "output_tokens": 4316}
                })),
                None
            );
        }
    }
    #[test]
    fn grok_prompt_context_is_last_call_not_the_turn_bill() {
        assert_eq!(
            grok_prompt_context(&json!({
                "_meta": {
                    "totalTokens": 33022,
                    "usage": {"inputTokens": 329203, "modelCalls": 13, "totalTokens": 333519}
                }
            })),
            Some(AcpContextUsage {
                used: 33022,
                size: 0,
                estimated: false,
            })
        );
        assert_eq!(
            grok_prompt_context(&json!({
                "_meta": {
                    "totalTokens": 333519,
                    "usage": {"inputTokens": 329203, "modelCalls": 13, "totalTokens": 333519}
                }
            })),
            None
        );
        assert_eq!(
            grok_prompt_context(&json!({
                "_meta": {
                    "totalTokens": 4000,
                    "usage": {"inputTokens": 4000, "modelCalls": 1, "totalTokens": 4200}
                }
            })),
            Some(AcpContextUsage {
                used: 4000,
                size: 0,
                estimated: false,
            })
        );
    }
    #[test]
    fn kimi_usage_report_keeps_context_occupancy_off_the_bill() {
        let report = parse_kimi_code_037_usage_report(
            "Context: 99999 / 200000 tokens (50%)\nSession total: 1470 input, 145 output",
        )
        .unwrap();
        assert_eq!(
            report.context,
            Some(AcpContextUsage {
                used: 99999,
                size: 200000,
                estimated: false,
            })
        );
        let fresh =
            parse_kimi_code_037_usage_report("Context: 0 tokens\nSession total: no LLM calls yet")
                .unwrap();
        assert_eq!(fresh.context, None);
        assert!(!fresh.recorded);
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
