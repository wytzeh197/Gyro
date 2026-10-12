use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    Continue,
    Correct,
    Pause,
}
#[derive(Default)]
pub struct Detector {
    last: Option<[u8; 32]>,
    repeats: usize,
}
impl Detector {
    pub fn observe(
        &mut self,
        tool: &str,
        args: &Value,
        state: &Value,
        outcome: &Value,
    ) -> Decision {
        if tool.contains("wait")
            || tool.contains("read_output")
            || tool == "terminal.read"
            || tool == "agent.reports"
        {
            self.last = None;
            self.repeats = 0;
            return Decision::Continue;
        }
        let fingerprint: [u8; 32] =
            Sha256::digest(serde_json::to_vec(&(tool, args, state, outcome)).unwrap_or_default())
                .into();
        if self.last == Some(fingerprint) {
            self.repeats += 1;
        } else {
            self.last = Some(fingerprint);
            self.repeats = 1;
        }
        match self.repeats {
            3 => Decision::Correct,
            6.. => Decision::Pause,
            _ => Decision::Continue,
        }
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
}
