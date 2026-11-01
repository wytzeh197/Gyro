//! Native Claude stream accounting. Request snapshots are keyed by message ID;
//! assistant output is provisional until message_stop or a successful result.
use super::*;
use gyro_core::usage::{UsageReason, UsageScope};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Default)]
struct ClaudeCounts {
    fresh: Option<u64>,
    read: Option<u64>,
    write: Option<u64>,
    output: Option<u64>,
}
impl ClaudeCounts {
    fn parse(value: &serde_json::Value, camel: bool) -> Option<Self> {
        let field = |snake, camel_key| {
            value
                .get(if camel { camel_key } else { snake })
                .and_then(serde_json::Value::as_u64)
        };
        let counts = Self {
            fresh: field("input_tokens", "inputTokens"),
            read: field("cache_read_input_tokens", "cacheReadInputTokens"),
            write: field("cache_creation_input_tokens", "cacheCreationInputTokens"),
            output: field("output_tokens", "outputTokens"),
        };
        (counts.fresh.is_some()
            || counts.read.is_some()
            || counts.write.is_some()
            || counts.output.is_some())
        .then_some(counts)
    }
    fn merge(&mut self, other: Self) -> bool {
        fn bucket(old: &mut Option<u64>, new: Option<u64>) -> bool {
            let regressed = old.zip(new).is_some_and(|(old, new)| new < old);
            *old = match (*old, new) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
            regressed
        }
        bucket(&mut self.fresh, other.fresh)
            | bucket(&mut self.read, other.read)
            | bucket(&mut self.write, other.write)
            | bucket(&mut self.output, other.output)
    }
    fn tokens(self, complete: bool) -> UsageTokens {
        let input = self
            .fresh
            .unwrap_or_default()
            .saturating_add(self.read.unwrap_or_default())
            .saturating_add(self.write.unwrap_or_default());
        let any_input = self.fresh.is_some() || self.read.is_some() || self.write.is_some();
        let mut tokens = UsageTokens::measured(
            any_input.then_some(input),
            self.read,
            self.output,
            None,
            None,
        )
        .with_cache_write(self.write);
        // Missing disjoint Anthropic buckets make total input a lower bound.
        if self.fresh.is_none() || self.read.is_none() || self.write.is_none() {
            if let Some(metadata) = tokens.accounting.as_mut() {
                metadata.known.input = false;
            }
            tokens = tokens.partial(UsageReason::MissingUsage);
        }
        if !complete {
            tokens = tokens.partial(UsageReason::ProviderIncomplete);
        }
        tokens
    }
}
#[derive(Default)]
struct ClaudeMessageUsage {
    counts: ClaudeCounts,
    stopped: bool,
    inconsistent: bool,
}

/// Whole-tree modelUsage semantics require evidence for the exact runtime.
/// No runtime is silently allowlisted; callers can supply verified evidence.
/// The schema is versioned so a persisted baseline cannot change interpretation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeModelUsageScope {
    Turn,
    Session,
}
pub(crate) struct ClaudeModelUsageEvidence {
    pub(crate) schema: u8,
    pub(crate) runtime_version: String,
    pub(crate) scope: ClaudeModelUsageScope,
    pub(crate) session_id: String,
    pub(crate) baseline: Option<UsageTokens>,
}

#[derive(Default)]
pub(crate) struct ClaudeTurnUsage {
    messages: BTreeMap<String, ClaudeMessageUsage>,
    active_message: Option<String>,
    context_message: Option<String>,
    anonymous: Option<ClaudeCounts>,
    final_main: Option<UsageTokens>,
    failure: Option<UsageReason>,
    observed_children: bool,
    runtime_version: Option<String>,
    session_id: Option<String>,
    tree_evidence: Option<ClaudeModelUsageEvidence>,
    tree: Option<UsageTokens>,
    tree_unverified: bool,
}
impl ClaudeTurnUsage {
    pub(crate) fn set_tree_evidence(&mut self, evidence: ClaudeModelUsageEvidence) {
        self.tree_evidence = Some(evidence);
    }
    pub(crate) fn observe(&mut self, value: &serde_json::Value) {
        let kind = value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if value
            .get("parent_tool_use_id")
            .is_some_and(|id| !id.is_null())
        {
            self.observed_children = true;
            return;
        }
        if kind == "system"
            && value.get("subtype").and_then(serde_json::Value::as_str) == Some("init")
        {
            self.runtime_version = value
                .get("claude_code_version")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            self.session_id = value
                .get("session_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
        }
        if self.final_main.is_some() && kind != "result" {
            return;
        }
        match kind {
            "assistant" => {
                if let Some(message) = value.get("message") {
                    self.observe_message(message);
                }
            }
            "stream_event" => {
                let Some(event) = value.get("event") else {
                    return;
                };
                match event.get("type").and_then(serde_json::Value::as_str) {
                    Some("message_start") => {
                        if let Some(message) = event.get("message") {
                            self.active_message = message
                                .get("id")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string);
                            self.observe_message(message);
                        }
                    }
                    Some("message_delta") => {
                        if let Some(counts) = event
                            .get("usage")
                            .and_then(|usage| ClaudeCounts::parse(usage, false))
                        {
                            if let Some(message) = self
                                .active_message
                                .as_ref()
                                .and_then(|id| self.messages.get_mut(id))
                            {
                                message.inconsistent |= message.counts.merge(counts);
                            } else {
                                self.observe_anonymous(counts);
                            }
                        }
                    }
                    Some("message_stop") => {
                        if let Some(message) = self
                            .active_message
                            .take()
                            .and_then(|id| self.messages.get_mut(&id))
                        {
                            message.stopped = true;
                        }
                    }
                    _ => {}
                }
            }
            "result" => {
                let success = value.get("subtype").and_then(serde_json::Value::as_str)
                    == Some("success")
                    && value.get("is_error").and_then(serde_json::Value::as_bool) != Some(true);
                let observed = self.final_main.or_else(|| self.request_tokens());
                let reported = value
                    .get("usage")
                    .and_then(|usage| ClaudeCounts::parse(usage, false))
                    .map(|counts| counts.tokens(success).with_scope(UsageScope::Turn));
                self.final_main = match (observed, reported) {
                    (Some(observed), Some(reported))
                        if super::counts_regressed(reported, observed) =>
                    {
                        Some(
                            lower_bound_union(observed, reported)
                                .partial(UsageReason::InconsistentCounts),
                        )
                    }
                    (_, Some(reported)) => Some(reported),
                    (observed, None) => {
                        observed.map(|tokens| tokens.partial(UsageReason::MissingUsage))
                    }
                };
                if !success {
                    self.failure = Some(
                        if value.get("subtype").and_then(serde_json::Value::as_str)
                            == Some("error_during_execution")
                        {
                            UsageReason::Interrupted
                        } else {
                            UsageReason::ProviderIncomplete
                        },
                    );
                }
                self.observe_tree(value);
            }
            _ => {}
        }
    }
    fn observe_message(&mut self, message: &serde_json::Value) {
        let Some(counts) = message
            .get("usage")
            .and_then(|usage| ClaudeCounts::parse(usage, false))
        else {
            return;
        };
        let Some(id) = message
            .get("id")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            self.observe_anonymous(counts);
            return;
        };
        let is_new = !self.messages.contains_key(id);
        let message = self.messages.entry(id.to_string()).or_default();
        message.inconsistent |= message.counts.merge(counts);
        if is_new || self.context_message.as_deref() == Some(id) {
            self.context_message = Some(id.to_string());
        }
    }
    fn observe_anonymous(&mut self, counts: ClaudeCounts) {
        self.anonymous
            .get_or_insert_with(ClaudeCounts::default)
            .merge(counts);
    }
    fn request_tokens(&self) -> Option<UsageTokens> {
        let mut total = None;
        for message in self.messages.values() {
            let mut tokens = message.counts.tokens(message.stopped);
            if message.inconsistent {
                tokens = tokens.partial(UsageReason::InconsistentCounts);
            }
            total = Some(total.map_or(tokens, |old: UsageTokens| old.combine(tokens)));
        }
        if let Some(counts) = self.anonymous {
            let tokens = counts.tokens(false).partial(UsageReason::UnknownScope);
            // Anonymous frames may duplicate a named request. Their identity
            // cannot justify adding another request to the ledger.
            total = Some(total.map_or(tokens, |old| {
                lower_bound_union(old, tokens).partial(UsageReason::UnknownScope)
            }));
        }
        total.map(|tokens| {
            let tokens = tokens.with_scope(UsageScope::Turn);
            if tokens.measured {
                tokens.partial(UsageReason::ProviderIncomplete)
            } else {
                tokens
            }
        })
    }
    pub(crate) fn tokens(&self) -> Option<UsageTokens> {
        let mut tokens = self
            .tree
            .or(self.final_main)
            .or_else(|| self.request_tokens())?;
        if (self.observed_children || self.tree_unverified) && self.tree.is_none() {
            tokens = tokens.partial(UsageReason::UnverifiedRuntime);
        }
        if let Some(reason) = self.failure {
            tokens = tokens.partial(reason);
        }
        Some(tokens)
    }
    pub(crate) fn interrupt(&mut self) {
        self.failure = Some(UsageReason::Interrupted);
    }
    /// Only a main-loop request can describe context occupancy.
    pub(crate) fn context_usage(&self) -> Option<ProviderContextUsage> {
        let counts = self.messages.get(self.context_message.as_ref()?)?.counts;
        let tokens = counts.tokens(false);
        Some(ProviderContextUsage {
            input_tokens: counts.fresh.map(|_| tokens.input_tokens),
            cached_input_tokens: match (counts.read, counts.write) {
                (None, None) => None,
                (read, write) => Some(
                    read.unwrap_or_default()
                        .saturating_add(write.unwrap_or_default()),
                ),
            },
            output_tokens: counts.output,
            total_tokens: counts.fresh.zip(counts.output).map(|_| tokens.total_tokens),
            ..ProviderContextUsage::default()
        })
    }
    fn observe_tree(&mut self, value: &serde_json::Value) {
        self.tree_unverified = value
            .get("modelUsage")
            .and_then(serde_json::Value::as_object)
            .is_some_and(|entries| {
                entries
                    .values()
                    .any(|entry| ClaudeCounts::parse(entry, true).is_some())
            });
        let Some(evidence) = self.tree_evidence.as_ref() else {
            return;
        };
        if evidence.schema != 1
            || self.runtime_version.as_deref() != Some(evidence.runtime_version.as_str())
            || self.session_id.as_deref() != Some(evidence.session_id.as_str())
        {
            return;
        }
        let Some(entries) = value
            .get("modelUsage")
            .and_then(serde_json::Value::as_object)
        else {
            return;
        };
        let mut total = None;
        for entry in entries.values() {
            let Some(counts) = ClaudeCounts::parse(entry, true) else {
                return;
            };
            let tokens = counts.tokens(true);
            total = Some(total.map_or(tokens, |old: UsageTokens| old.combine(tokens)));
        }
        let observed = self.tree.or(self.final_main);
        self.tree = total.map(|tokens| {
            let tokens = match evidence.scope {
                ClaudeModelUsageScope::Turn => tokens.with_scope(UsageScope::Task),
                ClaudeModelUsageScope::Session => match evidence.baseline {
                    Some(baseline)
                        if baseline.measured
                            && baseline.effective_accounting().scope == UsageScope::Session
                            && !super::counts_regressed(tokens, baseline) =>
                    {
                        super::subtract(tokens, baseline).with_scope(UsageScope::Task)
                    }
                    _ => self
                        .final_main
                        .unwrap_or_else(|| UsageTokens::unavailable(UsageReason::MissingBaseline))
                        .partial(UsageReason::MissingBaseline)
                        .with_scope(UsageScope::Task),
                },
            };
            if let Some(previous) =
                observed.filter(|previous| super::counts_regressed(tokens, *previous))
            {
                lower_bound_union(previous, tokens).partial(UsageReason::InconsistentCounts)
            } else {
                tokens
            }
        });
    }
}

/// Preserve already observed consumption if a crash reports zero/incomplete usage.
/// This is a union of lower bounds, never an addition of two snapshots.
fn lower_bound_union(a: UsageTokens, mut b: UsageTokens) -> UsageTokens {
    b.input_tokens = b.input_tokens.max(a.input_tokens);
    b.cached_input_tokens = b.cached_input_tokens.max(a.cached_input_tokens);
    b.cache_write_tokens = b.cache_write_tokens.max(a.cache_write_tokens);
    b.output_tokens = b.output_tokens.max(a.output_tokens);
    b.reasoning_output_tokens = b.reasoning_output_tokens.max(a.reasoning_output_tokens);
    b.total_tokens = b
        .total_tokens
        .max(a.total_tokens)
        .max(b.input_tokens.saturating_add(b.output_tokens));
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    use gyro_core::usage::{UsageCoverage, UsageSource};
    use serde_json::json;

    fn usage(input: u64, output: u64) -> serde_json::Value {
        json!({"input_tokens":input, "cache_read_input_tokens":20,
            "cache_creation_input_tokens":30, "output_tokens":output})
    }
    fn assistant(id: &str, input: u64, output: u64) -> serde_json::Value {
        json!({"type":"assistant", "message":{"id":id, "usage":usage(input, output)}})
    }
    fn success(input: u64, output: u64) -> serde_json::Value {
        json!({"type":"result", "subtype":"success", "usage":usage(input, output)})
    }
    fn event(event: serde_json::Value) -> serde_json::Value {
        json!({"type":"stream_event", "event":event})
    }
    #[test]
    fn assistant_placeholders_are_partial_and_snapshots_replace_by_message_id() {
        let mut state = ClaudeTurnUsage::default();
        state.observe(&assistant("a", 100, 1));
        assert_eq!(
            state.tokens().unwrap().accounting.unwrap().coverage,
            UsageCoverage::Partial
        );
        state.observe(&assistant("a", 100, 1));
        state.observe(&assistant("a", 100, 8));
        state.observe(&assistant("b", 200, 2));
        let tokens = state.tokens().unwrap();
        assert_eq!(tokens.input_tokens, 400);
        assert_eq!(tokens.output_tokens, 10);
        assert_eq!(tokens.cached_input_tokens, 40);
        assert_eq!(tokens.cache_write_tokens, 60);
        assert_eq!(tokens.total_tokens, 410);
        assert_eq!(tokens.accounting.unwrap().source, UsageSource::Provider);
        assert!(!tokens.accounting.unwrap().known.reasoning);
    }
    #[test]
    fn message_delta_is_cumulative_and_stop_finalizes_the_request() {
        let mut state = ClaudeTurnUsage::default();
        state.observe(&event(
            json!({"type":"message_start", "message":{"id":"a","usage":usage(100, 0)}}),
        ));
        state.observe(&event(
            json!({"type":"message_delta","usage":{"output_tokens":10}}),
        ));
        state.observe(&event(
            json!({"type":"message_delta","usage":{"output_tokens":10}}),
        ));
        state.observe(&event(
            json!({"type":"message_delta","usage":{"output_tokens":25}}),
        ));
        assert_eq!(state.tokens().unwrap().total_tokens, 175);
        assert_eq!(
            state.tokens().unwrap().accounting.unwrap().coverage,
            UsageCoverage::Partial
        );
        state.observe(&event(json!({"type":"message_stop"})));
        assert_eq!(
            state.tokens().unwrap().accounting.unwrap().coverage,
            UsageCoverage::Partial
        );
        state.observe(&success(100, 25));
        state.observe(&assistant("a", 100, 1));
        assert_eq!(state.tokens().unwrap().total_tokens, 175);
    }
    #[test]
    fn missing_cache_buckets_are_unknown_and_consumption_is_retained() {
        let mut state = ClaudeTurnUsage::default();
        state.observe(&json!({"type":"result","subtype":"success",
            "usage":{"input_tokens":100,"output_tokens":15}}));
        let tokens = state.tokens().unwrap();
        assert_eq!(tokens.total_tokens, 115);
        let metadata = tokens.accounting.unwrap();
        assert_eq!(metadata.coverage, UsageCoverage::Partial);
        assert!(!metadata.known.input);
        assert!(!metadata.known.cache_read);
        assert!(!metadata.known.cache_write);
        assert!(!metadata.known.reasoning);
    }
    #[test]
    fn crashes_and_budget_failures_never_erase_observed_consumption() {
        for subtype in [
            "error_during_execution",
            "error_max_budget_usd",
            "error_max_turns",
        ] {
            let mut state = ClaudeTurnUsage::default();
            state.observe(&assistant("a", 100, 10));
            state.observe(&json!({"type":"result","subtype":subtype,
                "is_error":true,"usage":{"input_tokens":0,"output_tokens":0,
                    "cache_read_input_tokens":0,"cache_creation_input_tokens":0}}));
            let tokens = state.tokens().unwrap();
            assert_eq!(tokens.total_tokens, 160, "{subtype}");
            assert_eq!(tokens.cache_write_tokens, 30);
            assert_eq!(tokens.accounting.unwrap().coverage, UsageCoverage::Partial);
        }
    }
    #[test]
    fn interruption_retains_partial_provider_counts() {
        let mut state = ClaudeTurnUsage::default();
        state.observe(&assistant("a", 100, 10));
        state.interrupt();
        let tokens = state.tokens().unwrap();
        assert_eq!(tokens.total_tokens, 160);
        assert_eq!(
            tokens.accounting.unwrap().reason,
            Some(UsageReason::Interrupted)
        );
    }
    #[test]
    fn child_frames_do_not_duplicate_main_loop_and_result_is_never_context() {
        let mut state = ClaudeTurnUsage::default();
        let mut child = assistant("child", 1000, 500);
        child["parent_tool_use_id"] = json!("tool-parent");
        state.observe(&child);
        assert!(state.context_usage().is_none());
        state.observe(&assistant("main", 100, 10));
        state.observe(&success(300, 20));
        assert_eq!(state.tokens().unwrap().total_tokens, 370);
        assert_eq!(state.context_usage().unwrap().input_tokens, Some(150));
        assert_eq!(
            state.tokens().unwrap().accounting.unwrap().coverage,
            UsageCoverage::Partial
        );
        let mut no_request = ClaudeTurnUsage::default();
        no_request.observe(&success(100, 10));
        assert!(no_request.context_usage().is_none());
    }
    fn init() -> serde_json::Value {
        json!({"type":"system","subtype":"init","claude_code_version":"fixture-1","session_id":"s"})
    }
    fn tree_result(input: u64, output: u64) -> serde_json::Value {
        let mut result = success(100, 10);
        result["usage"]["cache_read_input_tokens"] = json!(0);
        result["usage"]["cache_creation_input_tokens"] = json!(0);
        result["modelUsage"] = json!({"model-a":{"inputTokens":input,"outputTokens":output,
            "cacheReadInputTokens":0,"cacheCreationInputTokens":0}});
        result
    }
    #[test]
    fn whole_tree_requires_matching_version_session_and_scope_evidence() {
        for (schema, version, session) in [
            (2, "fixture-1", "s"),
            (1, "other", "s"),
            (1, "fixture-1", "other"),
        ] {
            let mut state = ClaudeTurnUsage::default();
            state.set_tree_evidence(ClaudeModelUsageEvidence {
                schema,
                runtime_version: version.into(),
                session_id: session.into(),
                scope: ClaudeModelUsageScope::Turn,
                baseline: None,
            });
            state.observe(&init());
            state.observe(&tree_result(1000, 100));
            let tokens = state.tokens().unwrap();
            assert_eq!(tokens.total_tokens, 110);
            assert_eq!(tokens.accounting.unwrap().coverage, UsageCoverage::Partial);
        }
        let mut state = ClaudeTurnUsage::default();
        state.set_tree_evidence(ClaudeModelUsageEvidence {
            schema: 1,
            runtime_version: "fixture-1".into(),
            session_id: "s".into(),
            scope: ClaudeModelUsageScope::Turn,
            baseline: None,
        });
        state.observe(&init());
        state.observe(&tree_result(1000, 100));
        assert_eq!(state.tokens().unwrap().total_tokens, 1100);
        assert_eq!(
            state.tokens().unwrap().accounting.unwrap().scope,
            UsageScope::Task
        );
    }
    #[test]
    fn resumed_tree_subtracts_only_a_verified_baseline() {
        for baseline in [
            None,
            Some(
                UsageTokens::measured(Some(800), Some(0), Some(80), None, Some(880))
                    .with_cache_write(Some(0))
                    .with_scope(UsageScope::Session),
            ),
        ] {
            let mut state = ClaudeTurnUsage::default();
            state.set_tree_evidence(ClaudeModelUsageEvidence {
                schema: 1,
                runtime_version: "fixture-1".into(),
                session_id: "s".into(),
                scope: ClaudeModelUsageScope::Session,
                baseline,
            });
            state.observe(&init());
            state.observe(&tree_result(1000, 100));
            let tokens = state.tokens().unwrap();
            if baseline.is_some() {
                assert_eq!(tokens.total_tokens, 220);
                assert_eq!(tokens.accounting.unwrap().coverage, UsageCoverage::Complete);
            } else {
                assert_eq!(tokens.total_tokens, 110);
                assert_eq!(
                    tokens.accounting.unwrap().reason,
                    Some(UsageReason::MissingBaseline)
                );
            }
        }
    }

    #[test]
    fn repeated_results_and_old_requests_do_not_erase_consumption_or_replace_context() {
        let mut state = ClaudeTurnUsage::default();
        state.observe(&assistant("a", 100, 10));
        state.observe(&assistant("b", 200, 20));
        state.observe(&assistant("a", 100, 10));
        assert_eq!(state.context_usage().unwrap().input_tokens, Some(250));
        state.observe(&success(500, 50));
        state.observe(&success(0, 0));
        assert_eq!(state.tokens().unwrap().total_tokens, 600);
        assert_eq!(
            state.tokens().unwrap().accounting.unwrap().coverage,
            UsageCoverage::Partial
        );
    }

    #[test]
    fn verified_tree_regressions_retain_every_known_observation() {
        let mut state = ClaudeTurnUsage::default();
        state.set_tree_evidence(ClaudeModelUsageEvidence {
            schema: 1,
            runtime_version: "fixture-1".into(),
            session_id: "s".into(),
            scope: ClaudeModelUsageScope::Turn,
            baseline: None,
        });
        state.observe(&init());
        state.observe(&tree_result(1000, 100));
        state.observe(&tree_result(200, 20));
        assert_eq!(state.tokens().unwrap().total_tokens, 1100);
        assert_eq!(
            state.tokens().unwrap().accounting.unwrap().coverage,
            UsageCoverage::Partial
        );
    }

    #[test]
    fn anonymous_duplicates_do_not_add_a_second_bill() {
        let mut state = ClaudeTurnUsage::default();
        state.observe(&assistant("a", 100, 10));
        state.observe(&json!({"type":"assistant","message":{"usage":usage(100,10)}}));
        assert_eq!(state.tokens().unwrap().total_tokens, 160);
        assert_eq!(
            state.tokens().unwrap().accounting.unwrap().reason,
            Some(UsageReason::UnknownScope)
        );
    }
}
