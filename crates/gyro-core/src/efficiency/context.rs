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

/// Replace earlier copies of large, identical disk-read evidence with a
/// reference to the newest copy still present in this request. Every read
/// really ran; tool-call order, results with changed hashes, and side effects
/// remain intact. Persisted history is untouched.
pub fn compact_duplicate_reads(messages: &mut [Value]) -> usize {
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    let mut latest = HashMap::<[u8; 32], String>::new();
    let mut saved = 0;
    for message in messages.iter_mut().rev() {
        if message["role"] != "tool" {
            continue;
        }
        let Some(text) = message["content"]
            .as_str()
            .filter(|text| text.len() >= 2048)
        else {
            continue;
        };
        let Ok(mut payload) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        if payload["status"] != "completed" {
            continue;
        }
        let result = &payload["result"];
        if !matches!(
            result["capabilityId"].as_str(),
            Some("workspace-read" | "workspace-read-range")
        ) {
            continue;
        }
        let data = &result["data"];
        if data["contentHash"].as_str().is_none() || data["content"].as_str().is_none() {
            continue;
        }
        let Some(call_id) = payload["callId"].as_str().map(str::to_owned) else {
            continue;
        };
        // Compare the whole evidence, including range, root resource, revision,
        // and truncation metadata. A hash alone cannot identify a read range.
        let fingerprint: [u8; 32] =
            Sha256::digest(serde_json::to_vec(result).unwrap_or_default()).into();
        if let Some(newest) = latest.get(&fingerprint) {
            payload["result"]["data"] = serde_json::json!({
                "evidenceOmitted": true,
                "sameEvidenceAsCallId": newest,
                "note": "Identical read evidence is retained in the later tool result in this request."
            });
            if let Ok(compact) = serde_json::to_string(&payload) {
                saved += text.len().saturating_sub(compact.len());
                message["content"] = Value::String(compact);
            }
        } else {
            latest.insert(fingerprint, call_id);
        }
    }
    saved
}

#[cfg(test)]
mod tests {
    use super::*;
    fn read_message(call: &str, hash: &str, line: u64, content: &str) -> Value {
        serde_json::json!({"role":"tool","tool_call_id":call,"content":serde_json::json!({
            "status":"completed","callId":call,"result":{"capabilityId":"workspace-read-range",
            "summary":"Read src/a.rs","resource":{"id":"workspace:chat:src/a.rs"},
            "data":{"path":"src/a.rs","contentHash":hash,"line":line,"content":content}}
        }).to_string()})
    }
    #[test]
    fn duplicate_reads_keep_newest_evidence_and_protocol_ids() {
        let text = "source evidence ".repeat(1000);
        let first = read_message("first", "hash", 1, &text);
        let newest = read_message("last", "hash", 1, &text);
        let mut messages = vec![
            first,
            serde_json::json!({"role":"assistant","content":"continue"}),
            newest.clone(),
        ];
        let saved = compact_duplicate_reads(&mut messages);
        assert!(saved > 14_000);
        assert_eq!(messages[2], newest);
        assert_eq!(messages[0]["tool_call_id"], "first");
        let reference: Value =
            serde_json::from_str(messages[0]["content"].as_str().unwrap()).unwrap();
        assert_eq!(reference["callId"], "first");
        assert_eq!(reference["result"]["data"]["sameEvidenceAsCallId"], "last");
        assert_eq!(compact_duplicate_reads(&mut messages), 0);
    }
    #[test]
    fn changed_reads_ranges_failures_and_actions_are_never_compacted() {
        let text = "source evidence ".repeat(1000);
        let mut messages = vec![
            read_message("a", "before", 1, &text),
            read_message("b", "after", 1, &text),
            read_message("c", "after", 2, &text),
            serde_json::json!({"role":"user","content":text}),
        ];
        for capability in [
            "workspace-edit",
            "browser-read-page",
            "workspace-read-editor",
        ] {
            let mut message = read_message(capability, "after", 1, &text);
            let mut payload: Value =
                serde_json::from_str(message["content"].as_str().unwrap()).unwrap();
            payload["result"]["capabilityId"] = Value::String(capability.into());
            message["content"] = Value::String(payload.to_string());
            messages.extend([message.clone(), message]);
        }
        let before = messages.clone();
        assert_eq!(compact_duplicate_reads(&mut messages), 0);
        assert_eq!(messages, before);
    }

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
