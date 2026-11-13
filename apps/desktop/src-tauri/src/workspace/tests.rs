use super::*;

#[test]
fn workspace_tree_lists_every_direct_child_without_truncation() {
    let workspace = tempfile::tempdir().unwrap();
    for index in 0..1250 {
        fs::write(workspace.path().join(format!("file-{index}.txt")), "").unwrap();
    }
    for folder in [
        "apps",
        "packages",
        "scripts",
        "node_modules",
        "target",
        ".github",
    ] {
        fs::create_dir(workspace.path().join(folder)).unwrap();
        fs::write(workspace.path().join(folder).join("child.txt"), "").unwrap();
    }
    let listing =
        list_workspace_tree_blocking(workspace.path().display().to_string(), Some(1)).unwrap();
    assert_eq!(listing.len(), 1256);
    assert!(listing.iter().all(|entry| entry.depth == 1));
    for folder in [
        "apps",
        "packages",
        "scripts",
        "node_modules",
        "target",
        ".github",
    ] {
        assert!(listing
            .iter()
            .any(|entry| entry.path == folder && entry.kind == "directory"));
        let children = list_workspace_tree_blocking(
            workspace.path().join(folder).display().to_string(),
            Some(1),
        )
        .unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].path, "child.txt");
    }
}

#[test]
fn workspace_tree_can_expand_beyond_the_old_depth_limit() {
    let workspace = tempfile::tempdir().unwrap();
    let nested = workspace.path().join("a/b/c/d/e/f/g/h/i/j");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("deep.txt"), "deep").unwrap();
    let listing = list_workspace_tree_blocking(nested.display().to_string(), Some(1)).unwrap();
    assert_eq!(listing[0].path, "deep.txt");
}

#[test]
fn workspace_tree_entries_are_sorted_depth_first() {
    let mut files = [
        WorkspaceFile {
            path: "root.txt".into(),
            kind: "file".into(),
            depth: 1,
        },
        WorkspaceFile {
            path: "apps/desktop".into(),
            kind: "directory".into(),
            depth: 2,
        },
        WorkspaceFile {
            path: "docs".into(),
            kind: "directory".into(),
            depth: 1,
        },
        WorkspaceFile {
            path: "apps/a.ts".into(),
            kind: "file".into(),
            depth: 2,
        },
        WorkspaceFile {
            path: "apps".into(),
            kind: "directory".into(),
            depth: 1,
        },
        WorkspaceFile {
            path: "Cargo.toml".into(),
            kind: "file".into(),
            depth: 1,
        },
        WorkspaceFile {
            path: "apps/desktop/main.ts".into(),
            kind: "file".into(),
            depth: 3,
        },
        WorkspaceFile {
            path: "apps/z.ts".into(),
            kind: "file".into(),
            depth: 2,
        },
    ];

    files.sort_by(compare_workspace_tree_entries);

    assert_eq!(
        files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "apps",
            "apps/desktop",
            "apps/desktop/main.ts",
            "apps/a.ts",
            "apps/z.ts",
            "docs",
            "Cargo.toml",
            "root.txt",
        ]
    );
}

#[test]
fn workspace_context_paths_are_bounded_and_live_text_requires_explicit_read() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
    fs::write(temp.path().join(".env"), "TOKEN=secret\n").unwrap();
    let mut context = WorkspaceContextSnapshot::empty(temp.path().display().to_string());
    context.active_path = Some(temp.path().join("main.rs").display().to_string());
    context.visible_tabs = vec![temp.path().join("main.rs").display().to_string()];
    context.selection = Some(serde_json::json!({
        "path": ".env",
        "text": "TOKEN=secret",
    }));
    context.buffers = vec![serde_json::json!({
        "path": ".env",
        "dirty": true,
        "content": "TOKEN=secret",
    })];

    normalize_workspace_context_paths(temp.path(), &mut context).unwrap();

    assert_eq!(context.active_path.as_deref(), Some("main.rs"));
    assert_eq!(context.visible_tabs, vec!["main.rs"]);
    assert_eq!(context.selection.as_ref().unwrap()["text"], "TOKEN=secret");
    assert_eq!(context.buffers[0]["content"], "TOKEN=secret");
    let metadata = workspace_context_metadata(&context);
    assert!(metadata.selection.as_ref().unwrap().get("text").is_none());
    assert!(metadata.buffers[0].get("content").is_none());

    context.active_path = Some("../outside".into());
    assert!(normalize_workspace_context_paths(temp.path(), &mut context).is_err());
}

#[test]
fn provider_prompt_includes_workspace_check_briefing() {
    let mut request = anthropic_provider_request();
    let mut check = WorkspaceCheckReport::placeholder("/tmp/project");
    check.project_kind = Some("rust".into());
    check.markers = vec!["Cargo.toml".into()];
    request.workspace_check = Some(check);
    let mut context = WorkspaceContextSnapshot::empty("/tmp/project");
    context.availability = "available".into();
    context.unavailable_reason = None;
    context.diagnostics = vec![serde_json::json!({ "message": "unused" })];
    request.workspace_context = Some(context);

    let text = provider_context_message(&request);
    assert!(text.contains("Workspace check: ready"));
    assert!(text.contains("Project: rust"));
    assert!(text.contains("1 diagnostic"));
    assert!(text.contains("gyro_workspace_check"));
    assert!(text.contains("compact workspace check is attached"));
    assert!(!text.contains("already attached and current"));
    assert!(!text.contains("to refresh this snapshot"));
}

#[test]
fn workspace_guidance_survives_resume_and_respects_tool_access() {
    let mut request = anthropic_provider_request();
    for resumed in [false, true] {
        let turn = PromptTurn {
            resumed,
            approvals_sent_separately: false,
        };
        let context = provider_context_message_for_turn(&request, None, turn);
        assert!(context.contains("Selected workspace: /tmp/gyro-workspace"));
        if resumed {
            for guard in [
                "Use Gyro Workspace tools and verified files",
                "preserve user-supplied paths exactly",
                "a failed read never authorizes creation",
                "Read-only and edit-path limits also cover proposals",
            ] {
                assert!(context.contains(guard), "Resume lost {guard}");
            }
        } else {
            assert!(context.contains("do not ask the user to paste files you can read"));
        }
        // The edit tutorial is standing guidance for the opening turn.
        // A resumed turn keeps the workspace rules and skips that repeat.
        if resumed {
            assert!(!context.contains("gyro_workspace_edit"));
            assert!(!context.contains("report pending review"));
        } else {
            assert!(context.contains("gyro_workspace_edit"));
            assert!(context.contains("report pending review"));
        }
        for prompt in [
            openai_codex_chat_prompt(
                &context,
                request.workspace_path.as_deref(),
                None,
                false,
                true,
                resumed,
            ),
            claude_chat_prompt(
                &context,
                request.workspace_path.as_deref(),
                false,
                true,
                resumed,
            ),
        ] {
            assert!(!prompt.contains("only as optional context"));
            assert_eq!(prompt.contains("inspect its status"), !resumed);
            assert_eq!(
                prompt
                    .matches("Selected workspace: /tmp/gyro-workspace")
                    .count(),
                1
            );
        }
    }
    request.mode = ChatMode::Plan;
    let plan = provider_context_message(&request);
    assert!(plan.contains("Plan mode is read-only"));
    assert!(!plan.contains("carry it through authorized edits"));
    request.mode = ChatMode::Council;
    let council = provider_context_message(&request);
    assert!(council.contains("advisory only"));
    assert!(!council.contains("Prefer Gyro Workspace tools"));
    request.mode = ChatMode::Normal;
    let chat_only = provider_context_message_with_tool_support(&request, None, false);
    assert!(!chat_only.contains("Prefer Gyro Workspace tools"));
}

#[test]
fn missing_workspace_folder_fails_closed_instead_of_using_home() {
    let error = provider_chat_cwd(Some("/tmp/gyro-missing-project-folder-xyz"))
        .unwrap_err()
        .to_string();
    assert!(error.contains(WORKSPACE_UNAVAILABLE_MESSAGE));
    assert!(!is_transient_provider_error(&error));
    assert!(is_transient_provider_error("connection reset by peer"));
    assert!(!is_transient_provider_error("Kimi ACP run timed out"));
    assert!(!is_transient_provider_error("xAI ACP run became inactive"));
    assert!(!is_transient_provider_error(
        "Ollama exceeded Gyro's tool-call limit for one turn"
    ));
}

#[test]
fn reads_text_file_inside_workspace() {
    let workspace = tempfile::tempdir().unwrap();
    let source_dir = workspace.path().join("src");
    std::fs::create_dir_all(&source_dir).unwrap();
    std::fs::write(source_dir.join("app.ts"), "export const value = 1;\n").unwrap();

    let content =
        read_workspace_file_impl(workspace.path().to_str().unwrap(), "src/app.ts").unwrap();

    assert_eq!(content.path, "src/app.ts");
    assert_eq!(content.content, "export const value = 1;\n");
    assert!(!content.truncated);
    assert_eq!(content.size_bytes, 24);
}

#[test]
fn workspace_watch_cache_reuses_stable_tree_and_invalidates_on_directory_change() {
    let workspace = tempfile::tempdir().unwrap();
    let nested = workspace.path().join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("first.txt"), "one\n").unwrap();
    let manager = WorkspaceWatchManager::default();

    let first = manager
        .snapshot(workspace.path().to_str().unwrap())
        .unwrap();
    let cached = manager
        .snapshot(workspace.path().to_str().unwrap())
        .unwrap();
    assert_eq!(
        first.iter().map(|file| &file.path).collect::<Vec<_>>(),
        cached.iter().map(|file| &file.path).collect::<Vec<_>>()
    );

    fs::remove_dir_all(&nested).unwrap();
    fs::write(workspace.path().join("second.txt"), "two\n").unwrap();
    let changed = manager
        .snapshot(workspace.path().to_str().unwrap())
        .unwrap();
    assert!(changed.iter().any(|file| file.path == "second.txt"));
}

#[test]
fn workspace_snapshot_generations_advance_only_when_a_scan_is_stored() {
    let workspace = tempfile::tempdir().unwrap();
    fs::write(workspace.path().join("first.txt"), "one\n").unwrap();
    let manager = WorkspaceWatchManager::default();

    let first = manager.prime(workspace.path().to_str().unwrap()).unwrap();
    let cached = manager
        .snapshots
        .lock()
        .unwrap()
        .get(&workspace.path().canonicalize().unwrap())
        .unwrap()
        .generation;
    assert_eq!(first.generation, cached);

    fs::write(workspace.path().join("second.txt"), "two\n").unwrap();
    let second = manager.prime(workspace.path().to_str().unwrap()).unwrap();
    assert!(second.generation > first.generation);
}

#[test]
fn workspace_rescan_state_coalesces_event_bursts_per_root() {
    let root = PathBuf::from("/tmp/gyro-workspace");
    let mut state = WorkspaceRescanState::default();

    assert!(state.request(root.clone()));
    let first_serial = state.serial(&root).unwrap();
    for _ in 0..256 {
        assert!(!state.request(root.clone()));
    }
    let latest_serial = state.serial(&root).unwrap();
    assert!(latest_serial > first_serial);

    // The original worker remains responsible after a later event rather
    // than allowing an event storm to create one thread per notification.
    assert!(state.finish_round(&root, first_serial));
    assert!(state.active_roots.contains(&root));
    assert!(!state.finish_round(&root, latest_serial));
    assert!(!state.active_roots.contains(&root));

    // A later, settled change starts exactly one new worker.
    assert!(state.request(root.clone()));
    assert!(!state.request(root));
}

#[test]
fn pnpm_workspace_members_keep_primary_scripts_only() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(
        workspace.path().join("package.json"),
        r#"{"scripts":{"test":"vitest"}}"#,
    )
    .unwrap();
    std::fs::write(
        workspace.path().join("pnpm-lock.yaml"),
        "lockfileVersion: 9\n",
    )
    .unwrap();
    std::fs::write(
        workspace.path().join("pnpm-workspace.yaml"),
        "packages:\n  - \"packages/*\"\n  - \"packages/skipped\"\n",
    )
    .unwrap();
    let ui = workspace.path().join("packages/ui");
    let skipped = workspace.path().join("packages/skipped");
    let hidden = workspace.path().join("packages/node_modules/nested");
    std::fs::create_dir_all(&ui).unwrap();
    std::fs::create_dir_all(&skipped).unwrap();
    std::fs::create_dir_all(&hidden).unwrap();
    std::fs::write(
        ui.join("package.json"),
        r#"{"name":"@gyro/ui","scripts":{"test":"vitest","test:browser":"vitest browser","lint":"eslint"}}"#,
    )
    .unwrap();
    std::fs::write(
        skipped.join("package.json"),
        r#"{"name":"@gyro/skipped","scripts":{"test:only":"vitest"}}"#,
    )
    .unwrap();
    std::fs::write(
        hidden.join("package.json"),
        r#"{"name":"@gyro/hidden","scripts":{"test":"vitest"}}"#,
    )
    .unwrap();

    let tasks = task_discover_impl(&workspace.path().display().to_string()).unwrap();
    let ui_test = tasks
        .iter()
        .find(|task| task.id == "package:packages/ui:test")
        .unwrap();
    assert_eq!(ui_test.command, "pnpm");
    assert_eq!(ui_test.args, vec!["--filter", "@gyro/ui", "test"]);
    assert_eq!(ui_test.package_path.as_deref(), Some("packages/ui"));
    assert!(tasks
        .iter()
        .any(|task| task.id == "package:packages/ui:lint"));
    assert!(tasks
        .iter()
        .all(|task| task.id != "package:packages/ui:test:browser"));
    assert!(tasks
        .iter()
        .all(|task| !task.id.contains("skipped") && !task.id.contains("hidden")));
}

#[test]
fn cargo_workspace_members_are_package_scoped() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(
        workspace.path().join("Cargo.toml"),
        "[workspace]\nmembers = [\n  \"crates/*\",\n]\n",
    )
    .unwrap();
    let core = workspace.path().join("crates/gyro-core");
    std::fs::create_dir_all(&core).unwrap();
    std::fs::write(
        core.join("Cargo.toml"),
        "[package]\nname = \"gyro-core\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();

    let tasks = task_discover_impl(&workspace.path().display().to_string()).unwrap();
    let root_test = tasks.iter().find(|task| task.id == "cargo:test").unwrap();
    assert_eq!(root_test.args, vec!["test", "--workspace"]);
    let member = tasks
        .iter()
        .find(|task| task.id == "cargo:crates/gyro-core:test")
        .unwrap();
    assert_eq!(member.args, vec!["test", "-p", "gyro-core"]);
    assert!(tasks.iter().all(|task| task.id != "cargo:clippy"));
}

#[test]
fn workspace_member_expansion_stops_at_the_cap() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("package.json"), "{}").unwrap();
    std::fs::write(
        workspace.path().join("pnpm-workspace.yaml"),
        "packages:\n  - \"packages/*\"\n",
    )
    .unwrap();
    for index in 0..40 {
        let dir = workspace.path().join(format!("packages/pkg-{index:02}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            format!("{{\"name\":\"pkg-{index:02}\",\"scripts\":{{\"test\":\"vitest\"}}}}"),
        )
        .unwrap();
    }

    let tasks = task_discover_impl(&workspace.path().display().to_string()).unwrap();
    let members = tasks
        .iter()
        .filter(|task| task.package_path.is_some())
        .count();
    assert_eq!(members, 32);
}

#[test]
fn rejects_file_outside_workspace() {
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();

    let error = read_workspace_file_impl(
        workspace.path().to_str().unwrap(),
        outside.path().to_str().unwrap(),
    )
    .unwrap_err();

    assert!(error.to_string().contains("outside workspace"));
}

#[test]
fn writes_text_file_inside_workspace_with_expected_hash() {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("app.ts"), "old\n").unwrap();
    let content = read_workspace_file_with_limit(
        workspace.path().to_str().unwrap(),
        "app.ts",
        MAX_WORKSPACE_FILE_EDIT_BYTES,
    )
    .unwrap();

    let saved = write_workspace_file_impl(&WorkspaceFileWriteRequest {
        workspace_path: workspace.path().to_str().unwrap().into(),
        path: "app.ts".into(),
        content: "new\n".into(),
        expected_hash: Some(content.content_hash),
    })
    .unwrap();

    assert_eq!(saved.content, "new\n");
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("app.ts")).unwrap(),
        "new\n"
    );
}

#[test]
fn rejects_write_outside_workspace() {
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();

    let error = write_workspace_file_impl(&WorkspaceFileWriteRequest {
        workspace_path: workspace.path().to_str().unwrap().into(),
        path: outside.path().to_str().unwrap().into(),
        content: "nope\n".into(),
        expected_hash: None,
    })
    .unwrap_err();

    assert!(error.to_string().contains("outside workspace"));
}

#[test]
fn native_prompt_wrappers_keep_standalone_workspace_locations() {
    for resumed in [false, true] {
        for prompt in [
            openai_codex_chat_prompt(
                "read the project",
                Some("/workspace"),
                None,
                false,
                true,
                resumed,
            ),
            claude_chat_prompt("read the project", Some("/workspace"), false, true, resumed),
        ] {
            assert_eq!(prompt.matches("Selected workspace: /workspace").count(), 1);
            assert!(prompt.ends_with("User message:\nread the project"));
        }
    }
}

#[test]
fn a_title_the_user_renamed_survives_the_model_marker() {
    let mut state = suggested_title_for_turn("We Drew Our Own Traffic Lights");
    assert!(streamed_title_replacement(
        &mut state,
        "My Own Name",
        "GYRO_SESSION_TITLE: Traffic Light Bug\nWorking on it.",
        true,
    )
    .is_none());
    assert!(
        state.1,
        "a hand rename closes the control for the rest of the run"
    );
    assert!(streamed_title_replacement(
        &mut state,
        "My Own Name",
        "GYRO_SESSION_TITLE: Late Marker\nWorking on it.",
        true,
    )
    .is_none());
}

#[test]
fn file_changes_stay_with_the_reporting_chat_in_a_shared_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionStore::open(GyroPaths::from_base_dir(temp.path().join("Gyro"))).unwrap();
    let reader = store
        .create_session(temp.path(), SessionOrigin::Desktop, "reader")
        .unwrap();
    let writer = store
        .create_session(temp.path(), SessionOrigin::Desktop, "writer")
        .unwrap();
    let reader_turn = Uuid::new_v4();
    let writer_turn = Uuid::new_v4();
    let path = temp.path().join("shared.css");
    std::fs::write(&path, "before").unwrap();
    let command = serde_json::json!({
        "id": "read", "type": "commandExecution", "status": "completed",
        "command": "cat shared.css"
    });
    // Another chat writes the exact file the reader inspected.
    std::fs::write(&path, "after").unwrap();
    let read_activity = codex_item_activity(&command, "command", "Ran command");
    let write_activities = codex_file_change_activities(
        &serde_json::json!({
            "id": "edit", "status": "completed",
            "changes": [{ "path": "shared.css", "diff": "@@ -1 +1 @@\n-before\n+after\n" }]
        }),
        None,
    );
    for (session, turn, activities) in [
        (&reader, reader_turn, vec![read_activity]),
        (&writer, writer_turn, write_activities),
    ] {
        let request = provider_chat_request_for(session, temp.path(), "openai");
        let entries = activities
            .iter()
            .map(|activity| provider_activity_event_entry(&request, turn, 0, activity))
            .collect();
        store
            .append_system_events_with_turn_id(session.id, entries)
            .unwrap();
    }
    let reader_events = store.read_recent_events(reader.id, 20).unwrap();
    assert!(!reader_events
        .iter()
        .any(|event| event.payload["activityKind"] == "file"));
    let writer_events = store.read_recent_events(writer.id, 20).unwrap();
    let file = writer_events
        .iter()
        .find(|event| event.payload["activityKind"] == "file")
        .unwrap();
    assert_eq!(file.session_id, writer.id);
    assert_eq!(file.turn_id, Some(writer_turn));
    assert_eq!(file.payload["path"], "shared.css");
    assert_eq!(file.payload["additions"], 1);
    assert_eq!(file.payload["deletions"], 1);
}

#[test]
fn scheduler_dispatches_distinct_workspaces_and_defers_conflicts() {
    let temp = tempfile::tempdir().unwrap();
    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    let store = AutomationStore::open(paths.clone()).unwrap();
    let root_a = temp.path().join("a");
    let root_b = temp.path().join("b");
    fs::create_dir_all(&root_a).unwrap();
    fs::create_dir_all(&root_b).unwrap();
    let make = |title: &str, workspace: &Path| {
        store
            .create_automation(CreateAutomationRequest {
                title: title.into(),
                prompt: "Run checks".into(),
                schedule: gyro_core::AutomationSchedule::Hourly,
                project: "Gyro".into(),
                provider: "Codex".into(),
                branch: "main".into(),
                workspace_mode: SessionWorkspaceMode::Local,
                worktree_name: None,
                stop_condition: None,
                next_run_at: Some(chrono::Utc::now() - chrono::Duration::minutes(1)),
                execution: gyro_core::AutomationExecutionContext {
                    workflow_binding: None,
                    workspace_path: Some(workspace.display().to_string()),
                    ..Default::default()
                },
            })
            .unwrap()
    };
    let first = make("First A", &root_a);
    let same_workspace = make("Second A", &root_a);
    let independent = make("First B", &root_b);
    let due = vec![first.clone(), same_workspace.clone(), independent.clone()];
    let selected = automation_dispatch_candidates(&paths, due.clone(), &HashMap::new());
    assert_eq!(
        selected.iter().map(|(run, _)| run.id).collect::<Vec<_>>(),
        vec![first.id, independent.id]
    );
    let running = HashMap::from([(first.id, root_a.canonicalize().unwrap())]);
    let selected = automation_dispatch_candidates(&paths, due, &running);
    assert_eq!(
        selected.iter().map(|(run, _)| run.id).collect::<Vec<_>>(),
        vec![independent.id]
    );
}

#[test]
fn workspace_watch_cache_evicts_old_roots() {
    let parent = tempfile::tempdir().unwrap();
    let manager = WorkspaceWatchManager::default();
    for index in 0..=MAX_WORKSPACE_WATCH_CACHES {
        let root = parent.path().join(format!("workspace-{index}"));
        std::fs::create_dir(&root).unwrap();
        manager.snapshot(root.to_str().unwrap()).unwrap();
    }
    assert_eq!(
        manager.snapshots.lock().unwrap().len(),
        MAX_WORKSPACE_WATCH_CACHES
    );
}
