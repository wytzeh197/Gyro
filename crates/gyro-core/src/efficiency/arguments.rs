//! Recoverable replay of completed edits. This never changes an executing call.
use serde_json::Value;

const MIN_FIELD_BYTES: usize = 2_048;

/// Only completed, known edit tools may omit bulk arguments from old exchanges.
/// Keep identifiers, commands, unknown tools, failures and malformed JSON exact.
/// The original argument object must be persisted before any replacement.
///
/// A call that does not qualify stays in the transcript and is visited again
/// on every later owned request. Its argument body is parsed and copied only
/// after the paired result says that edit completed.
pub(super) fn retire(
    messages: &mut [Value],
    newest: usize,
    persist: impl Fn(&str, &str) -> bool,
) -> usize {
    let mut saved = 0;
    for index in 2..newest.min(messages.len()) {
        let (before, after) = messages.split_at_mut(index + 1);
        let message = &mut before[index];
        if message["role"] != "assistant" {
            continue;
        }
        let Some(calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) else {
            continue;
        };
        let replies: Vec<&Value> = after
            .iter()
            .take_while(|m| m["role"] != "assistant")
            .filter(|m| m["role"] == "tool")
            .collect();
        let call_count = calls.len();
        for (call_index, call) in calls.iter_mut().enumerate() {
            let Some(name) = call["function"]["name"].as_str() else {
                continue;
            };
            if !matches!(
                name,
                "gyro_workspace_propose_edit" | "gyro_workspace_edit" | "gyro_tool_invoke"
            ) {
                continue;
            }
            let encoded = match &call["function"]["arguments"] {
                Value::String(text) => {
                    if text.len() < MIN_FIELD_BYTES {
                        continue;
                    }
                    true
                }
                Value::Object(_) => false,
                _ => continue,
            };
            // Only the result paired with this call can establish completion.
            // Stop at the next assistant exchange so a later call cannot qualify it.
            let reply = match call.get("id") {
                Some(Value::String(id)) if !id.is_empty() => replies
                    .iter()
                    .copied()
                    .find(|m| m["tool_call_id"].as_str() == Some(id)),
                // Ollama has no call IDs. Its runner emits one result per call
                // in order; require the complete batch and matching outer name.
                None | Some(Value::Null) if replies.len() == call_count => replies
                    .get(call_index)
                    .copied()
                    .filter(|m| m["tool_call_id"].is_null() && m["tool_name"] == name),
                _ => None,
            };
            let Some(reported) = reply
                .and_then(|message| message["content"].as_str())
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .filter(|result| result["status"] == "completed" && result["error"].is_null())
                .and_then(|result| result["result"]["capabilityId"].as_str().map(str::to_owned))
            else {
                continue;
            };
            if !matches!(
                reported.as_str(),
                "workspace-propose-edit" | "workspace-edit"
            ) {
                continue;
            }
            if name != "gyro_tool_invoke" {
                let expected = match name {
                    "gyro_workspace_propose_edit" => "workspace-propose-edit",
                    "gyro_workspace_edit" => "workspace-edit",
                    _ => continue,
                };
                if reported != expected {
                    continue;
                }
            }
            let arguments = &call["function"]["arguments"];
            let parsed_string = if encoded {
                let Value::String(text) = arguments else {
                    continue;
                };
                match serde_json::from_str::<Value>(text) {
                    Ok(parsed) => Some(parsed),
                    Err(_) => continue,
                }
            } else {
                None
            };
            let view = parsed_string.as_ref().unwrap_or(arguments);
            let (tool, prefix) = if name == "gyro_tool_invoke" {
                (view["name"].as_str().unwrap_or_default(), "/arguments")
            } else {
                (name, "")
            };
            let (capability, field_names): (&str, &[&str]) = match tool {
                "gyro_workspace_propose_edit" => ("workspace-propose-edit", &["content"]),
                "gyro_workspace_edit" => ("workspace-edit", &["oldString", "newString"]),
                _ => continue,
            };
            if reported != capability {
                continue;
            }
            let fields: Vec<String> = field_names
                .iter()
                .map(|field| format!("{prefix}/{field}"))
                .filter(|pointer| {
                    view.pointer(pointer)
                        .and_then(Value::as_str)
                        .is_some_and(|text| text.len() >= MIN_FIELD_BYTES)
                })
                .collect();
            if fields.is_empty() {
                continue;
            }
            // The body is still the call's original bytes. Copy it only now,
            // for the spill address and the persisted record.
            let (original, mut parsed) = if encoded {
                let Value::String(text) = arguments else {
                    continue;
                };
                let Some(parsed) = parsed_string else {
                    continue;
                };
                (text.clone(), parsed)
            } else {
                (arguments.to_string(), arguments.clone())
            };
            let address = super::spill::address(capability, "arguments", &original);
            for pointer in fields {
                let Some(Value::String(text)) = parsed.pointer_mut(&pointer) else {
                    continue;
                };
                *text = format!(
                    "[Historical argument: {} bytes at {address}, JSON field {pointer}. Read with gyro_workspace_read; the tool result records the outcome.]",
                    text.len()
                );
            }
            let compact = parsed.to_string();
            if compact.len() >= original.len() {
                continue;
            }
            if !persist(&address, &original) {
                crate::provider_observation::efficiency_event(|e| {
                    e.spill_failures = e.spill_failures.saturating_add(1)
                });
                continue;
            }
            saved += original.len() - compact.len();
            call["function"]["arguments"] = if encoded {
                Value::String(compact)
            } else {
                parsed
            };
        }
    }
    saved
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn exchange(name: &str, arguments: Value) -> Vec<Value> {
        vec![
            json!({"role":"system","content":"instructions"}),
            json!({"role":"user","content":"make the edit"}),
            json!({"role":"assistant","tool_calls":[{
                "id":"call-1","type":"function","function":{"name":name,"arguments":arguments}
            }]}),
            json!({"role":"tool","tool_call_id":"call-1","content":json!({
                "status":"completed","callId":"broker-id",
                "result":{"capabilityId":"workspace-propose-edit","data":{"status":"pending"}}
            }).to_string()}),
            json!({"role":"assistant","content":"Review the proposed edit."}),
        ]
    }

    fn args(messages: &[Value]) -> &Value {
        &messages[2]["tool_calls"][0]["function"]["arguments"]
    }

    #[test]
    fn completed_edits_are_recoverable_in_both_wire_formats_and_catalog_modes() {
        let temp = tempfile::tempdir().unwrap();
        let store = super::super::spill::SpillStore::new(temp.path());
        for encoded in [false, true] {
            for wrapped in [false, true] {
                let edit = json!({
                    "path":format!("{}source.rs", "long-folder/".repeat(30)),
                    "content":"fn café() {}\n".repeat(5000),
                    "expectedHash":"a".repeat(64),
                    "documentVersion":"revision-".repeat(40),"rootId":"project"
                });
                let original = if wrapped {
                    json!({"name":"gyro_workspace_propose_edit","arguments":edit})
                } else {
                    edit.clone()
                };
                let wire = if encoded {
                    json!(original.to_string())
                } else {
                    original.clone()
                };
                let name = if wrapped {
                    "gyro_tool_invoke"
                } else {
                    "gyro_workspace_propose_edit"
                };
                let mut messages = exchange(name, wire.clone());
                let before = messages.clone();
                let saved = retire(&mut messages, 4, |address, text| {
                    store.save(address, text).is_ok()
                });
                let compact: Value = if encoded {
                    serde_json::from_str(args(&messages).as_str().unwrap()).unwrap()
                } else {
                    args(&messages).clone()
                };
                let data = if wrapped {
                    &compact["arguments"]
                } else {
                    &compact
                };
                for key in ["path", "expectedHash", "documentVersion", "rootId"] {
                    assert_eq!(data[key], edit[key], "{key}");
                }
                let marker = data["content"].as_str().unwrap();
                let address = marker
                    .split_whitespace()
                    .find(|s| s.starts_with("spill://"))
                    .unwrap()
                    .trim_end_matches(',');
                let recovered: Value =
                    serde_json::from_str(&store.load(address).unwrap().unwrap()).unwrap();
                assert_eq!(recovered, original);
                assert!(marker.contains(if wrapped {
                    "/arguments/content"
                } else {
                    "/content"
                }));
                assert_eq!(
                    saved,
                    original.to_string().len() - compact.to_string().len()
                );
                // More than 95% less argument text in this fixture; not billed-token savings.
                assert!(saved * 100 > original.to_string().len() * 95);
                for index in [0, 1, 3, 4] {
                    assert_eq!(messages[index], before[index]);
                }
                let call = &messages[2]["tool_calls"][0];
                assert_eq!(call["id"], "call-1");
                assert_eq!(call["function"]["name"], name);
                assert_eq!(
                    retire(&mut messages, 4, |_, _| panic!("already retired")),
                    0
                );
            }
        }
    }

    #[test]
    fn disk_failure_keeps_every_argument_byte() {
        let original = json!({"path":"a.rs","content":"x".repeat(16_000)});
        let mut messages = exchange("gyro_workspace_propose_edit", json!(original.to_string()));
        let before = messages.clone();
        assert_eq!(retire(&mut messages, 4, |_, _| false), 0);
        assert_eq!(messages, before);
    }

    #[test]
    fn failures_unknown_tools_and_malformed_arguments_stay_exact() {
        let original = json!({"path":"a.rs","content":"x".repeat(4000)});
        for case in 0..10 {
            let mut messages = exchange("gyro_workspace_propose_edit", json!(original.to_string()));
            let mut result: Value =
                serde_json::from_str(messages[3]["content"].as_str().unwrap()).unwrap();
            match case {
                0 => result["status"] = json!("failed"),
                1 => result["status"] = json!("denied"),
                2 => result["status"] = json!("cancelled"),
                3 => result["error"] = json!({"message":"edit failed"}),
                4 => messages[3]["tool_call_id"] = json!("different-call"),
                5 => result["result"]["capabilityId"] = json!("workspace-read"),
                6 => messages[2]["tool_calls"][0]["function"]["name"] = json!("unknown_write"),
                7 => {
                    messages[2]["tool_calls"][0]["function"]["arguments"] = json!("{".repeat(3000))
                }
                8 => {
                    messages[2]["tool_calls"][0]["function"]["arguments"] =
                        json!([original.clone()])
                }
                9 => messages[3]["role"] = json!("user"),
                _ => unreachable!(),
            }
            messages[3]["content"] = json!(result.to_string());
            let before = messages.clone();
            assert_eq!(
                retire(&mut messages, 4, |_, _| panic!("must stay intact: {case}")),
                0
            );
            assert_eq!(messages, before, "case {case}");
        }
    }

    #[test]
    fn failed_object_arguments_stay_exact() {
        let original = json!({"path":"a.rs","content":"x".repeat(16_000)});
        let mut messages = exchange("gyro_workspace_propose_edit", original);
        let mut result: Value =
            serde_json::from_str(messages[3]["content"].as_str().unwrap()).unwrap();
        result["status"] = json!("failed");
        messages[3]["content"] = json!(result.to_string());
        let before = messages.clone();
        assert_eq!(
            retire(&mut messages, 4, |_, _| panic!("failed object edit")),
            0
        );
        assert_eq!(messages, before);
    }

    #[test]
    fn commands_searches_and_small_edits_keep_long_values() {
        for (name, arguments) in [
            (
                "gyro_terminal_open",
                json!({"command":"verify-important-case ".repeat(300)}),
            ),
            (
                "gyro_workspace_search",
                json!({"query":"specific pattern ".repeat(300)}),
            ),
            (
                "gyro_workspace_edit",
                json!({"path":"long-path/".repeat(300),"oldString":"old","newString":"new"}),
            ),
        ] {
            let mut messages = exchange(name, arguments);
            if name == "gyro_workspace_edit" {
                messages[3]["content"] =
                    json!({"status":"completed","result":{"capabilityId":"workspace-edit"}})
                        .to_string()
                        .into();
            }
            let before = messages.clone();
            assert_eq!(
                retire(&mut messages, 4, |_, _| panic!("must stay intact")),
                0
            );
            assert_eq!(messages, before);
        }
    }

    #[test]
    fn string_edits_recover_both_sides_from_one_copy() {
        let original = json!({"path":"a.rs","oldString":"old\n".repeat(10_000),"newString":"new\n".repeat(10_000),"replaceAll":true});
        let mut messages = exchange("gyro_workspace_edit", original.clone());
        messages[3]["content"] =
            json!({"status":"completed","result":{"capabilityId":"workspace-edit"}})
                .to_string()
                .into();
        let writes = std::cell::Cell::new(0);
        let saved = retire(&mut messages, 4, |_, text| {
            assert_eq!(serde_json::from_str::<Value>(text).unwrap(), original);
            writes.set(writes.get() + 1);
            true
        });
        assert_eq!(writes.get(), 1);
        assert_eq!(args(&messages)["replaceAll"], true);
        assert!(args(&messages)["oldString"]
            .as_str()
            .unwrap()
            .contains("/oldString"));
        assert!(args(&messages)["newString"]
            .as_str()
            .unwrap()
            .contains("/newString"));
        assert!(saved > 99_000);
        println!(
            "Completed string-edit arguments: {} -> {} JSON bytes; exact copy retained",
            original.to_string().len(),
            args(&messages).to_string().len()
        );
    }

    #[test]
    fn newest_exchange_and_unanswered_calls_stay_exact() {
        let mut messages = exchange(
            "gyro_workspace_propose_edit",
            json!({"content":"x".repeat(4000)}),
        );
        let before = messages.clone();
        assert_eq!(retire(&mut messages, 2, |_, _| panic!("newest")), 0);
        assert_eq!(messages, before);
        // A result beyond another assistant exchange cannot validate the old call.
        messages.insert(3, json!({"role":"assistant","content":"another exchange"}));
        let before = messages.clone();
        assert_eq!(retire(&mut messages, 5, |_, _| panic!("unanswered")), 0);
        assert_eq!(messages, before);
    }

    #[test]
    fn ollama_same_name_calls_use_ordered_outcomes_without_inventing_ids() {
        let first = json!({"name":"gyro_workspace_propose_edit","arguments":{"path":"failed.rs","content":"failed edit".repeat(1000)}});
        let second = json!({"name":"gyro_workspace_propose_edit","arguments":{"path":"ok.rs","content":"successful edit".repeat(1000)}});
        let mut messages = exchange("gyro_tool_invoke", first.clone());
        messages[2]["tool_calls"] = json!([
            {"function":{"name":"gyro_tool_invoke","arguments":first}},
            {"function":{"name":"gyro_tool_invoke","arguments":second}}
        ]);
        messages[3] = json!({"role":"tool","tool_name":"gyro_tool_invoke","content":json!({"status":"failed","error":{"message":"conflict"}}).to_string()});
        messages.insert(4, json!({"role":"tool","tool_name":"gyro_tool_invoke","content":json!({"status":"completed","result":{"capabilityId":"workspace-propose-edit"}}).to_string()}));
        let before = messages.clone();
        assert!(
            retire(&mut messages, 5, |_, text| {
                assert_eq!(serde_json::from_str::<Value>(text).unwrap(), second);
                true
            }) > 10_000
        );
        assert_eq!(messages[2]["tool_calls"][0], before[2]["tool_calls"][0]);
        assert!(messages[2]["tool_calls"][1].get("id").is_none());
        assert_eq!(&messages[3..], &before[3..]);
        for missing in [false, true] {
            let mut messages = before.clone();
            if missing {
                messages.remove(3);
            } else {
                messages[4]["tool_name"] = json!("different-tool");
            }
            let expected = messages.clone();
            let newest = messages.len() - 1;
            assert_eq!(retire(&mut messages, newest, |_, _| panic!("unpaired")), 0);
            assert_eq!(messages, expected);
        }
    }
}
