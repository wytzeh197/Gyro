//! Model-facing observations retain full backing data and return bounded pages.
use super::*;
use serde_json::{json, Value};

#[derive(Clone, Copy)]
pub(super) struct TextField<'a> {
    pub pointer: &'a str,
    pub window: &'a str,
    pub offset: &'a str,
    pub tail: bool,
}

pub(super) fn offset(arguments: &Value, name: &str) -> anyhow::Result<Option<usize>> {
    arguments
        .get(name)
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| {
                    anyhow::anyhow!("capability argument `{name}` must be a nonnegative integer")
                })
        })
        .transpose()
}

pub(super) fn offset_schema() -> Value {
    json!({"type":"integer","minimum":0,"description":"Character offset from the previous result's window. Reuse its nextOffset or previousOffset to read another page."})
}

pub(super) fn text_result(
    mut data: Value,
    fields: &[TextField<'_>],
    arguments: &Value,
) -> anyhow::Result<Value> {
    let max_bytes = workspace_result_byte_limit(arguments)?;
    data = redact_json_strings(data);
    let mut sources = Vec::new();
    for field in fields {
        let Some(text) = data.pointer(field.pointer).and_then(Value::as_str) else {
            continue;
        };
        let text = text.to_owned();
        let boundaries = text
            .char_indices()
            .map(|(index, _)| index)
            .chain(std::iter::once(text.len()))
            .collect::<Vec<_>>();
        let start = offset(arguments, field.offset)?.map(|start| start.min(boundaries.len() - 1));
        sources.push((*field, text, boundaries, start));
    }
    let update = |data: &mut Value, count: usize| {
        for (field, text, boundaries, requested_start) in &sources {
            let total = boundaries.len() - 1;
            let start = requested_start.unwrap_or_else(|| {
                if field.tail {
                    total.saturating_sub(count)
                } else {
                    0
                }
            });
            let end = start.saturating_add(count).min(total);
            if let Some(value) = data.pointer_mut(field.pointer) {
                *value = json!(&text[boundaries[start]..boundaries[end]]);
            }
            data[field.window] = json!({
                "offset": start, "returnedChars": end - start, "totalChars": total,
                "truncated": start > 0 || end < total,
                "nextOffset": (end < total).then_some(end),
                "previousOffset": (start > 0).then_some(start.saturating_sub(count.max(1))),
            });
        }
    };
    let (mut low, mut high) = (0, max_bytes);
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        update(&mut data, middle);
        if serde_json::to_vec(&data)?.len() <= max_bytes {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    update(&mut data, low);
    if serde_json::to_vec(&data)?.len() > max_bytes
        || (low == 0 && sources.iter().any(|(_, text, _, _)| !text.is_empty()))
    {
        anyhow::bail!("Observation metadata exceeds maxBytes; increase the byte budget");
    }
    Ok(data)
}

pub(super) fn array_result(mut data: Value, key: &str, max_bytes: usize) -> anyhow::Result<Value> {
    data = redact_json_strings(data);
    let original = data[key].as_array().cloned().unwrap_or_default();
    let offset = data["offset"].as_u64().unwrap_or(0);
    let total = data["total"].as_u64();
    let source_more = data["hasMore"].as_bool().unwrap_or(false);
    let update = |data: &mut Value, count: usize| {
        let next = offset.saturating_add(count as u64);
        data[key] = json!(&original[..count]);
        data["returned"] = json!(count);
        data["offset"] = json!(offset);
        let has_more = total.map_or(count < original.len() || source_more, |total| next < total);
        data["hasMore"] = json!(has_more);
        data["nextOffset"] = if has_more { json!(next) } else { Value::Null };
        data["truncated"] = json!(count < original.len() || has_more);
    };
    let (mut low, mut high) = (0, original.len());
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        update(&mut data, middle);
        if serde_json::to_vec(&data)?.len() <= max_bytes {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    update(&mut data, low);
    if serde_json::to_vec(&data)?.len() > max_bytes || (low == 0 && !original.is_empty()) {
        anyhow::bail!(
            "Observation entry exceeds maxBytes; narrow the request or increase the byte budget"
        );
    }
    Ok(data)
}

/// Git decorations can contain a second, unpaged file list larger than the
/// entire tool budget. Keep its totals, and page only the requested changes.
pub(super) fn git_status_result(mut data: Value, arguments: &Value) -> anyhow::Result<Value> {
    if let Some(object) = data.as_object_mut() {
        object.remove("history");
        object.remove("historyError");
    }
    if let Some(comparison) = data["comparedToMain"].as_object_mut() {
        if let Some(files) = comparison.remove("files") {
            comparison.insert(
                "fileCount".into(),
                json!(files.as_array().map_or(0, Vec::len)),
            );
            comparison.insert("filesOmitted".into(), json!(true));
        }
    }
    array_page(data, "files", arguments, 50, 500)
}

/// Page a retained array before applying the serialized byte budget. Entries
/// are kept whole, and nextOffset points into the same complete source array.
pub(super) fn array_page(
    mut data: Value,
    key: &str,
    arguments: &Value,
    default_limit: usize,
    maximum_limit: usize,
) -> anyhow::Result<Value> {
    let max_bytes = workspace_result_byte_limit(arguments)?;
    let start = offset(arguments, "offset")?.unwrap_or(0);
    let limit = offset(arguments, "limit")?
        .unwrap_or(default_limit)
        .clamp(1, maximum_limit);
    let entries = data[key]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Observation source `{key}` is not an array"))?;
    let total = entries.len();
    let page = entries
        .iter()
        .skip(start)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    data[key] = json!(page);
    data["offset"] = json!(start);
    data["total"] = json!(total);
    array_result(data, key, max_bytes)
}

pub(super) fn github_logs_result(
    run_id: u64,
    failed_only: bool,
    logs: String,
    arguments: &Value,
) -> anyhow::Result<Value> {
    text_result(
        json!({"runId": run_id, "failedOnly": failed_only, "logs": logs}),
        &[TextField {
            pointer: "/logs",
            window: "logsWindow",
            offset: "offset",
            tail: true,
        }],
        arguments,
    )
}

pub(super) fn schema(id: CapabilityId) -> Option<(Value, Vec<&'static str>)> {
    let properties = match id {
        CapabilityId::WorkspaceContext => json!({
            "section":{"type":"string","enum":["overview","diagnostics","testFailures","visibleTabs","buffers","activeOutput"],"default":"overview","description":"Overview returns roots, revisions, signal counts and output metadata. Choose a section for its complete paged evidence."},
            "offset":{"type":"integer","minimum":0},
            "limit":{"type":"integer","minimum":1,"maximum":1000,"default":20},
            "stdoutOffset":offset_schema(),"stderrOffset":offset_schema(),
            "maxBytes":workspace_result_bytes_schema()
        }),
        CapabilityId::WorkspaceDiagnostics => json!({
            "offset":{"type":"integer","minimum":0},
            "limit":{"type":"integer","minimum":1,"maximum":1000,"default":20},
            "maxBytes":workspace_result_bytes_schema()
        }),
        CapabilityId::GithubPullRequests => json!({
            "offset":{"type":"integer","minimum":0},
            "limit":{"type":"integer","minimum":1,"maximum":50,"default":20},
            "maxBytes":workspace_result_bytes_schema()
        }),
        CapabilityId::GithubWorkflowRuns => json!({
            "branch":{"type":"string"},
            "offset":{"type":"integer","minimum":0},
            "limit":{"type":"integer","minimum":1,"maximum":50,"default":20},
            "maxBytes":workspace_result_bytes_schema()
        }),
        CapabilityId::GithubWorkflowLogs => json!({
            "runId":{"type":"integer","minimum":1},
            "failedOnly":{"type":"boolean","default":true},
            "offset":offset_schema(),
            "maxBytes":workspace_result_bytes_schema()
        }),
        CapabilityId::WorkspaceGitStatus => {
            json!({"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":500,"default":50},"maxBytes":workspace_result_bytes_schema()})
        }
        CapabilityId::WorkspaceDiff => json!({
            "path": { "type": "string" },
            "staged": { "type": "boolean" },
            "stdoutOffset": offset_schema(), "stderrOffset": offset_schema(), "maxBytes": workspace_result_bytes_schema()
        }),
        CapabilityId::WorkspaceRunTask | CapabilityId::WorkspaceRunTest => json!({
            "taskId": { "type": "string" },
            "maxBytes": workspace_result_bytes_schema(),
            "stdoutOffset": offset_schema(),
            "stderrOffset": offset_schema(),
            "background": {
                "type": "boolean",
                "description": "Start the task in this chat's terminal and return immediately instead of waiting for it to exit. Use for dev servers, watchers, and other long-running commands, then wait for finite commands with gyro_terminal_wait, read output with gyro_terminal_read, or end it with gyro_terminal_stop."
            }
        }),
        CapabilityId::TerminalOpen => json!({
            "program": { "type": "string" },
            "args": { "type": "array", "items": { "type": "string" } },
            "cwd": { "type": "string" },
            "maxBytes": workspace_result_bytes_schema()
        }),
        CapabilityId::TerminalWait => json!({
            "knownOutputRevision": { "type":"integer","minimum":0,"description":"Output revision already received; unchanged output is omitted." },
            "outputOffset": offset_schema(),
            "maxBytes": workspace_result_bytes_schema(),
            "resourceId": { "type": "string", "description": "resource.id returned when this chat started the command" },
            "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 300000, "default": 60000, "description": "Maximum wait per call, up to 5 minutes. Prefer a long wait for builds. A running command keeps running; call wait again if needed." }
        }),
        CapabilityId::TerminalRead | CapabilityId::TerminalStop => json!({
            "knownOutputRevision": { "type":"integer","minimum":0,"description":"Output revision already received; unchanged output is omitted." },
            "outputOffset": offset_schema(),
            "maxBytes": workspace_result_bytes_schema()
        }),
        CapabilityId::WorkspaceReadOutput => json!({
            "outputId":{"type":"string","description":"Optional resource.id from a task this chat ran. Full task outputs are retained for up to 16 outputs and 16 MiB; omit for the active output channel."},
            "offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":1000,"default":20},
            "stdoutOffset": offset_schema(),
            "stderrOffset": offset_schema(),
            "maxBytes": workspace_result_bytes_schema()
        }),
        CapabilityId::BrowserReadPage => json!({
            "maxDepth": { "type": "integer", "minimum": 1, "maximum": 8 },
            "ref": { "type":"string","description":"Read one element subtree using a ref from read_page or find; use to expand omitted children." },
            "maxChars": { "type":"integer","minimum":1024,"maximum":48000,"default":6000 },
            "maxBytes": workspace_result_bytes_schema()
        }),
        CapabilityId::BrowserFind => json!({
            "query": { "type": "string" },
            "selector": { "type": "string" },
            "offset": { "type":"integer","minimum":0 }, "limit": { "type":"integer","minimum":1,"maximum":40,"default":20 },
            "maxBytes": workspace_result_bytes_schema()
        }),
        CapabilityId::BrowserConsole | CapabilityId::BrowserNetwork => json!({
            "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default":20 },
            "offset": { "type":"integer","minimum":0 },
            "maxBytes": workspace_result_bytes_schema()
        }),
        _ => return None,
    };
    let required = match id {
        CapabilityId::GithubWorkflowLogs => vec!["runId"],
        CapabilityId::WorkspaceDiff => vec!["path"],
        CapabilityId::WorkspaceRunTask | CapabilityId::WorkspaceRunTest => vec!["taskId"],
        CapabilityId::TerminalOpen => vec!["program"],
        CapabilityId::TerminalWait => vec!["resourceId"],
        _ => vec![],
    };
    Some((properties, required))
}

pub(super) fn page_limit(
    arguments: &Value,
    default: usize,
    maximum: usize,
) -> anyhow::Result<usize> {
    let limit = offset(arguments, "limit")?.unwrap_or(default);
    anyhow::ensure!(
        (1..=maximum).contains(&limit),
        "limit must be between 1 and {maximum}"
    );
    Ok(limit)
}

pub(super) fn browser_page_result(mut data: Value, max_bytes: usize) -> anyhow::Result<Value> {
    data = redact_json_strings(data);
    if let Some(page) = data.get_mut("page").and_then(Value::as_object_mut) {
        // These facts already occur in the observation envelope.
        for key in [
            "url",
            "title",
            "readyState",
            "viewport",
            "history",
            "framing",
            "ok",
        ] {
            page.remove(key);
        }
    }
    fn prune(node: &mut Value) -> bool {
        let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) else {
            return false;
        };
        let Some(last) = children.last_mut() else {
            return false;
        };
        if prune(last) {
            return true;
        }
        children.pop();
        let omitted = node["omittedChildren"].as_u64().unwrap_or(0);
        node["omittedChildren"] = json!(omitted + 1);
        true
    }
    while serde_json::to_vec(&data)?.len() > max_bytes {
        let pruned = data.pointer_mut("/page/tree").is_some_and(prune);
        if !pruned {
            anyhow::bail!("Browser page metadata exceeds maxBytes; increase the byte budget");
        }
        data["page"]["truncated"] = json!(true);
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_git_status_limit_and_invalid_page_limits_are_honored() {
        assert_eq!(page_limit(&json!({}), 50, 500).unwrap(), 50);
        assert_eq!(page_limit(&json!({"limit":500}), 50, 500).unwrap(), 500);
        for value in [json!(0), json!(501), json!("500"), json!(1.5)] {
            assert!(page_limit(&json!({"limit":value}), 50, 500).is_err());
        }
        let (_, required) = schema(CapabilityId::WorkspaceReadOutput).unwrap();
        assert!(required.is_empty());
    }

    #[test]
    fn git_status_pages_changes_without_unbounded_comparison_or_history() {
        let files = (0..120)
            .map(|index| json!({"path":format!("file-{index}.rs")}))
            .collect::<Vec<_>>();
        let source = json!({"files":files,"history":["large history".repeat(10_000)],"historyError":null,
            "comparedToMain":{"additions":42,"deletions":7,"partial":false,"files":vec![json!({"path":"long-path".repeat(100)}); 1000]}});
        let mut offset = 0;
        let mut collected = Vec::new();
        loop {
            let page = git_status_result(
                source.clone(),
                &json!({"offset":offset,"limit":75,"maxBytes":1024}),
            )
            .unwrap();
            assert!(serde_json::to_vec(&page).unwrap().len() <= 1024);
            assert!(page.get("history").is_none());
            assert_eq!(page["comparedToMain"]["fileCount"], 1000);
            assert_eq!(page["comparedToMain"]["additions"], 42);
            assert!(page["comparedToMain"].get("files").is_none());
            collected.extend(page["files"].as_array().unwrap().iter().cloned());
            let Some(next) = page["nextOffset"].as_u64() else {
                break;
            };
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(collected, files);
    }

    #[test]
    fn github_rows_keep_ids_urls_and_complete_pages_under_the_byte_budget() {
        for key in ["pullRequests", "runs"] {
            let rows = (0..50).map(|index| json!({"id":index,"number":index,"title":"🦀".repeat(500),"url":format!("https://github.com/owner/repo/item/{index}")})).collect::<Vec<_>>();
            let mut source = json!({"sourceLimit":50,"sourceMayHaveMore":true});
            source[key] = json!(rows);
            let mut start = 0;
            let mut collected = Vec::new();
            loop {
                let page = array_page(
                    source.clone(),
                    key,
                    &json!({"offset":start,"maxBytes":8192}),
                    20,
                    50,
                )
                .unwrap();
                assert_eq!(page["sourceLimit"], 50);
                assert_eq!(page["sourceMayHaveMore"], true);
                assert_eq!(page["total"], 50);
                assert!(serde_json::to_vec(&page).unwrap().len() <= 8192);
                collected.extend(page[key].as_array().unwrap().iter().cloned());
                let Some(next) = page["nextOffset"].as_u64() else {
                    break;
                };
                assert!(next > start);
                start = next;
            }
            assert_eq!(collected, rows);
        }
    }

    #[test]
    fn github_logs_preserve_late_failures_and_retrieve_earlier_evidence() {
        let logs = format!(
            "{}FINAL FAILURE after the old summary limit",
            "compile detail\n".repeat(3000)
        );
        let tail = github_logs_result(42, true, logs.clone(), &json!({})).unwrap();
        assert_eq!(tail["runId"], 42);
        assert_eq!(tail["failedOnly"], true);
        assert!(tail["logs"]
            .as_str()
            .unwrap()
            .ends_with("FINAL FAILURE after the old summary limit"));
        assert!(tail["logsWindow"]["previousOffset"].as_u64().unwrap() > 0);
        assert!(serde_json::to_vec(&tail).unwrap().len() <= DEFAULT_WORKSPACE_RESULT_BYTES);
        let first =
            github_logs_result(42, true, logs.clone(), &json!({"offset":0,"maxBytes":1024}))
                .unwrap();
        let first_text = first["logs"].as_str().unwrap();
        assert!(logs.starts_with(first_text));
        assert_eq!(
            first["logsWindow"]["nextOffset"].as_u64().unwrap(),
            first_text.chars().count() as u64
        );
        println!(
            "GitHub logs fixture: {} -> {} serialized bytes; late failure retained",
            serde_json::to_vec(&json!({"runId":42,"failedOnly":true,"logs":logs}))
                .unwrap()
                .len(),
            serde_json::to_vec(&tail).unwrap().len()
        );
    }

    #[test]
    fn terminal_sized_logs_return_tail_and_retrievable_unicode_pages() {
        let source = format!("{}FINAL FAILURE", "🦀 escaped \"line\"\n".repeat(30_000));
        let fields = [TextField {
            pointer: "/output",
            window: "outputWindow",
            offset: "outputOffset",
            tail: true,
        }];
        let last = text_result(json!({"output":source}), &fields, &json!({})).unwrap();
        assert!(last["output"].as_str().unwrap().ends_with("FINAL FAILURE"));
        assert!(serde_json::to_vec(&last).unwrap().len() <= DEFAULT_WORKSPACE_RESULT_BYTES);
        assert!(last["outputWindow"]["previousOffset"].as_u64().unwrap() > 0);
        let source = "🦀 escaped \"line\"\n".repeat(300);
        let mut cursor = 0;
        let mut reconstructed = String::new();
        loop {
            let page = text_result(
                json!({"output":source}),
                &fields,
                &json!({"outputOffset":cursor,"maxBytes":1024}),
            )
            .unwrap();
            reconstructed.push_str(page["output"].as_str().unwrap());
            let Some(next) = page["outputWindow"]["nextOffset"].as_u64() else {
                break;
            };
            assert!(next > cursor);
            cursor = next;
        }
        assert_eq!(reconstructed, source);
    }

    #[test]
    fn two_stream_output_reserves_evidence_from_both_streams() {
        let fields = [
            TextField {
                pointer: "/stdout",
                window: "stdoutWindow",
                offset: "stdoutOffset",
                tail: true,
            },
            TextField {
                pointer: "/stderr",
                window: "stderrWindow",
                offset: "stderrOffset",
                tail: true,
            },
        ];
        let data = text_result(
            json!({"stdout":"x".repeat(100_000),"stderr":"ERROR: final failure"}),
            &fields,
            &json!({}),
        )
        .unwrap();
        assert_eq!(data["stderr"], "ERROR: final failure");
        assert_eq!(data["stdoutWindow"]["truncated"], true);
        assert!(serde_json::to_vec(&data).unwrap().len() <= DEFAULT_WORKSPACE_RESULT_BYTES);
    }

    #[test]
    fn browser_tree_pages_keep_refs_and_mark_expandable_omissions() {
        let children = (0..200).map(|index| json!({"ref":format!("ref_{index}"),"role":"button","name":"🦀".repeat(120)})).collect::<Vec<_>>();
        let original = json!({"url":"https://example.com","title":"Example","page":{"url":"https://example.com","title":"Example","tree":{"ref":"root","role":"main","children":children}}});
        let bounded =
            browser_page_result(original.clone(), DEFAULT_WORKSPACE_RESULT_BYTES).unwrap();
        assert_eq!(bounded["page"]["tree"]["ref"], "root");
        assert_eq!(bounded["page"]["truncated"], true);
        assert!(bounded["page"]["tree"]["omittedChildren"].as_u64().unwrap() > 0);
        assert_eq!(bounded["page"]["tree"]["children"][0]["ref"], "ref_0");
        assert!(bounded["page"].get("url").is_none());
        assert!(serde_json::to_vec(&bounded).unwrap().len() <= DEFAULT_WORKSPACE_RESULT_BYTES);
    }

    #[test]
    fn observation_fixture_byte_reductions_keep_retrieval_metadata() {
        let log = json!({"pane":{"output":"x".repeat(512 * 1024),"outputRevision":7,"status":"exited","exitCode":1}});
        let bounded_log =
            terminal_capability::bound_terminal_result(log.clone(), &json!({})).unwrap();
        let task =
            json!({"stdout":"x".repeat(48_000),"stderr":"y".repeat(24_000),"status":"failed"});
        let bounded_task =
            terminal_capability::bound_command_result(task.clone(), &json!({})).unwrap();
        let diagnostics = json!({"entries":(0..50).map(|index|json!({"message":"x".repeat(2000),"timestamp":index})).collect::<Vec<_>>(),"total":50,"offset":0});
        let bounded_diagnostics = array_result(
            diagnostics.clone(),
            "entries",
            DEFAULT_WORKSPACE_RESULT_BYTES,
        )
        .unwrap();
        for (name, original, bounded) in [
            ("terminal", log, bounded_log),
            ("task", task, bounded_task),
            ("console", diagnostics, bounded_diagnostics),
        ] {
            let before = serde_json::to_vec(&original).unwrap().len();
            let after = serde_json::to_vec(&bounded).unwrap().len();
            println!("{name} fixture: {before} -> {after} serialized result bytes");
            assert!(after <= DEFAULT_WORKSPACE_RESULT_BYTES);
            assert!(after * 4 < before);
        }
    }
}
