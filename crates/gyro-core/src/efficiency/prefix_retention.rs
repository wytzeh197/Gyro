//! Bounded retention of already-sent API messages between retirement checkpoints.
use super::context::{prepare_owned_model_request_with_policy, EvidencePolicy};
use serde_json::Value;

/// Retention is local to one owned API turn. Window compaction and provider
/// recovery remain free to shorten a request sooner.
#[derive(Default)]
pub struct PrefixRetention {
    rounds: usize,
    checkpoint_bytes: usize,
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
        if !enabled {
            *self = Self::default();
            return prepare_owned_model_request_with_policy(messages, policy);
        }
        let bytes = request_bytes(messages);
        // A shrinking request means compaction/recovery has already changed
        // the prefix. Retire now rather than delaying behind a stale checkpoint.
        if self.rounds > 0
            && self.rounds < CHECKPOINT_ROUNDS
            && bytes >= self.checkpoint_bytes
            && bytes - self.checkpoint_bytes < MAX_GROWTH_BYTES
        {
            self.rounds += 1;
            return 0;
        }
        let saved = prepare_owned_model_request_with_policy(messages, policy);
        self.checkpoint_bytes = request_bytes(messages);
        self.rounds = 1;
        saved
    }
}

// Measure serialized bytes without retaining another full request allocation.
fn request_bytes(messages: &[Value]) -> usize {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    // Serializing a Value to this infallible writer cannot fail.
    serde_json::to_writer(&mut counter, messages).expect("count JSON bytes");
    counter.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn exchange(messages: &mut Vec<Value>, id: usize, bytes: usize) {
        messages.push(json!({"role":"assistant","tool_calls":[
            {"id":format!("call-{id}"),"type":"function","function":{
                "name":"gyro_workspace_read","arguments":"{\"path\":\"file.rs\"}"
            }}
        ]}));
        messages.push(json!({"role":"tool","tool_call_id":format!("call-{id}"),
            "content":json!({"callId":format!("call-{id}"),
                "result":{"capabilityId":"workspace-read","summary":"Read file",
                    "data":{"path":"file.rs","content":"x".repeat(bytes)}}}).to_string()}));
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
