use crate::capabilities::{CapabilityId, CapabilityResponse, CapabilityStatus};
use serde::{ser::SerializeMap, Deserialize, Serialize, Serializer};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;

const MAX_CYCLE: usize = 4;
const NOTICE_REPETITIONS: usize = 3;
const PAUSE_REPETITIONS: usize = 6;
pub const OUTSIDE_WORKSPACE_INSPECTION_PATH: &str = "outside-workspace-inspection-path";
type Fingerprint = [u8; 32];

/// SHA-256 of the same compact JSON `serde_json::to_vec` would produce.
///
/// Progress detection runs on every finished tool call, and the outcome can
/// be a whole file. The buffer existed only to be hashed. A failed write
/// hashes nothing, matching the previous `unwrap_or_default` fallback.
fn fingerprint(tool: &str, args: &Value, state: &Value, outcome: &impl Serialize) -> Fingerprint {
    let mut hasher = Sha256::new();
    if serde_json::to_writer(&mut hasher, &(tool, args, state, outcome)).is_ok() {
        hasher.finalize().into()
    } else {
        Sha256::digest([]).into()
    }
}

/// Only repeatable workspace evidence errors can affect an active turn.
pub fn is_repeatable_read_failure(capability: CapabilityId, response: &CapabilityResponse) -> bool {
    matches!(
        capability,
        CapabilityId::WorkspaceList
            | CapabilityId::WorkspaceSearch
            | CapabilityId::WorkspaceRead
            | CapabilityId::WorkspaceReadRange
            | CapabilityId::WorkspaceReadEditor
    ) && response.status == CapabilityStatus::Failed
        && response.error.as_ref().is_some_and(|error| {
            matches!(
                error.code.as_str(),
                "execution-failed"
                    | "invalid-arguments"
                    | "invalid-root"
                    | "root-required"
                    | OUTSIDE_WORKSPACE_INSPECTION_PATH
            )
        })
}

struct StableResult<'a>(&'a Value);

impl Serialize for StableResult<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let Some(fields) = self.0.as_object() else {
            return self.0.serialize(serializer);
        };
        // Drop per-execution metadata while hashing, without copying large
        // file contents into a temporary result.
        let mut stable = serializer.serialize_map(None)?;
        for (field, value) in fields {
            if !matches!(
                field.as_str(),
                "id" | "finishedAt" | "capturedAt" | "owner" | "contextRevision"
            ) {
                stable.serialize_entry(field, value)?;
            }
        }
        stable.end()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    Continue,
    Correct,
    Pause,
}
impl Decision {
    pub fn notice(self, failed_read: bool) -> Option<&'static str> {
        match self {
            Self::Continue => None,
            Self::Correct if failed_read => Some("Repeated failed lookup. Call gyro_workspace_list before answering, then read the path it returns."),
            Self::Correct => Some("The same tool-call sequence returned unchanged evidence three times. Save a checkpoint and choose a different approach; required verification still applies."),
            Self::Pause => Some("The same tool-call sequence returned unchanged evidence six times. Gyro paused this turn. Review the checkpoint and resume with a changed approach."),
        }
    }
}
#[derive(Default)]
pub struct Detector {
    history: VecDeque<Fingerprint>,
    warned_cycle: Option<Vec<Fingerprint>>,
}
impl Detector {
    pub fn observe_capability(
        &mut self,
        capability: CapabilityId,
        args: &Value,
        state: &Value,
        response: &CapabilityResponse,
    ) -> Decision {
        if let Some(result) = response.result.as_ref() {
            self.observe_outcome(
                capability.as_str(),
                args,
                state,
                &(response.status, StableResult(&result.data)),
            )
        } else if let Some(error) = response
            .error
            .as_ref()
            .filter(|_| is_repeatable_read_failure(capability, response))
        {
            self.observe_outcome(
                capability.as_str(),
                args,
                state,
                &(response.status, &error.code, &error.message),
            )
        } else {
            Decision::Continue
        }
    }

    pub fn observe(
        &mut self,
        tool: &str,
        args: &Value,
        state: &Value,
        outcome: &Value,
    ) -> Decision {
        self.observe_outcome(tool, args, state, outcome)
    }

    fn observe_outcome(
        &mut self,
        tool: &str,
        args: &Value,
        state: &Value,
        outcome: &impl Serialize,
    ) -> Decision {
        if matches!(
            tool,
            "terminal.wait"
                | "terminal.read"
                | "workspace.read_output"
                | "agent.reports"
                | "agent.wait"
        ) {
            self.history.clear();
            self.warned_cycle = None;
            return Decision::Continue;
        }
        let fingerprint = fingerprint(tool, args, state, outcome);
        self.history.push_back(fingerprint);
        if self.history.len() > MAX_CYCLE * PAUSE_REPETITIONS {
            self.history.pop_front();
        }
        // Match complete repetitions of a short suffix, not merely repeated
        // tool names. Arguments, workspace state and evidence must all agree.
        // Keeping only 24 fingerprints bounds both storage and comparison work.
        let len = self.history.len();
        for period in 1..=MAX_CYCLE.min(len / NOTICE_REPETITIONS) {
            let matching = (0..len)
                .take_while(|&offset| {
                    self.history[len - 1 - offset] == self.history[len - 1 - offset % period]
                })
                .count();
            let repeats = matching / period;
            if repeats < NOTICE_REPETITIONS {
                continue;
            }
            if repeats >= PAUSE_REPETITIONS {
                return Decision::Pause;
            }
            // A,B,A,B and B,A,B,A are the same cycle at different phases.
            // Canonical rotation emits one correction for that unchanged loop.
            let cycle: Vec<_> = self.history.iter().skip(len - period).copied().collect();
            let canonical = (0..period)
                .map(|start| {
                    cycle[start..]
                        .iter()
                        .chain(&cycle[..start])
                        .copied()
                        .collect::<Vec<_>>()
                })
                .min()
                .expect("a repeating cycle is nonempty");
            if self.warned_cycle.as_ref() == Some(&canonical) {
                return Decision::Continue;
            }
            self.warned_cycle = Some(canonical);
            return Decision::Correct;
        }
        self.warned_cycle = None;
        Decision::Continue
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repeatable_read_errors_warn_then_pause_and_new_evidence_resets_them() {
        let mut detector = Detector::default();
        let args = json!({"path":"missing.rs"});
        for (call, decision) in [
            Decision::Continue,
            Decision::Continue,
            Decision::Correct,
            Decision::Continue,
            Decision::Continue,
            Decision::Pause,
        ]
        .into_iter()
        .enumerate()
        {
            let outcome = CapabilityResponse::failed(
                "test",
                uuid::Uuid::new_v4(),
                "execution-failed",
                "No file at missing.rs",
            );
            assert_eq!(
                detector.observe_capability(
                    CapabilityId::WorkspaceRead,
                    &args,
                    &json!(1),
                    &outcome
                ),
                decision,
                "call {call}"
            );
        }
        let different = CapabilityResponse::failed(
            "test",
            uuid::Uuid::new_v4(),
            "execution-failed",
            "No file at missing.rs",
        );
        assert_eq!(
            detector.observe_capability(CapabilityId::WorkspaceRead, &args, &json!(2), &different),
            Decision::Continue
        );
    }

    #[test]
    fn unrelated_or_ineligible_errors_cannot_start_a_progress_pause() {
        for (capability, code) in [
            (CapabilityId::WorkspaceRead, "invalid-run"),
            (CapabilityId::WorkspaceRead, "cancelled"),
            (CapabilityId::WorkspaceRead, "policy-denied"),
            (CapabilityId::WorkspaceRead, "workspace-changed"),
            (CapabilityId::TerminalWait, "execution-failed"),
            (CapabilityId::WorkspaceRunCommand, "execution-failed"),
        ] {
            let response = CapabilityResponse::failed("test", uuid::Uuid::new_v4(), code, "Failed");
            let mut detector = Detector::default();
            for _ in 0..8 {
                assert_eq!(
                    detector.observe_capability(capability, &json!({}), &json!(1), &response),
                    Decision::Continue
                );
            }
        }
    }

    #[test]
    fn success_fingerprint_tracks_file_evidence_across_volatile_result_fields() {
        let mut detector = Detector::default();
        let capability = CapabilityId::WorkspaceRead;
        let args = json!({"path":"source.rs"});
        for (call, content_hash) in ["a", "a", "b", "b", "b"].into_iter().enumerate() {
            let result = CapabilityResponse::completed(
                "test",
                crate::capabilities::CapabilityResult {
                    call_id: uuid::Uuid::new_v4(),
                    capability_id: capability,
                    summary: "Read".into(),
                    resource: None,
                    data: json!({"contentHash":content_hash,"id":call,"finishedAt":call,"contextRevision":call}),
                },
            );
            let expected = if call == 4 {
                Decision::Correct
            } else {
                Decision::Continue
            };
            assert_eq!(
                detector.observe_capability(capability, &args, &json!(1), &result),
                expected
            );
        }
    }
    #[test]
    fn correct_then_pause_and_reset() {
        let mut d = Detector::default();
        for n in 1..=6 {
            assert_eq!(
                d.observe(
                    "workspace.read",
                    &json!({"path":"a"}),
                    &json!(1),
                    &json!("same")
                ),
                match n {
                    3 => Decision::Correct,
                    6 => Decision::Pause,
                    _ => Decision::Continue,
                }
            );
        }
        assert_eq!(
            d.observe(
                "workspace.read",
                &json!({"path":"a"}),
                &json!(2),
                &json!("same")
            ),
            Decision::Continue
        );
    }
    #[test]
    fn polling_never_pauses() {
        let mut d = Detector::default();
        for _ in 0..10 {
            assert_eq!(
                d.observe("terminal.wait", &Value::Null, &Value::Null, &Value::Null),
                Decision::Continue
            );
        }
    }
    #[test]
    fn actual_polling_capabilities_never_pause() {
        use crate::capabilities::CapabilityId;
        for id in [
            CapabilityId::TerminalWait,
            CapabilityId::TerminalRead,
            CapabilityId::WorkspaceReadOutput,
            CapabilityId::AgentWait,
        ] {
            let mut detector = Detector::default();
            for _ in 0..20 {
                assert_eq!(
                    detector.observe(id.as_str(), &json!({}), &json!(1), &json!("same")),
                    Decision::Continue
                );
            }
        }
    }
    #[test]
    fn changed_arguments_results_and_resume_reset_repetition() {
        for changed in 0..3 {
            let mut d = Detector::default();
            for _ in 0..2 {
                d.observe("workspace.read", &json!(1), &json!(1), &json!(1));
            }
            let mut values = [json!(1), json!(1), json!(1)];
            values[changed] = json!(2);
            assert_eq!(
                d.observe("workspace.read", &values[0], &values[1], &values[2]),
                Decision::Continue
            );
        }
        // A new turn owns a new detector; cancellation does not carry repeats into resume.
        assert_eq!(
            Detector::default().observe("workspace.read", &json!(1), &json!(1), &json!(1)),
            Decision::Continue
        );
    }

    const TOOLS: [&str; 4] = [
        "workspace.read",
        "workspace.git_status",
        "workspace.search",
        "code.outline",
    ];

    #[test]
    fn short_unchanged_cycles_warn_once_then_pause() {
        for period in 2..=4 {
            let mut detector = Detector::default();
            // An extra cycle verifies all phases after the pause threshold.
            for call in 0..period * 7 {
                let slot = call % period;
                assert_eq!(
                    detector.observe(TOOLS[slot], &json!(slot), &json!(1), &json!(slot)),
                    if call + 1 >= period * 6 {
                        Decision::Pause
                    } else if call + 1 == period * 3 {
                        Decision::Correct
                    } else {
                        Decision::Continue
                    },
                    "period={period}, call={call}"
                );
            }
        }
    }

    #[test]
    fn changed_cycle_arguments_state_or_evidence_do_not_trigger_a_stale_pause() {
        for changed in 0..3 {
            let mut detector = Detector::default();
            for call in 0..10 {
                let slot = call % 2;
                detector.observe(TOOLS[slot], &json!(slot), &json!(1), &json!(slot));
            }
            let mut values = [json!(0), json!(1), json!(0)];
            values[changed] = json!("new evidence");
            assert_eq!(
                detector.observe(TOOLS[0], &values[0], &values[1], &values[2]),
                Decision::Continue
            );
            // Old repetitions cannot carry across the changed observation.
            // Three fresh cycles are required before another correction.
            for call in 0..6 {
                let slot = (call + 1) % 2;
                assert_eq!(
                    detector.observe(TOOLS[slot], &json!(slot), &json!(1), &json!(slot)),
                    if call == 5 {
                        Decision::Correct
                    } else {
                        Decision::Continue
                    }
                );
            }
        }
    }

    #[test]
    fn continuously_changing_evidence_is_progress_even_with_repeated_tool_order() {
        for changed in 0..3 {
            let mut detector = Detector::default();
            for call in 0..100 {
                let slot = call % 2;
                let mut values = [json!(slot), json!(1), json!(slot)];
                values[changed] = json!(call / 2);
                assert_eq!(
                    detector.observe(TOOLS[slot], &values[0], &values[1], &values[2]),
                    Decision::Continue
                );
            }
        }
    }

    #[test]
    fn polling_interrupts_and_resets_short_cycles() {
        for tool in [
            "terminal.wait",
            "terminal.read",
            "workspace.read_output",
            "agent.reports",
            "agent.wait",
        ] {
            let mut detector = Detector::default();
            for _ in 0..10 {
                for call in 0..4 {
                    let slot = call % 2;
                    assert_eq!(
                        detector.observe(TOOLS[slot], &json!(slot), &json!(1), &json!(slot)),
                        Decision::Continue
                    );
                }
                assert_eq!(
                    detector.observe(tool, &Value::Null, &Value::Null, &Value::Null),
                    Decision::Continue
                );
                assert!(detector.history.is_empty());
            }
        }
    }

    #[test]
    fn longer_workflows_are_not_guessed_to_be_short_loops_and_storage_is_bounded() {
        let mut detector = Detector::default();
        for call in 0..1_000 {
            assert_eq!(
                detector.observe(
                    "workspace.read",
                    &json!(call % 5),
                    &json!(1),
                    &json!("same")
                ),
                Decision::Continue
            );
            assert!(detector.history.len() <= 24);
        }
    }

    #[test]
    fn fingerprint_matches_the_compact_json_bytes() {
        use sha2::{Digest, Sha256};
        let tool = "workspace.read";
        let args = json!({"path": "src/lib.rs", "note": "界"});
        let state = json!({"workspace": "demo", "rootRevision": 4, "revision": 9});
        let outcome = json!({
            "content": format!("{}界", "line\n".repeat(2_048)),
            "contentHash": "abc",
            "truncated": false
        });
        let via_buffer: Fingerprint =
            Sha256::digest(serde_json::to_vec(&(tool, &args, &state, &outcome)).unwrap()).into();
        let empty: Fingerprint = Sha256::digest([]).into();
        assert_eq!(fingerprint(tool, &args, &state, &outcome), via_buffer);
        assert_ne!(via_buffer, empty);
    }
}
