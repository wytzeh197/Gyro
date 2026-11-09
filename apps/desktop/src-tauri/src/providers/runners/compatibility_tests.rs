use super::*;

#[test]
fn compatibility_tool_requests_follow_the_advertised_schema_and_mode() {
    assert_eq!(
        validate_ollama_compatibility_call(
            "gyro_workspace_get_context",
            &serde_json::json!({}),
            CapabilityRunMode::Normal,
        )
        .unwrap(),
        CapabilityId::WorkspaceContext,
    );
    assert!(validate_ollama_compatibility_call(
        "gyro_workspace_read_editor",
        &serde_json::json!({"path":"src/main.rs", "selectionOnly":true}),
        CapabilityRunMode::Normal,
    )
    .is_ok());
    assert!(validate_ollama_compatibility_call(
        "gyro_workspace_read_editor",
        &serde_json::json!({"selectionOnly":true}),
        CapabilityRunMode::Normal,
    )
    .is_err());
    assert!(validate_ollama_compatibility_call(
        "gyro_workspace_get_context",
        &serde_json::json!({"unexpected":1}),
        CapabilityRunMode::Normal,
    )
    .is_err());
    assert!(validate_ollama_compatibility_call(
        "gyro_workspace_list",
        &serde_json::json!({"depth": 99}),
        CapabilityRunMode::Normal,
    )
    .is_err());
    assert!(validate_ollama_compatibility_call(
        "gyro_workspace_search",
        &serde_json::json!({"query":"x", "globs":[3]}),
        CapabilityRunMode::Normal,
    )
    .is_err());
    assert!(validate_ollama_compatibility_call(
        "gyro_workspace_edit",
        &serde_json::json!({"path":"a", "oldString":"x", "newString":"y"}),
        CapabilityRunMode::Plan,
    )
    .is_err());
    let catalog = ollama_compatibility_catalog(
        CapabilityRunMode::Normal,
        Some("gyro_workspace_read_editor"),
        0,
        true,
    );
    assert_eq!(catalog["total"], 1);
    assert_eq!(catalog["tools"][0]["name"], "gyro_workspace_read_editor");
}
