//! Provider turn accounting, independent of UI emission and the session ledger.
use super::types::{ProviderChatRequest, ProviderContextUsage, ProviderRunnerOutput};
use crate::UsageTokens;
use serde_json::Value;
#[path = "codex_rollout_usage.rs"]
mod codex_rollout_usage;
/// App-server `last` is request occupancy; `total` is a thread counter.
/// Missing baselines retain observed consumption as a partial lower bound.
/// A regression may be a reset or a delayed update: never guess a new epoch.
pub struct CodexTurnUsage {
    baseline: Option<UsageTokens>,
    high_water: Option<UsageTokens>,
    uncertain: Option<crate::usage::UsageReason>,
    tokens: Option<UsageTokens>,
    thread: Option<serde_json::Value>,
    turn_id: Option<String>,
}

impl CodexTurnUsage {
    pub fn new(resumed: bool) -> Self {
        Self {
            baseline: (!resumed).then(|| {
                UsageTokens::measured(Some(0), Some(0), Some(0), Some(0), Some(0))
                    .with_cache_write(Some(0))
            }),
            high_water: None,
            uncertain: None,
            tokens: None,
            thread: None,
            turn_id: None,
        }
    }
    pub fn bind_thread(&mut self, thread: &serde_json::Value) {
        self.thread = Some(serde_json::json!({"id": thread.get("id"), "path": thread.get("path")}));
    }
    pub fn bind_turn(&mut self, turn: Option<&str>) {
        self.turn_id = turn.map(str::to_string);
    }
    pub fn recover(&mut self) -> Option<UsageTokens> {
        let update = codex_rollout_usage::ending(self.thread.as_ref()?, self.turn_id.as_deref()?)?;
        self.observe(&update)
    }
    pub fn set_baseline(&mut self, baseline: Option<UsageTokens>) {
        if let Some(baseline) = baseline.filter(|tokens| tokens.measured) {
            self.baseline = Some(baseline);
            self.high_water = Some(baseline);
        }
    }
    pub fn observe(&mut self, params: &serde_json::Value) -> Option<UsageTokens> {
        use crate::usage::{UsageReason, UsageScope};
        let Some(total) = params.pointer("/tokenUsage/total").and_then(parse_counts) else {
            let reason = if self.baseline.is_none() {
                UsageReason::MissingBaseline
            } else {
                UsageReason::ProviderIncomplete
            };
            self.uncertain = Some(reason);
            if let Some(last) = params.pointer("/tokenUsage/last").and_then(parse_counts) {
                let observed = last.with_scope(UsageScope::Turn).partial(reason);
                self.tokens = Some(
                    self.tokens
                        .map_or(observed, |old| retain_observed_lower_bounds(old, observed)),
                );
            } else {
                self.tokens = self.tokens.map(|tokens| tokens.partial(reason));
            }
            return self.tokens;
        };
        if self
            .high_water
            .is_some_and(|old| counts_regressed(total, old))
        {
            self.uncertain = Some(UsageReason::InconsistentCounts);
            self.tokens = self
                .tokens
                .map(|tokens| tokens.partial(UsageReason::InconsistentCounts));
            return self.tokens;
        }
        self.high_water = Some(total);
        let mut tokens = match self.baseline {
            Some(baseline) => subtract(total, baseline),
            None => {
                self.uncertain = Some(UsageReason::MissingBaseline);
                let Some(last) = params.pointer("/tokenUsage/last").and_then(parse_counts) else {
                    self.tokens = Some(
                        self.tokens
                            .map_or_else(
                                || UsageTokens::unavailable(UsageReason::MissingBaseline),
                                |tokens| tokens.partial(UsageReason::MissingBaseline),
                            )
                            .with_scope(UsageScope::Turn),
                    );
                    return self.tokens;
                };
                if counts_regressed(total, last) {
                    self.uncertain = Some(UsageReason::InconsistentCounts);
                } else {
                    self.baseline = Some(subtract(total, last));
                }
                last.with_scope(UsageScope::Turn)
            }
        };
        if let Some(reason) = self.uncertain {
            tokens = tokens.partial(reason);
        }
        if let Some(previous) = self.tokens {
            tokens = retain_observed_lower_bounds(previous, tokens);
        }
        self.tokens = Some(tokens.with_scope(UsageScope::Turn));
        self.tokens
    }
    pub fn tokens(&self) -> Option<UsageTokens> {
        self.tokens
    }
    pub fn interrupt(&mut self) -> Option<UsageTokens> {
        let reason = crate::usage::UsageReason::Interrupted;
        self.uncertain = Some(reason);
        self.tokens = self.tokens.map(|tokens| tokens.partial(reason));
        self.tokens
    }
}

pub fn counts_regressed(total: UsageTokens, old: UsageTokens) -> bool {
    let known = |tokens: UsageTokens| {
        tokens
            .accounting
            .map(|metadata| metadata.known)
            .unwrap_or_default()
    };
    let a = known(total);
    let b = known(old);
    (a.input && b.input && total.input_tokens < old.input_tokens)
        || (a.output && b.output && total.output_tokens < old.output_tokens)
        || (a.cache_read && b.cache_read && total.cached_input_tokens < old.cached_input_tokens)
        || (a.cache_write && b.cache_write && total.cache_write_tokens < old.cache_write_tokens)
        || (a.reasoning
            && b.reasoning
            && total.reasoning_output_tokens < old.reasoning_output_tokens)
        || total.total_tokens < old.total_tokens
}

/// Match both identities before allowing a notification to affect any meter.
pub fn codex_usage_matches(params: &serde_json::Value, thread: &str, turn: Option<&str>) -> bool {
    params.get("threadId").and_then(serde_json::Value::as_str) == Some(thread)
        && turn
            .is_some_and(|id| params.get("turnId").and_then(serde_json::Value::as_str) == Some(id))
}

/// Read only the bounded tail of the exact resumed thread before dispatch.
/// The protocol's optional rollout path is a best-effort source; absent,
/// rotated, malformed or mismatched logs retain the uncertain fallback.
pub fn codex_usage_baseline(thread: &serde_json::Value) -> Option<UsageTokens> {
    parse_counts(&codex_rollout_usage::baseline(thread)?).filter(|tokens| tokens.measured)
}

pub fn parse_counts(value: &serde_json::Value) -> Option<UsageTokens> {
    let field = |camel: &str, snake: &str| {
        value
            .get(camel)
            .or_else(|| value.get(snake))
            .and_then(serde_json::Value::as_u64)
    };
    let input = field("inputTokens", "input_tokens");
    let output = field("outputTokens", "output_tokens");
    let total = field("totalTokens", "total_tokens");
    if input.is_none() && output.is_none() && total.is_none() {
        return None;
    }
    let cached = field("cachedInputTokens", "cached_input_tokens");
    let reasoning = field("reasoningOutputTokens", "reasoning_output_tokens");
    let write = field("cacheWriteInputTokens", "cache_write_input_tokens");
    let mut tokens = UsageTokens::measured(input, cached, output, reasoning, total)
        .with_cache_write(write)
        .with_scope(crate::usage::UsageScope::Session);
    if cached
        .zip(input)
        .is_some_and(|(cache, input)| cache > input)
        || reasoning
            .zip(output)
            .is_some_and(|(reasoning, output)| reasoning > output)
    {
        tokens = tokens.partial(crate::usage::UsageReason::InconsistentCounts);
    }
    Some(tokens)
}

pub fn subtract(total: UsageTokens, baseline: UsageTokens) -> UsageTokens {
    let known = |tokens: UsageTokens| {
        tokens
            .accounting
            .map(|metadata| metadata.known)
            .unwrap_or_default()
    };
    let a = known(total);
    let b = known(baseline);
    let delta = |value: u64, old: u64, supplied: bool| supplied.then(|| value.saturating_sub(old));
    let mut tokens = UsageTokens::measured(
        delta(
            total.input_tokens,
            baseline.input_tokens,
            a.input && b.input,
        ),
        delta(
            total.cached_input_tokens,
            baseline.cached_input_tokens,
            a.cache_read && b.cache_read,
        ),
        delta(
            total.output_tokens,
            baseline.output_tokens,
            a.output && b.output,
        ),
        delta(
            total.reasoning_output_tokens,
            baseline.reasoning_output_tokens,
            a.reasoning && b.reasoning,
        ),
        Some(total.total_tokens.saturating_sub(baseline.total_tokens)),
    )
    .with_cache_write(delta(
        total.cache_write_tokens,
        baseline.cache_write_tokens,
        a.cache_write && b.cache_write,
    ))
    .with_scope(crate::usage::UsageScope::Turn);
    if counts_regressed(total, baseline) {
        tokens = tokens.partial(crate::usage::UsageReason::InconsistentCounts);
    } else if !total.measured || !baseline.measured {
        tokens = tokens.partial(crate::usage::UsageReason::ProviderIncomplete);
    }
    tokens
}

/// New snapshots can omit previously observed buckets. Keep their numeric
/// lower bounds while the latest snapshot's known flags remain conservative.
fn retain_observed_lower_bounds(previous: UsageTokens, mut current: UsageTokens) -> UsageTokens {
    current.input_tokens = current.input_tokens.max(previous.input_tokens);
    current.cached_input_tokens = current
        .cached_input_tokens
        .max(previous.cached_input_tokens);
    current.cache_write_tokens = current.cache_write_tokens.max(previous.cache_write_tokens);
    current.output_tokens = current.output_tokens.max(previous.output_tokens);
    current.reasoning_output_tokens = current
        .reasoning_output_tokens
        .max(previous.reasoning_output_tokens);
    current.total_tokens = current
        .total_tokens
        .max(previous.total_tokens)
        .max(current.input_tokens.saturating_add(current.output_tokens));
    current
}

/// One turn's billed tokens, or the same clearly marked estimate the ledger
/// uses when a provider reports no counts. Share this with the response event
/// so the number under the answer agrees with the session total.
pub fn provider_turn_tokens(
    request: &ProviderChatRequest,
    output: Option<&ProviderRunnerOutput>,
) -> UsageTokens {
    if let Some(tokens) = output
        .and_then(|output| output.accounted_usage)
        .or_else(|| crate::provider_observation::snapshot().and_then(|summary| summary.tokens))
    {
        return tokens;
    }
    output
        .and_then(|output| output.billed_usage.as_ref())
        .map(|usage| {
            UsageTokens::measured(
                usage.input_tokens,
                usage.cached_input_tokens,
                usage.output_tokens,
                usage.reasoning_output_tokens,
                usage.total_tokens,
            )
        })
        .unwrap_or_else(|| {
            UsageTokens::estimated(
                request.message.chars().count(),
                output.map_or(0, |output| output.response.chars().count()),
            )
        })
}

pub fn usage_tokens(usage: &ProviderContextUsage) -> UsageTokens {
    UsageTokens::measured(
        usage.input_tokens,
        usage.cached_input_tokens,
        usage.output_tokens,
        usage.reasoning_output_tokens,
        usage.total_tokens,
    )
}
pub fn provider_context_usage_from_app_server(params: &Value) -> Option<ProviderContextUsage> {
    let token_usage = params.get("tokenUsage")?;
    let last = token_usage.get("last")?;
    Some(ProviderContextUsage {
        input_tokens: Some(last.get("inputTokens")?.as_u64()?),
        cached_input_tokens: last.get("cachedInputTokens").and_then(Value::as_u64),
        output_tokens: last.get("outputTokens").and_then(Value::as_u64),
        reasoning_output_tokens: last.get("reasoningOutputTokens").and_then(Value::as_u64),
        total_tokens: last.get("totalTokens").and_then(Value::as_u64),
        model_context_window: token_usage
            .get("modelContextWindow")
            .and_then(Value::as_u64),
        ..ProviderContextUsage::default()
    })
}
