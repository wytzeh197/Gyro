//! Content continuity never transfers provider credentials, session identifiers,
//! tool approval policies or execution authority.
use super::Error;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedChat {
    pub format: String,
    pub project_revision: Option<Uuid>,
    pub archive: crate::cloud_connection::v2::selection::Chat,
    pub unsupported: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Passed,
    Failed,
    NotChecked,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub source: String,
    pub observed_at: String,
    pub revision: Option<Uuid>,
    pub outcome: Outcome,
    pub observation: String,
    pub scope: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Handoff {
    pub goal: String,
    pub requirements: Vec<String>,
    pub project_revision: Option<Uuid>,
    pub changes: Vec<String>,
    pub evidence: Vec<Evidence>,
    pub agent_assertions: Vec<String>,
    pub unfinished: Vec<String>,
    pub questions: Vec<String>,
}
impl Handoff {
    pub fn reviewed_text(&self) -> Result<String, Error> {
        if self.goal.trim().is_empty() || serde_json::to_vec(self)?.len() > 256 * 1024 {
            return Err(Error::Limit);
        }
        let mut text = format!(
            "Goal\n{}\n\nProject revision\n{}\n",
            self.goal,
            self.project_revision
                .map(|v| v.to_string())
                .unwrap_or_else(|| "Not linked".into())
        );
        for (label, items) in [
            ("Requirements", &self.requirements),
            ("Relevant changes", &self.changes),
            ("Agent assertions (unverified)", &self.agent_assertions),
            ("Unfinished work", &self.unfinished),
            ("Open questions", &self.questions),
        ] {
            text.push_str(&format!("\n{label}\n"));
            for item in items {
                text.push_str(&format!("- {item}\n"));
            }
        }
        text.push_str("\nObserved checks\n");
        for e in &self.evidence {
            text.push_str(&format!(
                "- {:?}: {} | source: {} | time: {} | scope: {} | revision: {}\n",
                e.outcome,
                e.observation,
                e.source,
                e.observed_at,
                e.scope,
                e.revision
                    .map(|r| r.to_string())
                    .unwrap_or_else(|| "Not recorded".into())
            ));
        }
        text.push_str("\nReview this context before continuing in a fresh agent session with current local permissions. No credentials, tool approvals or provider session authority are transferred.\n");
        Ok(text)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatArchive {
    pub format: String,
    pub source_agent: String,
    pub messages: Vec<Message>,
    pub unsupported: Vec<String>,
    pub project_revision: Option<Uuid>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    pub role: String,
    pub text: String,
    pub source_id: String,
    pub attachments: Vec<String>,
}
impl ChatArchive {
    pub fn reviewed_context(&self) -> Result<String, Error> {
        if self.format != "gyro-chat-v1" || serde_json::to_vec(self)?.len() > 4 * 1024 * 1024 {
            return Err(Error::Limit);
        }
        let mut text = format!(
            "Saved chat from {}. Selected context only; start a fresh session.\n",
            self.source_agent
        );
        for m in &self.messages {
            if !["user", "assistant", "tool", "system"].contains(&m.role.as_str()) {
                return Err(Error::Integrity);
            }
            text.push_str(&format!(
                "\n[{}; source {}]\n{}\n",
                m.role, m.source_id, m.text
            ));
            if !m.attachments.is_empty() {
                text.push_str(
                    "Attachments remain in the original archive; review them separately.\n",
                );
            }
        }
        if !self.unsupported.is_empty() {
            text.push_str(&format!(
                "\nUnsupported content: {}\n",
                self.unsupported.join(", ")
            ));
        }
        Ok(text)
    }
}
