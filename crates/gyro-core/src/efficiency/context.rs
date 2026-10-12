use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attribution {
    pub instructions: u64,
    pub tool_schemas: u64,
    pub source_excerpts: u64,
    pub tool_results: u64,
    pub task_state: u64,
    pub history: u64,
    pub other_text: u64,
    pub estimated_tokens: u64,
    pub hidden_content: bool,
}
impl Attribution {
    pub fn from_request(payload: &Value) -> Self {
        let mut a = Self::default();
        a.tool_schemas = payload.get("tools").map_or(0, |v| {
            serde_json::to_string(v).unwrap_or_default().chars().count() as u64
        });
        if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
            for message in messages {
                let role = message["role"].as_str().unwrap_or_default();
                let content = &message["content"];
                let text = if let Some(s) = content.as_str() {
                    s.to_owned()
                } else if let Some(parts) = content.as_array() {
                    let mut strings = Vec::new();
                    for part in parts {
                        if let Some(t) = part.get("text").and_then(Value::as_str) {
                            strings.push(t);
                        } else {
                            a.hidden_content = true;
                        }
                    }
                    strings.join("\n")
                } else {
                    String::new()
                };
                if message
                    .get("images")
                    .and_then(Value::as_array)
                    .is_some_and(|x| !x.is_empty())
                {
                    a.hidden_content = true;
                }
                let n = text.chars().count() as u64;
                match role {
                    "system" | "developer" => a.instructions += n,
                    "tool" => {
                        let source = serde_json::from_str::<Value>(&text)
                            .ok()
                            .and_then(|v| {
                                v.pointer("/result/capabilityId")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                            })
                            .is_some_and(|id| {
                                matches!(
                                    id.as_str(),
                                    "workspace-read"
                                        | "workspace-read-range"
                                        | "workspace-read-editor"
                                )
                            });
                        if source {
                            a.source_excerpts += n;
                        } else {
                            a.tool_results += n;
                        }
                    }
                    "assistant" => a.history += n,
                    _ => {
                        // Only typed Gyro blocks carry a reliable category. Do not classify arbitrary source by keywords.
                        match message.get("gyroCategory").and_then(Value::as_str) {
                            Some("source") => a.source_excerpts += n,
                            Some("task-state") => a.task_state += n,
                            Some("history") => a.history += n,
                            _ => a.other_text += n,
                        }
                    }
                }
            }
        }
        a.estimated_tokens = (a.instructions
            + a.tool_schemas
            + a.source_excerpts
            + a.tool_results
            + a.task_state
            + a.history
            + a.other_text)
            .div_ceil(4);
        a
    }
    pub fn combine(&mut self, other: &Self) {
        self.instructions += other.instructions;
        self.tool_schemas += other.tool_schemas;
        self.source_excerpts += other.source_excerpts;
        self.tool_results += other.tool_results;
        self.task_state += other.task_state;
        self.history += other.history;
        self.other_text += other.other_text;
        self.estimated_tokens += other.estimated_tokens;
        self.hidden_content |= other.hidden_content;
    }
}
/// Sort definitions without changing messages or removing constraints. Wire payloads contain no private annotations.
pub fn stable_tools(tools: &mut [Value]) {
    tools.sort_by_key(|v| {
        v.pointer("/function/name")
            .or_else(|| v.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excludes_encoded_images() {
        let a = Attribution::from_request(
            &serde_json::json!({"messages":[{"role":"system","content":"1234"},{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:abc"}}]}]}),
        );
        assert_eq!(a.instructions, 4);
        assert!(a.hidden_content);
        assert_eq!(a.estimated_tokens, 1);
    }
}
