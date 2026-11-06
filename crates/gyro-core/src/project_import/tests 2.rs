use super::*;
use crate::sessions::SessionEventKind;
use serde_json::{json, Value};
use std::io::Write;
use tempfile::TempDir;

fn fixture(
    kind: SourceKind,
    name: &str,
    contents: &str,
) -> (TempDir, ProjectImportScanRequest, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("provider");
    let workspace = temp.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let root = home.join(match kind {
        SourceKind::ClaudeCode => "projects/incorrect-encoded-path",
        SourceKind::Codex => "sessions/2026/01/02",
    });
    fs::create_dir_all(&root).unwrap();
    let path = root.join(format!("{name}.jsonl"));
    fs::write(
        &path,
        contents.replace("/fixture/project", &workspace.to_string_lossy()),
    )
    .unwrap();
    let request = ProjectImportScanRequest {
        claude_data_home: Some(
            if kind == SourceKind::ClaudeCode {
                home.clone()
            } else {
                temp.path().join("absent")
            }
            .to_string_lossy()
            .into_owned(),
        ),
        codex_data_home: Some(
            if kind == SourceKind::Codex {
                home
            } else {
                temp.path().join("absent")
            }
            .to_string_lossy()
            .into_owned(),
        ),
        include_archived: false,
    };
    (temp, request, path)
}

fn only_import(request: ProjectImportScanRequest) -> NormalizedProjectImport {
    let scan = discover_project_imports(request).unwrap();
    assert_eq!(scan.candidates.len(), 1, "{:?}", scan.diagnostics);
    normalize_project_import(&scan.candidates[0]).unwrap()
}

#[test]
fn claude_preserves_selected_branch_tools_dates_and_turn_identity() {
    let (temp, request, _) = fixture(
        SourceKind::ClaudeCode,
        "conversation",
        include_str!("fixtures/claude-branches.jsonl"),
    );
    let import = only_import(request);
    assert_eq!(import.candidate.title, "Retry limit");
    assert_eq!(
        import.candidate.workspace_path,
        temp.path().join("workspace").to_string_lossy()
    );
    assert_eq!(
        import.candidate.model_id.as_deref(),
        Some("claude-sonnet-4-5")
    );
    assert_eq!(
        import.candidate.created_at.to_rfc3339(),
        "2026-01-01T12:00:00+00:00"
    );
    assert_eq!(
        import.candidate.updated_at.to_rfc3339(),
        "2026-01-01T12:00:04+00:00"
    );
    let text = import
        .events
        .iter()
        .map(|event| event.message.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!text.contains("Discarded branch"));
    assert!(!text.contains("Subagent-only"));
    assert!(!text.contains("PRIVATE"));
    assert!(text.contains("The selected reply."));
    assert_eq!(
        import.events[0].turn_id.unwrap().to_string(),
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );
    let tool = import
        .events
        .iter()
        .find(|event| matches!(event.kind, SessionEventKind::SystemEvent))
        .unwrap();
    assert_eq!(tool.payload["activityKind"], "tool");
    assert_eq!(tool.payload["status"], "done");
    assert_eq!(tool.payload["historical"], true);
    assert!(tool.payload["detail"]
        .as_str()
        .unwrap()
        .contains("const retries"));
}

#[test]
fn claude_keeps_original_history_across_compaction_without_displaying_generated_context() {
    let mut contents = include_str!("fixtures/claude-branches.jsonl").to_owned();
    for record in [
        json!({"type":"system", "subtype":"compact_boundary", "uuid":"compact", "parentUuid":null, "logicalParentUuid":"chosen-branch", "timestamp":"2026-01-01T12:00:05Z", "content":"PRIVATE COMPACTION CONTEXT"}),
        json!({"type":"user", "uuid":"summary", "parentUuid":"compact", "sessionId":"11111111-1111-4111-8111-111111111111", "cwd":"/fixture/project", "timestamp":"2026-01-01T12:00:06Z", "isCompactSummary":true, "isVisibleInTranscriptOnly":true, "message":{"role":"user", "content":"PRIVATE GENERATED SUMMARY"}}),
        json!({"type":"user", "uuid":"u2", "parentUuid":"summary", "sessionId":"11111111-1111-4111-8111-111111111111", "cwd":"/fixture/project", "timestamp":"2026-01-01T12:00:07Z", "message":{"role":"user", "content":"Check another loop"}}),
        json!({"type":"assistant", "uuid":"a2", "parentUuid":"u2", "sessionId":"11111111-1111-4111-8111-111111111111", "timestamp":"2026-01-01T12:00:08Z", "message":{"id":"msg-2", "role":"assistant", "content":"The second loop is checked."}}),
    ] {
        contents.push_str(&format!("{record}\n"));
    }
    let (_temp, request, _) = fixture(SourceKind::ClaudeCode, "compacted", &contents);
    let import = only_import(request);
    let visible = import
        .events
        .iter()
        .map(|event| event.message.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        visible,
        [
            "Add a retry limit",
            "I will inspect the retry loop.",
            "Read",
            "The selected reply.",
            "Check another loop",
            "The second loop is checked."
        ]
    );
    assert_eq!(
        import.candidate.created_at.to_rfc3339(),
        "2026-01-01T12:00:00+00:00"
    );
    assert_eq!(
        import.candidate.updated_at.to_rfc3339(),
        "2026-01-01T12:00:08+00:00"
    );
    assert!(!serde_json::to_string(&import.events)
        .unwrap()
        .contains("PRIVATE"));
}

#[test]
fn codex_deduplicates_messages_and_ignores_hidden_instructions_reasoning_usage() {
    let (_temp, request, _) = fixture(
        SourceKind::Codex,
        "modern",
        include_str!("fixtures/codex-modern.jsonl"),
    );
    let import = only_import(request);
    assert_eq!(import.events.len(), 3);
    assert_eq!(import.events[0].message, "Check the retry loop");
    assert_eq!(import.events[2].message, "Three retries are configured.");
    assert_eq!(import.events[2].payload["kind"], "provider-response");
    assert_eq!(
        import.events[0].turn_id.unwrap().to_string(),
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    );
    let encoded = serde_json::to_string(&import.events).unwrap();
    assert!(!encoded.contains("INSTRUCTIONS"));
    assert!(!encoded.contains("PRIVATE"));
    assert!(!encoded.contains("999999"));
    assert!(import.events.iter().all(|event| matches!(
        event.kind,
        SessionEventKind::UserMessage
            | SessionEventKind::AssistantMessage
            | SessionEventKind::SystemEvent
    )));
}

#[test]
fn codex_supports_event_only_rollouts_and_identity_alias() {
    let (_temp, request, _) = fixture(
        SourceKind::Codex,
        "legacy",
        include_str!("fixtures/codex-legacy.jsonl"),
    );
    let import = only_import(request);
    assert_eq!(
        import.candidate.source_session_id,
        "33333333-3333-4333-8333-333333333333"
    );
    assert_eq!(import.candidate.title, "Fix the build");
    assert_eq!(import.events.len(), 2);
}

#[test]
fn sources_do_not_scan_and_archived_requires_opt_in() {
    let (temp, mut request, original) = fixture(
        SourceKind::Codex,
        "modern",
        include_str!("fixtures/codex-modern.jsonl"),
    );
    let archived = temp.path().join("provider/archived_sessions");
    fs::create_dir_all(&archived).unwrap();
    fs::rename(original, archived.join("archived.jsonl")).unwrap();
    let sources = get_project_import_sources(&request).unwrap();
    assert_eq!(sources.len(), 2);
    assert!(discover_project_imports(request.clone())
        .unwrap()
        .candidates
        .is_empty());
    request.include_archived = true;
    let scan = discover_project_imports(request).unwrap();
    assert_eq!(scan.candidates.len(), 1);
    assert!(scan.candidates[0].archived);
}

#[test]
fn active_copy_wins_when_archived_native_id_is_duplicated() {
    let (temp, mut request, original) = fixture(
        SourceKind::Codex,
        "modern",
        include_str!("fixtures/codex-modern.jsonl"),
    );
    let archived = temp.path().join("provider/archived_sessions");
    fs::create_dir_all(&archived).unwrap();
    fs::copy(original, archived.join("copy.jsonl")).unwrap();
    request.include_archived = true;
    let scan = discover_project_imports(request).unwrap();
    assert_eq!(scan.candidates.len(), 1);
    assert!(!scan.candidates[0].archived);
}

#[test]
fn malformed_oversized_and_incomplete_records_are_diagnosed_without_dropping_chat() {
    let (_temp, request, path) = fixture(
        SourceKind::Codex,
        "legacy",
        include_str!("fixtures/codex-legacy.jsonl"),
    );
    let mut writer = fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(writer, "{{broken}}").unwrap();
    writeln!(writer, "{}", "x".repeat(1024 * 1024 + 100)).unwrap();
    write!(writer, "{{\"type\":\"response_item\"").unwrap();
    drop(writer);
    let import = only_import(request);
    assert_eq!(import.events.len(), 2);
    assert!(import
        .diagnostics
        .iter()
        .any(|item| item.contains("Malformed")));
    assert!(import.diagnostics.iter().any(|item| item.contains("1 MB")));
    assert!(import
        .diagnostics
        .iter()
        .any(|item| item.contains("Incomplete")));
}

#[test]
fn missing_workspaces_are_available_as_history_but_metadata_is_never_decoded_from_folder_name() {
    let (_temp, request, path) = fixture(
        SourceKind::ClaudeCode,
        "conversation",
        include_str!("fixtures/claude-branches.jsonl"),
    );
    let text = fs::read_to_string(&path).unwrap();
    let mut records = text
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    for record in &mut records {
        if record.get("cwd").is_some() {
            record["cwd"] = json!("/missing-import-workspace/never-created");
        }
    }
    fs::write(
        path,
        records
            .iter()
            .map(|record| format!("{record}\n"))
            .collect::<String>(),
    )
    .unwrap();
    let import = only_import(request);
    assert!(!import.candidate.workspace_available);
    assert_eq!(
        import.candidate.workspace_path,
        "/missing-import-workspace/never-created"
    );
}

#[test]
fn skips_codex_subagents_and_claude_sidechain_only_files() {
    let (_temp, request, path) = fixture(
        SourceKind::Codex,
        "modern",
        include_str!("fixtures/codex-modern.jsonl"),
    );
    let source = fs::read_to_string(&path).unwrap().replace(
        "\"source\":\"cli\"",
        "\"source\":{\"subagent\":{\"parent_thread_id\":\"parent\"}}",
    );
    fs::write(path, source).unwrap();
    assert!(discover_project_imports(request)
        .unwrap()
        .candidates
        .is_empty());
    let (_temp, request, path) = fixture(
        SourceKind::ClaudeCode,
        "sidechain",
        include_str!("fixtures/claude-branches.jsonl"),
    );
    let source = fs::read_to_string(&path)
        .unwrap()
        .replace(
            "\"type\":\"user\"",
            "\"isSidechain\":true,\"type\":\"user\"",
        )
        .replace(
            "\"type\":\"assistant\"",
            "\"isSidechain\":true,\"type\":\"assistant\"",
        );
    fs::write(path, source).unwrap();
    assert!(discover_project_imports(request)
        .unwrap()
        .candidates
        .is_empty());
}

#[test]
fn long_multibyte_content_is_bounded_and_safe() {
    let (_temp, request, path) = fixture(
        SourceKind::Codex,
        "legacy",
        include_str!("fixtures/codex-legacy.jsonl"),
    );
    let mut writer = fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(writer, "{}", json!({"type":"event_msg","timestamp":"2025-08-01T12:00:03Z","payload":{"type":"agent_message","message":"🌀".repeat(70_000)}})).unwrap();
    drop(writer);
    let import = only_import(request);
    assert!(import
        .events
        .iter()
        .all(|event| event.message.len() <= 64_000));
    assert!(import.diagnostics.iter().any(|item| item.contains("split")));
    let prose: String = import
        .events
        .iter()
        .skip(2)
        .map(|event| event.message.as_str())
        .collect();
    assert_eq!(prose, "🌀".repeat(70_000));
}

#[test]
fn validates_identity_again_at_import_and_rejects_outside_history_paths() {
    let (temp, request, path) = fixture(
        SourceKind::Codex,
        "legacy",
        include_str!("fixtures/codex-legacy.jsonl"),
    );
    let mut candidate = discover_project_imports(request)
        .unwrap()
        .candidates
        .remove(0);
    let text = fs::read_to_string(&path).unwrap().replace(
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
    );
    fs::write(&path, text).unwrap();
    assert!(normalize_project_import(&candidate)
        .unwrap_err()
        .to_string()
        .contains("changed since scanning"));
    let outside = temp.path().join("provider/credentials.jsonl");
    fs::copy(path, &outside).unwrap();
    candidate.transcript_path = outside.to_string_lossy().into_owned();
    assert!(normalize_project_import(&candidate)
        .unwrap_err()
        .to_string()
        .contains("outside"));
}

#[test]
fn preserves_supported_attachment_paths_and_reports_embedded_media() {
    let (_temp, request, path) = fixture(
        SourceKind::Codex,
        "legacy",
        include_str!("fixtures/codex-legacy.jsonl"),
    );
    let mut writer = fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(writer, "{}", json!({"type":"response_item","timestamp":"2025-08-01T12:00:03Z","payload":{"type":"message","role":"user","content":[{"type":"input_image","image_url":"file:///missing-import-image.png"},{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]}})).unwrap();
    drop(writer);
    let import = only_import(request);
    assert_eq!(
        import.events.last().unwrap().payload["attachments"][0]["path"],
        "/missing-import-image.png"
    );
    assert_eq!(
        import.events.last().unwrap().payload["attachments"][0]["available"],
        false
    );
    assert!(import.diagnostics.iter().any(|item| item.contains("image")));
}

#[test]
fn discovery_and_normalization_do_not_modify_provider_files() {
    let (_temp, request, path) = fixture(
        SourceKind::ClaudeCode,
        "conversation",
        include_str!("fixtures/claude-branches.jsonl"),
    );
    let before = fs::read(&path).unwrap();
    let metadata_before = fs::metadata(&path).unwrap();
    let import = only_import(request);
    assert!(!import.events.is_empty());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(
        fs::metadata(&path).unwrap().modified().unwrap(),
        metadata_before.modified().unwrap()
    );
}

#[test]
fn historical_tools_without_results_are_finished_as_failed() {
    let (_temp, request, path) = fixture(
        SourceKind::Codex,
        "legacy",
        include_str!("fixtures/codex-legacy.jsonl"),
    );
    let mut writer = fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(writer, "{}", json!({"type":"response_item","timestamp":"2025-08-01T12:00:03Z","payload":{"type":"custom_tool_call","call_id":"interrupted-tool","name":"apply_patch","input":"*** Add File: old.ts"}})).unwrap();
    drop(writer);
    let import = only_import(request);
    let tool = import.events.last().unwrap();
    assert_eq!(tool.kind, SessionEventKind::SystemEvent);
    assert_eq!(tool.payload["activityKind"], "tool");
    assert_eq!(tool.payload["status"], "failed");
    assert!(tool.payload["detail"]
        .as_str()
        .unwrap()
        .contains("No result recorded"));
    assert!(tool.payload.get("changes").is_none());
    assert!(tool.payload.get("approvalId").is_none());
}

#[test]
fn codex_analysis_messages_are_excluded_and_legacy_prompts_get_distinct_turns() {
    let (_temp, request, path) = fixture(
        SourceKind::Codex,
        "legacy",
        include_str!("fixtures/codex-legacy.jsonl"),
    );
    let mut writer = fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(writer, "{}", json!({"type":"response_item","timestamp":"2025-08-01T12:00:03Z","payload":{"type":"message","role":"assistant","channel":"analysis","content":[{"type":"output_text","text":"PRIVATE ANALYSIS"}]}})).unwrap();
    writeln!(writer, "{}", json!({"type":"event_msg","timestamp":"2025-08-01T12:00:04Z","payload":{"type":"user_message","message":"Now add tests"}})).unwrap();
    drop(writer);
    let import = only_import(request);
    assert_eq!(import.events.len(), 3);
    assert_ne!(import.events[0].turn_id, import.events[2].turn_id);
    assert!(import
        .events
        .iter()
        .all(|event| !event.message.contains("PRIVATE")));
}

#[test]
fn later_claude_messages_after_a_saved_leaf_marker_are_preserved() {
    let (_temp, request, path) = fixture(
        SourceKind::ClaudeCode,
        "conversation",
        include_str!("fixtures/claude-branches.jsonl"),
    );
    let mut writer = fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(writer, "{}", json!({"type":"user","uuid":"later-user","parentUuid":"chosen-branch","sessionId":"11111111-1111-4111-8111-111111111111","timestamp":"2026-01-01T12:00:10Z","message":{"role":"user","content":"One more thing"}})).unwrap();
    drop(writer);
    let import = only_import(request);
    assert_eq!(import.events.last().unwrap().message, "One more thing");
}

#[test]
fn claude_generated_titles_are_supported_and_do_not_replace_a_custom_title() {
    let (_temp, request, path) = fixture(
        SourceKind::ClaudeCode,
        "conversation",
        include_str!("fixtures/claude-branches.jsonl"),
    );
    let mut writer = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(writer, "{}", json!({"type":"ai-title","aiTitle":"Generated retry title","sessionId":"11111111-1111-4111-8111-111111111111"})).unwrap();
    drop(writer);
    assert_eq!(only_import(request.clone()).candidate.title, "Retry limit");
    let content = fs::read_to_string(&path)
        .unwrap()
        .lines()
        .filter(|line| !line.contains("custom-title"))
        .map(|line| format!("{line}\n"))
        .collect::<String>();
    fs::write(path, content).unwrap();
    assert_eq!(
        only_import(request).candidate.title,
        "Generated retry title"
    );
}

#[test]
fn codex_human_fork_uses_latest_identity_instead_of_parent_subagent_metadata() {
    let (_temp, request, path) = fixture(
        SourceKind::Codex,
        "legacy",
        include_str!("fixtures/codex-legacy.jsonl"),
    );
    let source = fs::read_to_string(&path).unwrap().replace(
        "\"source\":\"cli\"",
        "\"source\":{\"subagent\":{\"parent_thread_id\":\"parent\"}}",
    );
    fs::write(&path, source).unwrap();
    let mut writer = fs::OpenOptions::new().append(true).open(path).unwrap();
    let workspace = Path::new(request.codex_data_home.as_ref().unwrap())
        .parent()
        .unwrap()
        .join("workspace");
    writeln!(writer, "{}", json!({"type":"session_meta","timestamp":"2026-01-03T12:00:00Z","payload":{"id":"55555555-5555-4555-8555-555555555555","timestamp":"2026-01-03T12:00:00Z","source":"vscode","forked_from_id":"33333333-3333-4333-8333-333333333333","cwd":workspace.to_string_lossy(),"title":"Human fork"}})).unwrap();
    drop(writer);
    let import = only_import(request);
    assert_eq!(
        import.candidate.source_session_id,
        "55555555-5555-4555-8555-555555555555"
    );
    assert_eq!(import.candidate.title, "Human fork");
    assert_eq!(
        import.candidate.created_at.to_rfc3339(),
        "2026-01-03T12:00:00+00:00"
    );
    assert_eq!(import.events.len(), 2);
    assert_eq!(import.events[0].message, "Fix the build");
}

#[test]
fn codex_content_block_tool_results_preserve_readable_output_and_failure_without_image_data() {
    let (_temp, request, path) = fixture(
        SourceKind::Codex,
        "legacy",
        include_str!("fixtures/codex-legacy.jsonl"),
    );
    let mut writer = fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(writer, "{}", json!({"type":"response_item","timestamp":"2025-08-01T12:00:03Z","payload":{"type":"custom_tool_call","call_id":"array-tool","name":"exec_command","input":"cargo check"}})).unwrap();
    writeln!(writer, "{}", json!({"type":"response_item","timestamp":"2025-08-01T12:00:04Z","payload":{"type":"custom_tool_call_output","call_id":"array-tool","output":[{"type":"input_text","text":json!({"exit_code":1,"wall_time_seconds":0.1,"output":"Readable error\non its own line"}).to_string()},{"type":"input_image","image_url":"data:image/png;base64,PRIVATE_IMAGE_DATA"}]}})).unwrap();
    writeln!(writer, "{}", json!({"type":"response_item","timestamp":"2025-08-01T12:00:05Z","payload":{"type":"agent_message","author":"/root","recipient":"/root/worker","content":[{"type":"input_text","text":"PRIVATE COORDINATION"},{"type":"encrypted_content","encrypted_content":"PRIVATE"}]}})).unwrap();
    drop(writer);
    let import = only_import(request);
    let tool = import.events.last().unwrap();
    assert_eq!(tool.payload["status"], "failed");
    assert!(tool.payload["detail"]
        .as_str()
        .unwrap()
        .contains("Readable error\non its own line"));
    let encoded = serde_json::to_string(&import.events).unwrap();
    assert!(!encoded.contains("PRIVATE_IMAGE_DATA"));
    assert!(!encoded.contains("PRIVATE COORDINATION"));
    assert!(import
        .diagnostics
        .iter()
        .any(|item| item.contains("tool image")));
}

#[test]
fn recognizable_future_formats_import_visible_history_with_a_version_diagnostic() {
    for (kind, contents, old, new) in [
        (
            SourceKind::ClaudeCode,
            include_str!("fixtures/claude-branches.jsonl"),
            "2.1.0",
            "99.1.0",
        ),
        (
            SourceKind::Codex,
            include_str!("fixtures/codex-modern.jsonl"),
            "0.100.0",
            "99.2.0",
        ),
    ] {
        let (_temp, request, _) = fixture(kind, "future", &contents.replace(old, new));
        let import = only_import(request);
        assert!(!import.events.is_empty());
        assert!(import
            .diagnostics
            .iter()
            .any(|item| item.contains("version 99") && item.contains("supported visible")));
    }
}

#[test]
fn malformed_and_blank_lines_have_bounded_work_and_diagnostic_storage() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("many-lines.jsonl");
    fs::write(
        &path,
        format!("{}{}", "invalid\n".repeat(500), "\n".repeat(100_000)),
    )
    .unwrap();
    let transcript = super::transcript::read_transcript(&path).unwrap();
    assert!(transcript.records.is_empty());
    assert_eq!(transcript.diagnostics.len(), 101);
    assert!(transcript
        .diagnostics
        .last()
        .unwrap()
        .contains("further import diagnostics"));
    // The line cap must apply to valid, malformed and blank rows alike.
    fs::write(
        &path,
        format!("{}{{\"late\":true}}\n", "\n".repeat(100_000)),
    )
    .unwrap();
    let transcript = super::transcript::read_transcript(&path).unwrap();
    assert!(transcript.records.is_empty());
    assert!(transcript
        .diagnostics
        .iter()
        .any(|item| item.contains("line limit")));
}
