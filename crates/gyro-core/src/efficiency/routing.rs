//! Routing is opt-in at a phase boundary. It never retries/switches every action.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Route {
    pub phase: String,
    pub provider: String,
    pub model: String,
}
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub enabled: bool,
    pub routes: Vec<Route>,
    pub escalation: Option<Route>,
}
impl Policy {
    pub fn select<'a>(
        &'a self,
        phase: &str,
        explicit_selection: bool,
        escalate: bool,
        already_escalated: bool,
    ) -> Option<&'a Route> {
        if !self.enabled || explicit_selection {
            return None;
        }
        if escalate {
            if already_escalated {
                return None;
            }
            self.escalation.as_ref()
        } else {
            self.routes.iter().find(|r| r.phase == phase)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_choice_and_second_escalation_win() {
        let p = Policy {
            enabled: true,
            routes: vec![],
            escalation: Some(Route {
                phase: "debug".into(),
                provider: "openai".into(),
                model: "m".into(),
            }),
        };
        assert!(p.select("debug", true, true, false).is_none());
        assert!(p.select("debug", false, true, true).is_none());
        assert!(p.select("debug", false, true, false).is_some());
    }
}
