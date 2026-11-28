//! Small workspace overviews and retrievable pages of live IDE evidence.
use super::*;
use serde_json::{json, Value};

const COLLECTIONS: [&str; 4] = ["diagnostics", "testFailures", "visibleTabs", "buffers"];

pub(super) fn result(
    context: &WorkspaceContextSnapshot,
    bound_revision: u64,
    identity: Option<Value>,
    arguments: &Value,
) -> anyhow::Result<Value> {
    let max_bytes = workspace_result_byte_limit(arguments)?;
    capability_output_budget::offset(arguments, "offset")?;
    let section = arguments.get("section").map_or(Ok("overview"), |value| {
        value
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Workspace context section must be a string"))
    })?;
    anyhow::ensure!(
        section == "overview" || section == "activeOutput" || COLLECTIONS.contains(&section),
        "Unknown Workspace context section"
    );
    let mut data = serde_json::to_value(workspace_context_metadata(context))?;
    // Metadata leaves `activeOutput` null so task logs are not serialized.
    // Drop that placeholder; sections below put back only what they return.
    data.as_object_mut().unwrap().remove("activeOutput");
    data["boundRevision"] = json!(bound_revision);
    data["stale"] = json!(context.revision != bound_revision);
    data["section"] = json!(section);
    if let Some(identity) = identity {
        data["workspaceIdentity"] = identity;
    }
    let mut counts = serde_json::Map::new();
    let mut selected = Value::Null;
    for key in COLLECTIONS {
        let values = data
            .as_object_mut()
            .unwrap()
            .remove(key)
            .unwrap_or_else(|| json!([]));
        counts.insert(key.into(), json!(values.as_array().map_or(0, Vec::len)));
        if section == key {
            selected = values;
        }
    }
    let has_output = context
        .active_output
        .as_ref()
        .is_some_and(|output| !output.is_null());
    counts.insert("activeOutput".into(), json!(has_output));
    data["sectionCounts"] = Value::Object(counts);
    if COLLECTIONS.contains(&section) {
        data[section] = selected;
        return capability_output_budget::array_page(data, section, arguments, 20, 1000);
    }
    if section == "activeOutput" {
        let output = context.active_output.clone().unwrap_or(Value::Null);
        if let Some(lines) = output.get("lines").and_then(Value::as_array) {
            data["lines"] = json!(lines);
            let mut metadata = output;
            metadata.as_object_mut().unwrap().remove("lines");
            data["activeOutput"] = metadata;
            return capability_output_budget::array_page(data, "lines", arguments, 20, 1000);
        }
        data["activeOutput"] = output;
        return capability_output_budget::text_result(
            data,
            &[
                capability_output_budget::TextField {
                    pointer: "/activeOutput/stdout",
                    window: "stdoutWindow",
                    offset: "stdoutOffset",
                    tail: true,
                },
                capability_output_budget::TextField {
                    pointer: "/activeOutput/stderr",
                    window: "stderrWindow",
                    offset: "stderrOffset",
                    tail: true,
                },
            ],
            arguments,
        );
    }
    // An overview carries output identity and status. The activeOutput section
    // retains every source line. Copy the small fields only; stdout and stderr
    // stay borrowed for the character count.
    match context.active_output.as_ref() {
        Some(Value::Object(source)) => {
            let mut metadata = serde_json::Map::new();
            let mut lines = None;
            let mut stdout = None;
            let mut stderr = None;
            for (key, value) in source {
                match key.as_str() {
                    "lines" => lines = Some(value),
                    "stdout" => stdout = Some(value),
                    "stderr" => stderr = Some(value),
                    _ => {
                        metadata.insert(key.clone(), value.clone());
                    }
                }
            }
            if let Some(lines) = lines {
                metadata.insert(
                    "totalLines".into(),
                    json!(lines.as_array().map_or(0, Vec::len)),
                );
            }
            for (key, text) in [("stdout", stdout), ("stderr", stderr)] {
                if let Some(text) = text {
                    metadata.insert(
                        format!("{key}Chars"),
                        json!(text.as_str().map_or(0, |text| text.chars().count())),
                    );
                }
            }
            data["activeOutput"] = Value::Object(metadata);
        }
        Some(other) => data["activeOutput"] = other.clone(),
        None => data["activeOutput"] = Value::Null,
    }
    let data = redact_json_strings(data);
    anyhow::ensure!(
        serde_json::to_vec(&data)?.len() <= max_bytes,
        "Workspace context metadata exceeds maxBytes; increase the byte budget"
    );
    Ok(data)
}

pub(super) fn diagnostics(
    context: &WorkspaceContextSnapshot,
    bound_revision: u64,
    arguments: &Value,
) -> anyhow::Result<Value> {
    let mut arguments = Value::Object(arguments.as_object().cloned().unwrap_or_default());
    arguments["section"] = "diagnostics".into();
    result(context, bound_revision, None, &arguments)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> WorkspaceContextSnapshot {
        let mut context = WorkspaceContextSnapshot::empty("/workspace");
        context.revision = 12;
        context.diagnostics = (0..50).map(|index| json!({"path":"src/main.rs","message":format!("Issue {index}: {}", "🦀".repeat(500)),"line":index+1})).collect();
        context.test_failures = (0..5)
            .map(|index| json!({"id":format!("test-{index}"),"message":"Failure detail"}))
            .collect();
        context.buffers =
            vec![json!({"path":"main.rs","content":"unsaved private text","dirty":true})];
        context.active_output = Some(
            json!({"taskId":"verify","status":"failed","stdout":"x".repeat(100_000),"stderr":"FINAL FAILURE"}),
        );
        context
    }

    #[test]
    fn overview_keeps_identity_revisions_and_output_status_without_full_evidence() {
        let context = context();
        let identity = json!({"revision":7,"roots":[{"id":"root-a","path":"/workspace"},{"id":"root-b","path":"/other"}]});
        let page = result(&context, 11, Some(identity.clone()), &json!({})).unwrap();
        assert_eq!(page["workspaceIdentity"], identity);
        assert_eq!(page["revision"], 12);
        assert_eq!(page["boundRevision"], 11);
        assert_eq!(page["stale"], true);
        assert_eq!(page["sectionCounts"]["diagnostics"], 50);
        assert_eq!(page["sectionCounts"]["testFailures"], 5);
        assert_eq!(page["activeOutput"]["status"], "failed");
        assert_eq!(page["activeOutput"]["stdoutChars"], 100_000);
        assert!(page["activeOutput"].get("stdout").is_none());
        assert!(serde_json::to_vec(&page).unwrap().len() <= DEFAULT_WORKSPACE_RESULT_BYTES);
        assert_eq!(context.diagnostics.len(), 50);
        assert_eq!(
            context.active_output.as_ref().unwrap()["stdout"]
                .as_str()
                .unwrap()
                .len(),
            100_000
        );
        println!(
            "Workspace context fixture: {} -> {} serialized bytes",
            serde_json::to_vec(&context).unwrap().len(),
            serde_json::to_vec(&page).unwrap().len()
        );
    }

    #[test]
    fn overview_counts_scalars_without_keeping_task_logs() {
        let mut context = context();
        let stdout = format!("{}{}", "x".repeat(1000), "🦀".repeat(3));
        assert_eq!(stdout.chars().count(), 1003);
        assert_ne!(stdout.len(), 1003);
        context.active_output = Some(json!({
            "taskId": "verify",
            "status": "failed",
            "stdout": stdout,
            "stderr": "line\n",
            "lines": ["one", "two"],
        }));
        let metadata = workspace_context_metadata(&context);
        assert!(metadata.active_output.is_none());
        let page = result(&context, 12, None, &json!({})).unwrap();
        assert_eq!(page["activeOutput"]["taskId"], "verify");
        assert_eq!(page["activeOutput"]["status"], "failed");
        assert_eq!(page["activeOutput"]["stdoutChars"], 1003);
        assert_eq!(page["activeOutput"]["stderrChars"], 5);
        assert_eq!(page["activeOutput"]["totalLines"], 2);
        assert!(page["activeOutput"].get("stdout").is_none());
        assert!(page["activeOutput"].get("stderr").is_none());
        assert!(page["activeOutput"].get("lines").is_none());
        assert_eq!(page["sectionCounts"]["activeOutput"], true);
        assert_eq!(
            context.active_output.as_ref().unwrap()["stdout"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            1003
        );
        let diagnostics = result(
            &context,
            12,
            None,
            &json!({"section":"diagnostics","limit":1,"maxBytes":8192}),
        )
        .unwrap();
        assert!(diagnostics.get("activeOutput").is_none());
        assert!(!diagnostics.to_string().contains(&"x".repeat(1000)));
    }

    #[test]
    fn overview_counts_non_string_output_fields_as_zero() {
        let mut context = context();
        context.active_output = Some(json!({
            "taskId": "verify",
            "stdout": 5,
            "stderr": ["a"],
            "lines": "nope",
        }));
        let page = result(&context, 12, None, &json!({})).unwrap();
        assert_eq!(page["activeOutput"]["stdoutChars"], 0);
        assert_eq!(page["activeOutput"]["stderrChars"], 0);
        assert_eq!(page["activeOutput"]["totalLines"], 0);
        assert!(page["activeOutput"].get("stdout").is_none());
        assert!(page["activeOutput"].get("stderr").is_none());
        assert!(page["activeOutput"].get("lines").is_none());
        assert_eq!(page["activeOutput"]["taskId"], "verify");

        context.active_output = Some(json!("not-an-object"));
        let page = result(&context, 12, None, &json!({})).unwrap();
        assert_eq!(page["activeOutput"], "not-an-object");
        assert_eq!(page["sectionCounts"]["activeOutput"], true);

        context.active_output = None;
        let page = result(&context, 12, None, &json!({})).unwrap();
        assert!(page["activeOutput"].is_null());
        assert_eq!(page["sectionCounts"]["activeOutput"], false);
    }

    #[test]
    fn context_sections_page_all_evidence_without_mutating_live_state() {
        let context = context();
        let mut collected = Vec::new();
        let mut offset = 0;
        loop {
            let page = diagnostics(
                &context,
                12,
                &json!({"offset":offset,"limit":50,"maxBytes":8192}),
            )
            .unwrap();
            assert_eq!(page["revision"], 12);
            assert_eq!(page["stale"], false);
            assert!(serde_json::to_vec(&page).unwrap().len() <= 8192);
            collected.extend(page["diagnostics"].as_array().unwrap().iter().cloned());
            let Some(next) = page["nextOffset"].as_u64() else {
                break;
            };
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(collected, context.diagnostics);
        let buffers = result(&context, 12, None, &json!({"section":"buffers"})).unwrap();
        assert_eq!(buffers["buffers"][0]["path"], "main.rs");
        assert!(buffers["buffers"][0].get("content").is_none());
        assert_eq!(context.buffers[0]["content"], "unsaved private text");
        let output = result(&context, 12, None, &json!({"section":"activeOutput"})).unwrap();
        assert_eq!(output["activeOutput"]["stderr"], "FINAL FAILURE");
        assert_eq!(output["stdoutWindow"]["truncated"], true);
        assert!(output["stdoutWindow"]["previousOffset"].as_u64().unwrap() > 0);
    }

    #[test]
    fn output_channel_lines_are_all_retrievable() {
        let mut context = context();
        let lines = (0..50)
            .map(|index| format!("line-{index}"))
            .collect::<Vec<_>>();
        context.active_output = Some(json!({"id":"channel","label":"Output","lines":lines}));
        let page = result(
            &context,
            12,
            None,
            &json!({"section":"activeOutput","offset":20,"limit":20}),
        )
        .unwrap();
        assert_eq!(page["activeOutput"]["id"], "channel");
        assert_eq!(page["lines"][0], "line-20");
        assert_eq!(page["nextOffset"], 40);
        assert_eq!(page["total"], 50);
    }
}
