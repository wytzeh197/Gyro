use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;

const MAX_CYCLE: usize = 4;
const NOTICE_REPETITIONS: usize = 3;
const PAUSE_REPETITIONS: usize = 6;
type Fingerprint = [u8; 32];

/// SHA-256 of the same compact JSON `serde_json::to_vec` would produce.
///
/// Progress detection runs on every finished tool call, and the outcome can
/// be a whole file. The buffer existed only to be hashed. A failed write
/// hashes nothing, matching the previous `unwrap_or_default` fallback.
fn fingerprint(tool: &str, args: &Value, state: &Value, outcome: &Value) -> Fingerprint {
    let mut hasher = Sha256::new();
    if serde_json::to_writer(&mut hasher, &(tool, args, state, outcome)).is_ok() {
        hasher.finalize().into()
    } else {
        Sha256::digest([]).into()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    Continue,
    Correct,
    Pause,
}
#[derive(Default)]
pub struct Detector {
    history: VecDeque<Fingerprint>,
    warned_cycle: Option<Vec<Fingerprint>>,
}
impl Detector {
    pub fn observe(
        &mut self,
        tool: &str,
        args: &Value,
        state: &Value,
        outcome: &Value,
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
