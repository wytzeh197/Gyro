//! Bounded retention of already-sent API messages between retirement checkpoints.
use super::context::{
    compact_duplicate_reads, prepare_owned_model_request_for_task, retire_with_policy,
    EvidencePolicy,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Retention is local to one owned API turn. Window compaction and provider
/// recovery remain free to shorten a request sooner.
#[derive(Default)]
pub struct PrefixRetention {
    rounds: usize,
    checkpoint_bytes: usize,
    previous: Option<PreparedPrefix>,
    reuses_completed_prefix: bool,
}

// Candidates for paired measurement, not claims about a provider's cache.
const CHECKPOINT_ROUNDS: usize = 8;
const MAX_GROWTH_BYTES: usize = 64 * 1024;

impl PrefixRetention {
    pub fn prepare(
        &mut self,
        messages: &mut [Value],
        policy: EvidencePolicy,
        enabled: bool,
    ) -> usize {
        self.prepare_for_task(messages, policy, enabled, "")
    }

    pub fn prepare_for_task(
        &mut self,
        messages: &mut [Value],
        policy: EvidencePolicy,
        enabled: bool,
        task: &str,
    ) -> usize {
        if !enabled {
            *self = Self::default();
            return prepare_owned_model_request_for_task(messages, policy, task);
        }
        let saved = compact_duplicate_reads(messages);
        saved + self.prepare_request_for_task(messages, policy, enabled, task, None)
    }

    /// The runner has already folded duplicate evidence as it appended the
    /// fresh tool replies. Prepare only the retained prefix here.
    pub(crate) fn prepare_request_for_task(
        &mut self,
        messages: &mut [Value],
        policy: EvidencePolicy,
        enabled: bool,
        task: &str,
        tools: Option<(&[Value], bool)>,
    ) -> usize {
        if !enabled {
            *self = Self::default();
            return retire_with_policy(messages, policy, task);
        }
        let (mut prefix, matches_previous) = measure_request(messages, tools, self.previous);
        // A growing request can still have an edited prefix. Retire now if
        // a warning, catalog change, or compaction invalidated the earlier input.
        let retain = matches_previous
            && (1..CHECKPOINT_ROUNDS).contains(&self.rounds)
            && prefix
                .message_bytes
                .checked_sub(self.checkpoint_bytes)
                .is_some_and(|growth| growth < MAX_GROWTH_BYTES);
        let retired = if retain {
            self.rounds += 1;
            0
        } else {
            let retired = retire_with_policy(messages, policy, task);
            if retired > 0 {
                prefix = measure_request(messages, tools, None).0;
            }
            self.checkpoint_bytes = prefix.message_bytes;
            self.rounds = 1;
            retired
        };
        self.reuses_completed_prefix =
            retain && self.previous.is_some_and(|prefix| prefix.completed);
        self.previous = Some(prefix);
        retired
    }

    pub(crate) fn confirm_request_completed(&mut self) {
        if let Some(prefix) = self.previous.as_mut() {
            prefix.completed = true;
        }
        if std::mem::take(&mut self.reuses_completed_prefix) {
            crate::provider_observation::efficiency_event(|events| {
                events.confirmed_prefix_reuses = events.confirmed_prefix_reuses.saturating_add(1);
            });
        }
    }
}

#[derive(Clone, Copy)]
struct PreparedPrefix {
    message_count: usize,
    message_bytes: usize,
    hash: [u8; 32],
    completed: bool,
}

// Measure the growth budget and fingerprint the earlier prefix in the same
// serialization pass. Only the digest and counts live past this preparation.
fn measure_request(
    messages: &[Value],
    tools: Option<(&[Value], bool)>,
    previous: Option<PreparedPrefix>,
) -> (PreparedPrefix, bool) {
    struct Measurement {
        hash: Sha256,
        bytes: usize,
    }
    impl std::io::Write for Measurement {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.hash.update(bytes);
            self.bytes = self.bytes.saturating_add(bytes.len());
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut measurement = Measurement {
        hash: Sha256::new(),
        bytes: 0,
    };
    serde_json::to_writer(&mut measurement, &tools).expect("fingerprint tool settings");
    measurement.bytes = 2; // The message array's brackets, outside the growing hash.
    let mut matches_previous = false;
    for (index, message) in messages.iter().enumerate() {
        if index > 0 {
            measurement.hash.update(b",");
            measurement.bytes += 1;
        }
        serde_json::to_writer(&mut measurement, message).expect("fingerprint JSON message");
        if let Some(previous) = previous.filter(|previous| previous.message_count == index + 1) {
            let previous_length_hash: [u8; 32] = measurement.hash.clone().finalize().into();
            matches_previous = previous_length_hash == previous.hash;
        }
    }
    (
        PreparedPrefix {
            message_count: messages.len(),
            message_bytes: measurement.bytes,
            hash: measurement.hash.finalize().into(),
            completed: false,
        },
        matches_previous,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::efficiency::context::prepare_owned_model_request_with_policy;
    use serde_json::json;

    fn read_call(id: usize) -> Value {
        json!({"id":format!("call-{id}"),"type":"function","function":{
                "name":"gyro_workspace_read","arguments":"{\"path\":\"file.rs\"}"
        }})
    }

    fn read_reply(id: usize, bytes: usize) -> Value {
        json!({"role":"tool","tool_call_id":format!("call-{id}"),
            "content":json!({"status":"completed","callId":format!("call-{id}"),
                "result":{"capabilityId":"workspace-read","summary":"Read file",
                    "data":{"path":"file.rs","contentHash":format!("fixture-{bytes}"),"content":"x".repeat(bytes)}}}).to_string()})
    }

    fn exchange(messages: &mut Vec<Value>, id: usize, bytes: usize) {
        messages.push(json!({"role":"assistant","tool_calls":[read_call(id)]}));
        messages.push(read_reply(id, bytes));
    }

    fn messages() -> Vec<Value> {
        let mut messages = vec![
            json!({"role":"system","content":"instructions"}),
            json!({"role":"user","content":"task"}),
        ];
        exchange(&mut messages, 0, 3000);
        messages
    }

    #[test]
    fn sent_messages_survive_until_the_bounded_checkpoint() {
        let mut state = PrefixRetention::default();
        let mut messages = messages();
        state.prepare(&mut messages, EvidencePolicy::Preview, true);
        for id in 1..CHECKPOINT_ROUNDS {
            let previous = messages.clone();
            exchange(&mut messages, id, 3000);
            assert_eq!(
                state.prepare(&mut messages, EvidencePolicy::Preview, true),
                0
            );
            assert!(super::super::cache_plan::appended_only(
                &previous, &messages
            ));
        }
        exchange(&mut messages, CHECKPOINT_ROUNDS, 3000);
        assert!(state.prepare(&mut messages, EvidencePolicy::Preview, true) > 0);
        assert_eq!(messages[0]["content"], "instructions");
        assert_eq!(messages[1]["content"], "task");
        assert_eq!(messages[3]["tool_call_id"], "call-0");
        assert!(messages[3]["content"]
            .as_str()
            .unwrap()
            .contains("spill://"));
        // The newest tool result is still exact.
        assert!(messages.last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains(&"x".repeat(3000)));
    }

    #[test]
    fn growth_forces_retirement_before_the_round_checkpoint() {
        let mut state = PrefixRetention::default();
        let mut messages = messages();
        state.prepare(&mut messages, EvidencePolicy::Preview, true);
        exchange(&mut messages, 1, MAX_GROWTH_BYTES);
        assert!(state.prepare(&mut messages, EvidencePolicy::Preview, true) > 0);
    }

    #[test]
    fn a_rewritten_prefix_starts_a_new_retirement_checkpoint_even_if_the_body_grows() {
        let mut state = PrefixRetention::default();
        let mut messages = messages();
        state.prepare(&mut messages, EvidencePolicy::Preview, true);
        messages[1]["content"] = json!("updated task");
        exchange(&mut messages, 1, 3000);
        state.prepare(&mut messages, EvidencePolicy::Preview, true);
        assert_eq!(state.rounds, 1, "the earlier messages were changed");
    }

    #[test]
    fn reuse_requires_two_completed_requests_and_the_same_tool_settings() {
        let _scope = crate::provider_observation::Scope::start();
        let observed = || {
            crate::provider_observation::snapshot()
                .unwrap()
                .context_attribution
                .efficiency_events
                .map_or(0, |events| events.confirmed_prefix_reuses)
        };
        let mut state = PrefixRetention::default();
        let mut messages = messages();
        let tools = [json!({"type":"function","function":{"name":"read_file"}})];
        let policy = EvidencePolicy::Preview;

        state.prepare_request_for_task(&mut messages, policy, true, "", Some((&tools, true)));
        state.confirm_request_completed();
        exchange(&mut messages, 1, 3000);
        state.prepare_request_for_task(&mut messages, policy, true, "", Some((&tools, true)));
        assert_eq!(
            observed(),
            0,
            "the matching preparation is not yet confirmed"
        );
        state.confirm_request_completed();
        assert_eq!(observed(), 1);
        state.confirm_request_completed();
        assert_eq!(observed(), 1, "a completion is counted once");

        exchange(&mut messages, 2, 3000);
        state.prepare_request_for_task(&mut messages, policy, true, "", Some((&tools, false)));
        state.confirm_request_completed();
        assert_eq!(state.rounds, 1);
        assert_eq!(observed(), 1, "tool choice changed");

        exchange(&mut messages, 3, 3000);
        state.prepare_request_for_task(&mut messages, policy, true, "", None);
        exchange(&mut messages, 4, 3000);
        state.prepare_request_for_task(&mut messages, policy, true, "", None);
        state.confirm_request_completed();
        assert_eq!(observed(), 1, "the preceding preparation did not complete");
    }

    #[test]
    fn duplicate_reads_are_folded_between_checkpoints_without_rewriting_sent_messages() {
        let mut state = PrefixRetention::default();
        let mut messages = messages();
        state.prepare(&mut messages, EvidencePolicy::Preview, true);
        let sent = messages.clone();
        let duplicate = read_reply(2, 6_000);
        messages.extend([
            json!({"role":"assistant","tool_calls":[read_call(1), read_call(2)]}),
            read_reply(1, 6_000),
            duplicate.clone(),
        ]);

        assert!(state.prepare(&mut messages, EvidencePolicy::Preview, true) > 5_000);
        assert_eq!(state.rounds, 2);
        let (previous, current) = messages.split_at(sent.len());
        assert_eq!(previous, sent);
        assert_eq!(current[1]["tool_call_id"], "call-1");
        assert_eq!(current[2], duplicate);
        let reference: Value =
            serde_json::from_str(current[1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(
            reference["result"]["data"]["sameEvidenceAsCallId"],
            "call-2"
        );
    }

    #[test]
    fn rollback_uses_the_existing_policy_on_every_round() {
        let mut state = PrefixRetention::default();
        let mut actual = messages();
        state.prepare(&mut actual, EvidencePolicy::Preview, true);
        exchange(&mut actual, 1, 3000);
        let mut expected = actual.clone();
        let saved = prepare_owned_model_request_with_policy(&mut expected, EvidencePolicy::Tight);
        assert_eq!(
            state.prepare(&mut actual, EvidencePolicy::Tight, false),
            saved
        );
        assert_eq!(actual, expected);
        assert_eq!(state.rounds, 0);
    }
}
