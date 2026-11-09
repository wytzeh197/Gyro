#[cfg(test)]
use crate::{capabilities::mcp_server::desktop_capability_tool_schema, provider_tool_batch};

#[cfg(test)]
use gyro_core::provider_runtime::runners::ollama::{
    append_ollama_tool_responses, append_ordered_ollama_tool_responses,
};
#[cfg(test)]
pub(crate) use gyro_core::provider_runtime::runners::ollama::{
    ollama_compatibility_system, parse_ollama_compatibility_action,
};
#[cfg(test)]
use gyro_core::CapabilityId;
#[cfg(test)]
use gyro_core::CapabilityResponse;
use gyro_core::CapabilityRunMode;
#[cfg(test)]
use uuid::Uuid;
pub(crate) fn ollama_compatibility_catalog(
    mode: CapabilityRunMode,
    prefix: Option<&str>,
    offset: usize,
    allow_delegation: bool,
) -> serde_json::Value {
    gyro_core::provider_runtime::runners::ollama::ollama_compatibility_catalog(
        &crate::providers::catalog::DESKTOP_TOOL_CATALOG,
        mode,
        prefix,
        offset,
        allow_delegation,
    )
}
#[cfg(test)]
pub(crate) fn validate_ollama_compatibility_call(
    name: &str,
    arguments: &serde_json::Value,
    mode: CapabilityRunMode,
) -> anyhow::Result<CapabilityId> {
    gyro_core::provider_runtime::runners::ollama::validate_ollama_compatibility_call(
        &crate::providers::catalog::DESKTOP_TOOL_CATALOG,
        name,
        arguments,
        mode,
    )
}
#[cfg(test)]
mod tool_message_tests {
    use super::*;
    use gyro_core::CapabilityResult;

    #[test]
    fn targeted_bridge_discovery_avoids_sending_a_whole_domain() {
        let broad = ollama_compatibility_catalog(
            CapabilityRunMode::Normal,
            Some("gyro_workspace_"),
            0,
            true,
        );
        let targeted = ollama_compatibility_catalog(
            CapabilityRunMode::Normal,
            Some("gyro_workspace_read_range"),
            0,
            true,
        );
        assert_eq!(targeted["total"], 1);
        assert_eq!(targeted["tools"][0]["name"], "gyro_workspace_read_range");
        assert_eq!(
            targeted["tools"][0]["parameters"],
            desktop_capability_tool_schema(CapabilityId::WorkspaceReadRange)
        );
        assert_eq!(targeted["nextOffset"], serde_json::Value::Null);
        let broad_bytes = serde_json::to_vec(&broad).unwrap().len();
        let targeted_bytes = serde_json::to_vec(&targeted).unwrap().len();
        assert!(targeted_bytes * 4 < broad_bytes);
        eprintln!(
            "bridge discovery: {broad_bytes} -> {targeted_bytes} bytes for exact read-range schema"
        );
        let protocol = ollama_compatibility_system("Model identity.");
        assert!(protocol.contains("reuse schemas already supplied"));
        for domain in [
            "gyro_agent_",
            "gyro_research_",
            "gyro_memory_",
            "gyro_github_",
        ] {
            assert!(protocol.contains(domain));
        }
    }

    #[test]
    fn mixed_wrapper_results_keep_call_order_and_screenshots_last() {
        let make_response = |summary: &str| {
            CapabilityResponse::completed(
                "test",
                CapabilityResult {
                    call_id: Uuid::new_v4(),
                    capability_id: CapabilityId::BrowserScreenshot,
                    summary: summary.into(),
                    data: serde_json::json!({"evidence": {}}),
                    resource: None,
                },
            )
        };
        let mut error = Vec::new();
        assert!(provider_tool_batch::prepare_routed_tool_call(
            &mut error,
            provider_tool_batch::COMPACT_INVOKE,
            &serde_json::json!({"name":"gyro_workspace_read","arguments":{}}),
            None,
            CapabilityRunMode::Normal,
            false,
            true,
        )
        .is_none());
        let mut messages = Vec::new();
        append_ordered_ollama_tool_responses(
            &mut messages,
            vec![None, error.pop(), None],
            [
                (
                    0,
                    "gyro_tool_invoke".into(),
                    make_response("first"),
                    Some("pixels".into()),
                ),
                (2, "gyro_tool_invoke".into(), make_response("third"), None),
            ],
        )
        .unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|m| m["role"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["tool", "tool", "tool", "user"]
        );
        assert!(messages[..3]
            .iter()
            .all(|m| m["tool_name"] == "gyro_tool_invoke"));
        let first: serde_json::Value =
            serde_json::from_str(messages[0]["content"].as_str().unwrap()).unwrap();
        let third: serde_json::Value =
            serde_json::from_str(messages[2]["content"].as_str().unwrap()).unwrap();
        assert_eq!(first["result"]["summary"], "first");
        assert!(messages[1]["content"]
            .as_str()
            .unwrap()
            .contains("No action was executed"));
        assert_eq!(third["result"]["summary"], "third");
        assert_eq!(messages[3]["images"], serde_json::json!(["pixels"]));
    }

    #[test]
    fn multiple_tool_results_stay_together_before_their_screenshots() {
        let screenshot_call = Uuid::new_v4();
        let screenshot = CapabilityResponse::completed(
            "test",
            CapabilityResult {
                call_id: screenshot_call,
                capability_id: CapabilityId::BrowserScreenshot,
                summary: "Screenshot captured".into(),
                data: serde_json::json!({"evidence": {}}),
                resource: None,
            },
        );
        let failed_call = Uuid::new_v4();
        let failed = CapabilityResponse::failed("test", failed_call, "missing", "File missing");
        let mut messages = vec![serde_json::json!({"role": "assistant", "tool_calls": []})];
        append_ollama_tool_responses(
            &mut messages,
            [
                ("screenshot".into(), screenshot, Some("image-data".into())),
                ("read".into(), failed, None),
            ],
        )
        .unwrap();
        let roles = messages
            .iter()
            .map(|message| message["role"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(roles, ["assistant", "tool", "tool", "user"]);
        let screenshot_result: serde_json::Value =
            serde_json::from_str(messages[1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(
            screenshot_result["result"]["data"]["evidence"]["screenshotModelVisible"],
            true
        );
        let failed_result: serde_json::Value =
            serde_json::from_str(messages[2]["content"].as_str().unwrap()).unwrap();
        assert_eq!(failed_result["callId"], failed_call.to_string());
        assert_eq!(failed_result["error"]["code"], "missing");
        assert_eq!(messages[3]["images"], serde_json::json!(["image-data"]));
        assert!(messages[3]["content"]
            .as_str()
            .unwrap()
            .contains(&screenshot_call.to_string()));
    }
}
