use super::*;

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

/// Kimi's access tokens last fifteen minutes, so a stored one is normally
/// spent. What matters is that the refresh token beside it is reached for
/// rather than reported as a failure — and that a sign-in with nothing
/// left names the one command that renews it.
#[test]
fn a_spent_kimi_token_renews_off_the_refresh_token_beside_it() {
    let now = 1_000_000_000_000i64;
    let stored = |expires: serde_json::Value| {
        serde_json::json!({
            "access_token": "access-value",
            "refresh_token": "refresh-value",
            "expires_at": expires
        })
        .to_string()
    };
    let reading = |raw: String| match kimi_sign_in_at(&raw, now) {
        Ok(KimiSignIn::Current(token)) => format!("current:{token}"),
        Ok(KimiSignIn::Renewable(token)) => format!("renewable:{token}"),
        Err(error) => error,
    };

    assert_eq!(
        reading(stored((now / 1_000 + 600).into())),
        "current:access-value"
    );
    // A token about to lapse mid-request is treated as already spent.
    assert_eq!(
        reading(stored((now / 1_000 + 30).into())),
        "renewable:refresh-value"
    );
    assert_eq!(reading(stored((now - 1).into())), "renewable:refresh-value");
    // Seconds, milliseconds and a date all name the same moment.
    assert_eq!(
        reading(stored("2001-09-09T01:46:39Z".into())),
        "renewable:refresh-value"
    );
    // The wire format has moved between spellings and nesting; both read.
    assert_eq!(
        reading(
            serde_json::json!({ "token": { "refreshToken": "nested", "expiresAt": 0 } })
                .to_string()
        ),
        "renewable:nested"
    );

    // Nothing left to renew with is the one case that asks for a login.
    assert_eq!(
        reading(serde_json::json!({ "access_token": "access-value", "expires_at": 1 }).to_string()),
        "Kimi Code's sign-in has lapsed. Run `kimi login` to read your plan usage."
    );
    assert_eq!(
        reading("{}".to_string()),
        "Kimi Code credentials do not include an access token."
    );
}

/// A renewal is only as good as what it states. The refresh token it did
/// not rotate stays the stored one, and a lifetime it never promised is
/// not invented — the reading after it renews again instead.
#[test]
fn a_kimi_renewal_keeps_what_the_answer_left_out() {
    let renewal = kimi_sign_in_renewal(
        &serde_json::json!({
            "access_token": "fresh",
            "refresh_token": "rotated",
            "expires_in": 900,
            "scope": "coding",
            "token_type": "Bearer"
        }),
        "previous",
    )
    .unwrap();
    assert_eq!(renewal.access_token, "fresh");
    assert_eq!(renewal.refresh_token, "rotated");
    assert_eq!(renewal.expires_in, 900);

    let sparse =
        kimi_sign_in_renewal(&serde_json::json!({ "access_token": "fresh" }), "previous").unwrap();
    assert_eq!(sparse.refresh_token, "previous");
    assert_eq!(sparse.expires_in, 0);
    assert_eq!(sparse.token_type, "Bearer");

    // The renewal carries the sign-in itself, so it is never made
    // printable; the failure is read off the `Err` side directly.
    assert_eq!(
        kimi_sign_in_renewal(&serde_json::json!({ "expires_in": 900 }), "previous")
            .err()
            .unwrap(),
        "Kimi's sign-in renewal did not include an access token."
    );
}

/// The renewal goes back to the slot it came from in the CLI's own wire
/// shape, so the next `kimi` run reads Gyro's renewal as its own.
#[test]
fn a_kimi_renewal_is_written_back_the_way_the_cli_reads_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("kimi-code.json");
    let now = 1_000_000_000_000i64;
    store_kimi_sign_in(
        &path,
        &KimiSignInRenewal {
            access_token: "fresh".into(),
            refresh_token: "rotated".into(),
            expires_in: 900,
            scope: "coding".into(),
            token_type: "Bearer".into(),
        },
        now,
    )
    .unwrap();

    let written = std::fs::read_to_string(&path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&written).unwrap();
    assert_eq!(parsed["access_token"], "fresh");
    assert_eq!(parsed["refresh_token"], "rotated");
    assert_eq!(parsed["expires_at"], now / 1_000 + 900);
    assert_eq!(parsed["expires_in"], 900);
    // What was written reads back as a current sign-in, and nothing but
    // the slot itself is left behind.
    assert!(matches!(
        kimi_sign_in_at(&written, now).unwrap(),
        KimiSignIn::Current(token) if token == "fresh"
    ));
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
