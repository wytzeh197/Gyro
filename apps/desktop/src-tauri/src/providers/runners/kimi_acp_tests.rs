use super::*;

#[test]
fn acp_rejects_an_unread_or_changed_base_before_approval_or_full_access() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    let file = workspace.join("file.txt");
    fs::write(&file, "user saved this").unwrap();
    let old_hash = gyro_core::mutations::content_hash(b"agent read this");
    for require_approval in [false, true] {
        for observed in [None, Some(old_hash.as_str())] {
            let result = apply_acp_workspace_write(
                &workspace,
                &file,
                "stale replacement",
                observed,
                false,
                require_approval,
                &gyro_core::CancellationToken::default(),
                |_, _| panic!("a stale edit must not reach approval"),
            );
            assert!(result.is_err());
            assert_eq!(fs::read_to_string(&file).unwrap(), "user saved this");
        }
    }
}

#[test]
fn acp_workspace_write_requires_its_exact_review_and_does_not_reapply() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().canonicalize().unwrap();
    let a = workspace.join("approved-earlier.txt");
    let b = workspace.join("actual.txt");
    fs::write(&a, "safe").unwrap();
    fs::write(&b, "before\n").unwrap();
    let cancellation = gyro_core::CancellationToken::default();
    let denied = apply_acp_workspace_write(
        &workspace,
        &b,
        "different\n",
        Some(&gyro_core::mutations::content_hash(b"before\n")),
        false,
        true,
        &cancellation,
        |_, details| {
            assert_eq!(details["patch"]["changes"][0]["path"], "actual.txt");
            assert!(details["patch"]["changes"][0]["diff"]
                .as_str()
                .unwrap()
                .contains("+different"));
            Ok(ProviderApprovalDecision::Reject)
        },
    );
    assert!(denied.is_err());
    assert_eq!(fs::read_to_string(&b).unwrap(), "before\n");
    apply_acp_workspace_write(
        &workspace,
        &b,
        "reviewed\n",
        Some(&gyro_core::mutations::content_hash(b"before\n")),
        false,
        true,
        &cancellation,
        |transaction, _| {
            gyro_core::apply_provider_mutation_transaction(&transaction)?;
            Ok(ProviderApprovalDecision::AppliedByGyro)
        },
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&b).unwrap(), "reviewed\n");
    assert_eq!(fs::read_to_string(&a).unwrap(), "safe");
    assert!(apply_acp_workspace_write(
        &workspace,
        &b,
        "plan write",
        None,
        true,
        false,
        &cancellation,
        |_, _| panic!("plan must not ask to write")
    )
    .is_err());
}

#[test]
fn provider_adapter_registry_executes_all_supported_acp_providers() {
    let openai = provider_adapter_for("openai");
    assert_eq!(openai.kind, ProviderAdapterKind::OpenAiCodex);
    assert_eq!(openai.runner, "codex-cli");

    let anthropic = provider_adapter_for("anthropic");
    assert_eq!(anthropic.kind, ProviderAdapterKind::AnthropicClaude);
    assert_eq!(anthropic.runner, "claude-code");

    let kimi = provider_adapter_for("kimi");
    assert_eq!(kimi.kind, ProviderAdapterKind::KimiAcp);
    assert_eq!(kimi.runner, "kimi-acp");

    for (provider_id, runner) in [
        ("xai", "grok-acp"),
        ("gemini", "gemini-acp"),
        ("cursor", "cursor-acp"),
        ("opencode", "opencode-acp"),
    ] {
        let adapter = provider_adapter_for(provider_id);
        assert_eq!(adapter.kind, ProviderAdapterKind::KimiAcp);
        assert_eq!(adapter.runner, runner);
        assert!(adapter.timeout_seconds > 0);
    }
    assert_eq!(
        provider_adapter_for("unknown").kind,
        ProviderAdapterKind::ReadinessOnly
    );
}

#[test]
fn kimi_acp_plan_activity_maps_to_the_existing_plan_payload() {
    let payload = kimi_acp_plan_payload(&ProviderActivity {
        id: "kimi-plan".into(),
        kind: "plan".into(),
        label: "Updated plan".into(),
        detail: Some(
            serde_json::json!([
                {"content": "Inspect", "status": "in_progress"},
                {"title": "Implement", "status": "completed"}
            ])
            .to_string(),
        ),
        file_counts: None,
        note: None,
        status: "done".into(),
    })
    .unwrap();
    assert_eq!(payload["action"], "replace");
    assert_eq!(payload["items"][0]["title"], "Inspect");
    assert_eq!(payload["items"][0]["status"], "in-progress");
    assert_eq!(payload["items"][1]["status"], "complete");
}

#[test]
fn grok_acp_args_use_process_model_and_effort() {
    let args = build_grok_acp_program_args(
        Some("grok-4.6"),
        Some("xhigh"),
        gyro_core::ApprovalPosture::Ask,
    );
    let as_str: Vec<String> = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        as_str,
        vec![
            "--no-auto-update",
            "--permission-mode",
            "default",
            "--sandbox",
            "workspace",
            "agent",
            "--no-leader",
            "-m",
            "grok-4.6",
            "--reasoning-effort",
            "xhigh",
            "stdio",
        ]
    );
    // Grok 4.3, 4.6, 4.7, and 4.7 Fast expose xhigh; 4.5 stops at high.
    // Levels no Grok model supports are dropped rather than failing the turn.
    assert_eq!(
        grok_reasoning_effort_arg(Some("grok-4.6"), Some("Medium")),
        Some("medium".into())
    );
    assert_eq!(
        grok_reasoning_effort_arg(Some("grok-4.6"), Some("xhigh")),
        Some("xhigh".into())
    );
    assert_eq!(
        grok_reasoning_effort_arg(Some("grok-4.7"), Some("xhigh")),
        Some("xhigh".into())
    );
    assert_eq!(
        grok_reasoning_effort_arg(Some("grok-4.7-build-fast"), Some("xhigh")),
        Some("xhigh".into())
    );
    assert_eq!(
        grok_reasoning_effort_arg(Some("grok-4.3"), Some("xhigh")),
        Some("xhigh".into())
    );
    assert_eq!(
        grok_reasoning_effort_arg(Some("grok-4.5"), Some("xhigh")),
        None
    );
    assert_eq!(
        grok_reasoning_effort_arg(Some("grok-4.6"), Some("max")),
        None
    );
    assert_eq!(
        grok_reasoning_effort_arg(Some("grok-4.6"), Some("ultra")),
        None
    );
    assert_eq!(grok_reasoning_effort_arg(Some("grok-4.6"), None), None);
    assert!(!build_grok_acp_program_args(
        Some("grok-4.6"),
        Some("ultra"),
        gyro_core::ApprovalPosture::Ask,
    )
    .iter()
    .any(|arg| arg == "--reasoning-effort"));
    let minimal = build_grok_acp_program_args(None, None, gyro_core::ApprovalPosture::Ask);
    let minimal_str: Vec<String> = minimal
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        minimal_str,
        vec![
            "--no-auto-update",
            "--permission-mode",
            "default",
            "--sandbox",
            "workspace",
            "agent",
            "--no-leader",
            "stdio",
        ]
    );
    let full: Vec<String> =
        build_grok_acp_program_args(None, None, gyro_core::ApprovalPosture::FullAccess)
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
    assert!(full
        .windows(2)
        .any(|pair| pair == ["--permission-mode", "bypassPermissions"]));
    assert!(full.windows(2).any(|pair| pair == ["--sandbox", "off"]));
}
