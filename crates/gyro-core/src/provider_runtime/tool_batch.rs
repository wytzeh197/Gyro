//! Shared tool advertisement, bounded observations and ordered read batches.
use super::{
    catalog::{delegation_tool, ToolCatalog},
    host::RunnerHost,
    reliability as provider_reliability,
    support::efficiency_config,
    types::{ChatMode, ProviderChatRequest},
};
use crate::{
    timing, CapabilityClass, CapabilityId, CapabilityResourceRef, CapabilityResponse,
    CapabilityRunMode, CapabilityStatus,
};
use serde::Serialize;
use std::borrow::Cow;
use std::collections::HashSet;
use uuid::Uuid;
// Explicit allowlist: these observe disk state without changing the workspace,
// opening an editor, running a command, or driving a shared browser session.
pub fn independent_read(id: CapabilityId) -> bool {
    matches!(
        id,
        CapabilityId::WorkspaceList
            | CapabilityId::WorkspaceSearch
            | CapabilityId::WorkspaceRead
            | CapabilityId::WorkspaceReadRange
    )
}

pub fn is_workspace_edit(id: CapabilityId) -> bool {
    matches!(
        id,
        CapabilityId::WorkspaceEdit | CapabilityId::WorkspaceProposeEdit
    )
}

fn roots_may_match(left: Option<&str>, right: Option<&str>) -> bool {
    left.is_none() || right.is_none() || left == right
}

/// Retain failed edits as ordering evidence even when schema validation keeps
/// them out of the executable batch.
#[derive(Default)]
pub(crate) struct RejectedWorkspaceEdits {
    roots: HashSet<Option<String>>,
    missing_paths: Vec<(usize, Option<String>)>,
}

impl RejectedWorkspaceEdits {
    pub(crate) fn is_empty(&self) -> bool {
        self.roots.is_empty()
    }

    pub(crate) fn has_missing_paths(&self) -> bool {
        !self.missing_paths.is_empty()
    }

    pub(crate) fn record(
        &mut self,
        slot: usize,
        name: &str,
        arguments: &serde_json::Value,
        compact: bool,
    ) {
        let (target, arguments) = if compact && name == COMPACT_INVOKE {
            (
                arguments["name"].as_str().unwrap_or_default(),
                &arguments["arguments"],
            )
        } else {
            (name, arguments)
        };
        let capability = CapabilityId::from_provider_tool_name(target);
        if capability.is_some_and(is_workspace_edit) {
            let root = arguments["rootId"].as_str().map(str::to_owned);
            if capability == Some(CapabilityId::WorkspaceEdit)
                && arguments.is_object()
                && arguments.get("path").is_none()
                && arguments["oldString"].is_string()
                && arguments["newString"].is_string()
            {
                self.missing_paths.push((slot, root.clone()));
            }
            self.roots.insert(root);
        }
    }

    pub(crate) fn add_confirmed_path_feedback<'a>(
        &self,
        user_message: &str,
        replies: &mut [Option<serde_json::Value>],
        observed: impl Iterator<Item = (usize, &'a serde_json::Value, &'a CapabilityResponse)> + Clone,
    ) -> bool {
        let mut confirmed = false;
        for (edit_slot, root) in &self.missing_paths {
            let paths = observed
                .clone()
                .filter_map(|(read_slot, args, response)| {
                    let result = response.result.as_ref()?;
                    if read_slot >= *edit_slot
                        || args["rootId"].as_str() != root.as_deref()
                        || response.status != CapabilityStatus::Completed
                        || result.capability_id != CapabilityId::WorkspaceRead
                    {
                        return None;
                    }
                    let path = result.data["path"].as_str()?;
                    (crate::normalize_capability_relative_path(path)
                        .ok()
                        .as_deref()
                        == Some(path)
                        && !crate::capability_path_is_sensitive(path)
                        && names_exact_workspace_path(user_message, path))
                    .then_some(path)
                })
                .collect::<HashSet<_>>();
            let Some(path) = paths.iter().next().filter(|_| paths.len() == 1) else {
                continue;
            };
            if let Some(reply) = replies[*edit_slot].as_mut() {
                if let Some(error) = reply["content"].as_str() {
                    reply["content"] = format!("{error} The user named {path:?}, and an earlier call in this batch read it successfully. If this edit targets that file, retry gyro_workspace_edit with path set to {path:?}. Include oldString and newString again.").into();
                    confirmed = true;
                }
            }
        }
        confirmed
    }

    pub(crate) fn test_reply(
        &self,
        id: CapabilityId,
        arguments: &serde_json::Value,
        name: &str,
        call_id: Option<&str>,
    ) -> anyhow::Result<Option<serde_json::Value>> {
        if self.is_empty() || !is_workspace_test(id, arguments) {
            return Ok(None);
        }
        let root = arguments["rootId"].as_str();
        // An omitted or malformed root could mean the same workspace. Two
        // different explicit roots can be verified independently.
        if !self
            .roots
            .iter()
            .any(|rejected| roots_may_match(rejected.as_deref(), root))
        {
            return Ok(None);
        }
        let response = CapabilityResponse::failed(
            env!("CARGO_PKG_VERSION"),
            Uuid::new_v4(),
            "verification-not-run",
            "No test was started. Gyro rejected an earlier edit in this batch. Correct that edit using its tool error, then submit the test after the change is applied.",
        );
        let mut reply =
            serde_json::json!({"role":"tool", "content":model_response_text(&response)?});
        if let Some(call_id) = call_id {
            reply["tool_call_id"] = call_id.into();
        } else {
            reply["tool_name"] = name.into();
        }
        Ok(Some(reply))
    }
}

fn names_exact_workspace_path(message: &str, path: &str) -> bool {
    fn boundary(character: char) -> bool {
        character.is_whitespace()
            || matches!(
                character,
                '`' | '\'' | '"' | '(' | ')' | '[' | ']' | ',' | ':' | ';' | '!' | '?'
            )
    }
    message.match_indices(path).any(|(start, _)| {
        let before = message[..start].chars().next_back();
        let after = &message[start + path.len()..];
        before.is_none_or(boundary)
            && (after.chars().next().is_none_or(boundary)
                || after
                    .strip_prefix('.')
                    .is_some_and(|rest| rest.chars().next().is_none_or(boundary)))
    })
}

pub(crate) const REQUESTED_VERIFICATION_FOLLOWUP: &str = "Workspace review applied the edits above. Finish the requested changes and run the test the user requested before replying. Report the actual tool result, including the exit code if available.";

pub(crate) fn requests_workspace_test(request: &ProviderChatRequest) -> bool {
    if request.mode != ChatMode::Normal
        || request.workspace_path.is_none()
        || request.internal_purpose.is_some()
    {
        return false;
    }
    let text = request
        .message
        .to_ascii_lowercase()
        .replace("don't", "do not");
    let mut requested = false;
    for clause in text.split(['.', ';', '\n', '!', '?']) {
        let words: Vec<_> = clause
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '-')
            .filter(|word| !word.is_empty())
            .collect();
        for (index, word) in words.iter().enumerate() {
            if !matches!(*word, "run" | "rerun" | "re-run" | "execute") {
                continue;
            }
            let tail = &words[index + 1..];
            let Some(test) = tail.iter().take(6).position(|part| {
                matches!(*part, "test" | "tests" | "--test" | "pytest" | "unittest")
            }) else {
                continue;
            };
            if words[index.saturating_sub(4)..index]
                .iter()
                .chain(&tail[..test])
                .any(|part| {
                    matches!(
                        *part,
                        "not" | "never" | "without" | "avoid" | "skip" | "how" | "whether"
                    )
                })
            {
                return false;
            }
            requested = true;
        }
    }
    requested
}

#[test]
fn verification_review_requires_an_explicit_test_request() {
    let mut request: ProviderChatRequest = serde_json::from_value(serde_json::json!({
        "sessionId":"fixture", "providerId":"ollama", "workspacePath":"/fixture", "message":""
    }))
    .unwrap();
    for (message, expected) in [
        (
            "Fix the workspace code. Then run node --test sum.test.mjs.",
            true,
        ),
        (
            "Please rerun the unit tests after applying the patch.",
            true,
        ),
        ("Add a regression test and wait for review.", false),
        ("Fix the code, but don't run npm test.", false),
        ("Run lint, not the tests.", false),
        ("Show me how to run the tests.", false),
    ] {
        request.message = message.into();
        assert_eq!(requests_workspace_test(&request), expected, "{message}");
    }
    request.message = "Run cargo test after completing the changes.".into();
    request.mode = ChatMode::Plan;
    assert!(!requests_workspace_test(&request));
}

pub(crate) fn review_before_requested_test(
    host: &dyn RunnerHost,
    session_id: &str,
    batch: &[(CapabilityId, serde_json::Value)],
    results: &mut [CapabilityResponse],
    available: &mut bool,
) -> anyhow::Result<bool> {
    if !*available {
        return Ok(false);
    }
    let edits = batch
        .iter()
        .zip(results.iter())
        .enumerate()
        .filter(|(_, ((id, _), _))| is_workspace_edit(*id));
    let mut pending = false;
    for (index, ((_, arguments), response)) in edits {
        match (
            response.status,
            response
                .result
                .as_ref()
                .and_then(|result| result.data["status"].as_str()),
        ) {
            (CapabilityStatus::Completed, Some("pending")) => {
                let root = arguments["rootId"].as_str();
                if batch[index + 1..].iter().any(|(id, args)| {
                    roots_may_match(root, args["rootId"].as_str()) && is_workspace_test(*id, args)
                }) {
                    // A test ordered after this edit already had a chance to
                    // await its review. A baseline test cannot satisfy it.
                    return Ok(false);
                }
                pending = true;
            }
            (CapabilityStatus::Completed, Some("applied")) => {}
            _ => return Ok(false),
        }
    }
    if !pending {
        return Ok(false);
    }
    *available = false;
    host.resolve_workspace_edit_reviews(session_id, results)?;
    Ok(batch
        .iter()
        .zip(results.iter())
        .filter(|((id, _), _)| is_workspace_edit(*id))
        .all(|(_, response)| {
            response
                .result
                .as_ref()
                .is_some_and(|result| result.data["applied"] == true)
        }))
}

#[test]
fn rejected_edit_defers_verification_for_the_same_or_implicit_root() {
    use serde_json::json;
    let mut edits = RejectedWorkspaceEdits::default();
    let command = json!({"rootId":"app","program":"node","args":["--test","sum.test.mjs"]});
    let reply = |edits: &RejectedWorkspaceEdits, args: &serde_json::Value| {
        edits
            .test_reply(
                CapabilityId::WorkspaceRunCommand,
                args,
                "gyro_workspace_run_command",
                Some("test-id"),
            )
            .unwrap()
    };
    assert!(reply(&edits, &command).is_none());
    edits.record(0, "gyro_workspace_read", &json!({"rootId":"app"}), false);
    assert!(reply(&edits, &command).is_none());
    edits.record(
        0,
        COMPACT_INVOKE,
        &json!({"name":"gyro_workspace_edit","arguments":{"rootId":"app"}}),
        true,
    );
    let blocked = reply(&edits, &command).unwrap();
    assert_eq!(blocked["tool_call_id"], "test-id");
    let result: serde_json::Value =
        serde_json::from_str(blocked["content"].as_str().unwrap()).unwrap();
    assert_eq!(result["error"]["code"], "verification-not-run");
    assert!(reply(
        &edits,
        &json!({"rootId":"other","program":"node","args":["--test"]})
    )
    .is_none());
    assert!(reply(
        &edits,
        &json!({"rootId":"app","program":"node","args":["--version"]})
    )
    .is_none());
    assert!(edits
        .test_reply(
            CapabilityId::WorkspaceRunTest,
            &json!({"taskId":"test"}),
            "gyro_workspace_run_test",
            None
        )
        .unwrap()
        .is_some());
    edits.record(
        0,
        "gyro_workspace_propose_edit",
        &json!("malformed input"),
        false,
    );
    assert!(reply(
        &edits,
        &json!({"rootId":"other","program":"node","args":["--test"]})
    )
    .is_some());
}

#[test]
fn missing_edit_path_feedback_requires_one_earlier_user_named_file_in_the_same_root() {
    use serde_json::json;
    let mut rejected = RejectedWorkspaceEdits::default();
    rejected.record(
        2,
        "gyro_workspace_edit",
        &json!({"rootId":"app","oldString":"before","newString":"after"}),
        false,
    );
    let observed_read = |path: &str| {
        CapabilityResponse::completed(
            "fixture",
            crate::CapabilityResult {
                call_id: Uuid::new_v4(),
                capability_id: CapabilityId::WorkspaceRead,
                summary: "Read file".into(),
                data: json!({"path":path}),
                resource: None,
            },
        )
    };
    let primary = observed_read("src/main.mjs");
    let alternate = observed_read("src/other.mjs");
    let app = json!({"rootId":"app"});
    let other = json!({"rootId":"other"});
    let correction =
        |message, observations: Vec<(usize, &serde_json::Value, &CapabilityResponse)>| {
            let mut replies = vec![
                None,
                None,
                Some(json!({"role":"tool","content":"Missing path"})),
            ];
            rejected.add_confirmed_path_feedback(message, &mut replies, observations.into_iter());
            replies[2].as_ref().unwrap()["content"]
                .as_str()
                .unwrap()
                .to_owned()
        };
    assert!(correction("Edit src/main.mjs.", vec![(0, &app, &primary)])
        .contains("path set to \"src/main.mjs\""));
    for (message, observations) in [
        ("Edit src/main.mjs.backup.", vec![(0, &app, &primary)]),
        ("Edit /src/main.mjs.", vec![(0, &app, &primary)]),
        ("Edit src/main.mjs.", vec![(0, &other, &primary)]),
        ("Edit src/main.mjs.", vec![(3, &app, &primary)]),
        (
            "Edit src/main.mjs and src/other.mjs.",
            vec![(0, &app, &primary), (1, &app, &alternate)],
        ),
    ] {
        assert_eq!(correction(message, observations), "Missing path");
    }
}

pub fn model_tools(
    catalog: &dyn ToolCatalog,
    mode: CapabilityRunMode,
    allow_delegation: bool,
) -> Vec<serde_json::Value> {
    model_tools_for(catalog, mode, allow_delegation, &efficiency_config())
}

pub const RETAINED_CATALOG: &str = "Gyro retained tool schemas (local definitions): ";

/// Turn-local schemas only. No user arguments or tool output enter receipts.
#[derive(Default)]
pub struct CatalogMemory {
    pub schemas: std::collections::BTreeMap<String, serde_json::Value>,
    pub overflow: bool,
    compacted: bool,
}

impl CatalogMemory {
    pub fn observe(&mut self, response: &CapabilityResponse) {
        if let Some(result) = response
            .result
            .as_ref()
            .filter(|r| r.capability_id == CapabilityId::ToolCatalog)
        {
            self.page(&result.data);
        }
    }
    pub fn page(&mut self, page: &serde_json::Value) {
        if self.overflow {
            return;
        }
        let Some(entries) = page["tools"].as_array() else {
            return;
        };
        let mut repeated = false;
        for entry in entries {
            let Some(name) = entry["name"].as_str() else {
                continue;
            };
            repeated |= self.compacted && self.schemas.contains_key(name);
            self.schemas.insert(name.into(), entry.clone());
        }
        if repeated {
            crate::provider_observation::efficiency_event(|e| {
                e.catalog_rediscoveries = e.catalog_rediscoveries.saturating_add(1)
            });
        }
        if self.appendix().len() > crate::capabilities::MAX_CAPABILITY_RESULT_BYTES {
            self.overflow = true;
            self.schemas.clear();
        }
    }
    fn appendix(&self) -> String {
        format!(
            "{RETAINED_CATALOG}{}",
            serde_json::to_string(&self.schemas.values().collect::<Vec<_>>()).unwrap_or_default()
        )
    }
    pub fn after_compaction(&mut self, messages: &mut Vec<serde_json::Value>, retain: bool) {
        self.compacted = true;
        messages.retain(|m| {
            !m["content"]
                .as_str()
                .is_some_and(|s| s.starts_with(RETAINED_CATALOG))
        });
        if retain && !self.overflow && !self.schemas.is_empty() {
            // Insert outside tool call/result pairs; never replace the system/user head.
            messages.insert(
                2,
                serde_json::json!({"role":"user", "content":self.appendix()}),
            );
        }
    }
}

pub fn observe_response(response: &CapabilityResponse, spill_requested: bool) {
    crate::provider_observation::efficiency_event(|e| {
        if spill_requested && response.status != CapabilityStatus::Completed {
            e.spill_failures = e.spill_failures.saturating_add(1);
        }
        if let Some(result) = &response.result {
            if result.capability_id == CapabilityId::WorkspaceRead
                && result.data["source"] == "spill"
            {
                e.spill_recoveries = e.spill_recoveries.saturating_add(1);
            }
            match result.data["progressAction"].as_str() {
                Some("correct") => {
                    e.repeated_call_notices = e.repeated_call_notices.saturating_add(1)
                }
                Some("pause") => e.repeated_call_pauses = e.repeated_call_pauses.saturating_add(1),
                _ => {}
            }
        }
    });
}

pub const COMPACT_INVOKE: &str = "gyro_tool_invoke";

pub const COMPACT_INVOKE_DESCRIPTION: &str =
    "Call a Gyro tool discovered by gyro_tool_catalog. Existing policy and approvals still apply.";

/// Absent means the full list, so panes and older launchers fail closed.
pub const COMPACT_CATALOG_ENV: &str = "GYRO_CAPABILITY_COMPACT_CATALOG";

pub const COMPACT_GUIDANCE: &str = "For tools not in the direct list, call gyro_tool_catalog with a domain prefix or exact tool name, then call gyro_tool_invoke with the discovered name and its arguments object. The same Gyro approval and execution rules apply. Prefixes include gyro_workspace_, gyro_code_, gyro_terminal_, gyro_browser_, gyro_git_, gyro_ide_, gyro_github_, gyro_memory_, gyro_research, gyro_agent_, and gyro_task_. Use gyro_ to browse the full catalog.";

pub const BASELINE_GUIDANCE: &str = "Deferred tools include a compact argument schema (names, types, and limits). Call them directly. Use gyro_tool_catalog with the tool's domain prefix only when an argument is still unclear or a call is rejected as invalid.";

pub fn apply_compact_guidance(system: &mut String) {
    if system.contains(BASELINE_GUIDANCE) {
        *system = system.replace(BASELINE_GUIDANCE, COMPACT_GUIDANCE);
    } else {
        system.push('\n');
        system.push_str(COMPACT_GUIDANCE);
    }
}

pub fn compact_invoke_parameters() -> serde_json::Value {
    serde_json::json!({"type":"object","properties":{
        "name":{"type":"string","description":"Exact discovered Gyro tool name."},
        "arguments":{"type":"object","description":"Arguments matching that tool's catalog schema."}
    },"required":["name","arguments"],"additionalProperties":false})
}

/// Only CLIs whose allowlist and approval handling for a new tool were read.
/// Request-owned routes use `compact_tool_catalog` instead.
pub fn compact_cli_catalog_active(provider_id: &str, config: &crate::efficiency::Config) -> bool {
    config.policies()
        && config.compact_cli_catalog
        && matches!(provider_id, "anthropic" | "openai" | "xai" | "kimi")
}

pub const BATCH_GUIDANCE: &str = "When several read-only lookups are already known, request them together in one response instead of one per response. Do not batch a call that depends on an earlier result, or any edit or command.";

pub fn apply_batch_guidance(system: &mut String) {
    system.push('\n');
    system.push_str(BATCH_GUIDANCE);
}

pub const FULL_CATALOG_FALLBACK_NOTICE: &str = "The compact tool catalog could not be retained or read. All permitted tools are now supplied directly; call them by their own names and schemas. Existing approval rules still apply.";

pub fn restore_catalog_guidance(messages: &mut Vec<serde_json::Value>) {
    messages.retain(|m| {
        !m["content"]
            .as_str()
            .is_some_and(|s| s.starts_with(RETAINED_CATALOG))
    });
    if let Some(system) = messages.first_mut().and_then(|m| m.get_mut("content")) {
        if let Some(text) = system.as_str() {
            *system = text.replace(COMPACT_GUIDANCE, BASELINE_GUIDANCE).into();
        }
    }
}

pub fn catalog_discovery_failed(
    compact: bool,
    id: CapabilityId,
    response: &CapabilityResponse,
) -> bool {
    compact && id == CapabilityId::ToolCatalog && response.status != CapabilityStatus::Completed
}

pub fn full_catalog_config(config: &crate::efficiency::Config) -> crate::efficiency::Config {
    let mut restored = config.clone();
    restored.compact_tool_catalog = false;
    restored
}

pub fn model_tools_for(
    catalog: &dyn ToolCatalog,
    mode: CapabilityRunMode,
    allow_delegation: bool,
    config: &crate::efficiency::Config,
) -> Vec<serde_json::Value> {
    let compact = config.policies() && config.compact_tool_catalog;
    let mut tools: Vec<serde_json::Value> = catalog
        .descriptors(mode)
        .filter(|descriptor| allow_delegation || !delegation_tool(descriptor.id))
        .filter(|descriptor| !compact || inline_tool_schema(descriptor.id))
        .map(|descriptor| {
            let mut tool = serde_json::json!({"type": "function"});
            tool["function"] = advertised_tool_definition(catalog, descriptor, "parameters");
            tool
        })
        .collect();
    if compact
        && tools
            .iter()
            .any(|tool| tool["function"]["name"] == "gyro_tool_catalog")
    {
        tools.push(serde_json::json!({"type":"function","function":{
            "name": COMPACT_INVOKE,
            "description": COMPACT_INVOKE_DESCRIPTION,
            "parameters": compact_invoke_parameters(),
        }}));
    }
    if config.policies() && config.cache_assembly {
        crate::efficiency::context::stable_tools(&mut tools);
    }
    tools
}

/// The list a CLI's capability server serves. It shortens the same way
/// `model_tools_for` does, and keeps the descriptor order otherwise.
pub fn mcp_tools_for(
    catalog: &dyn ToolCatalog,
    mode: CapabilityRunMode,
    allow_delegation: bool,
    compact: bool,
) -> Vec<serde_json::Value> {
    let mut tools: Vec<serde_json::Value> = catalog
        .descriptors(mode)
        .filter(|descriptor| allow_delegation || !delegation_tool(descriptor.id))
        .filter(|descriptor| !compact || inline_tool_schema(descriptor.id))
        .map(|descriptor| advertised_tool_definition(catalog, descriptor, "inputSchema"))
        .collect();
    if compact && tools.iter().any(|tool| tool["name"] == "gyro_tool_catalog") {
        tools.push(serde_json::json!({
            "name": COMPACT_INVOKE,
            "description": COMPACT_INVOKE_DESCRIPTION,
            "inputSchema": compact_invoke_parameters(),
        }));
    }
    tools
}

/// Resolve the experimental wrapper only to a capability currently advertised
/// for this mode and delegation posture. The actual broker remains responsible
/// for all workspace, approval, and mutation policy decisions.
pub fn resolve_tool_call(
    catalog: &dyn ToolCatalog,
    name: &str,
    arguments: &serde_json::Value,
    mode: CapabilityRunMode,
    allow_delegation: bool,
    compact: bool,
) -> Result<(CapabilityId, serde_json::Value), String> {
    let (actual_name, actual_arguments) = if name == COMPACT_INVOKE {
        if !compact {
            return Err("Tool is not available in this run. No action was executed.".into());
        }
        let object = arguments
            .as_object()
            .ok_or("Tool arguments must be an object. No action was executed.")?;
        if object.len() != 2 || !object.contains_key("name") || !object.contains_key("arguments") {
            return Err("Provide only name and arguments. No action was executed.".into());
        }
        let target = object["name"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or("Provide the exact discovered tool name. No action was executed.")?;
        (target, &object["arguments"])
    } else {
        (name, arguments)
    };
    let id = provider_reliability::validate_tool_call(catalog, actual_name, actual_arguments)?;
    if compact
        && (!catalog.descriptors(mode).any(|d| d.id == id)
            || (!allow_delegation && delegation_tool(id))
            || (name != COMPACT_INVOKE && !inline_tool_schema(id)))
    {
        return Err("This tool is not offered in the current mode. Discover permitted tools with gyro_tool_catalog. No action was executed.".into());
    }
    Ok((id, actual_arguments.clone()))
}

pub fn prepare_routed_tool_call(
    catalog: &dyn ToolCatalog,
    messages: &mut Vec<serde_json::Value>,
    name: &str,
    arguments: &serde_json::Value,
    call_id: Option<&str>,
    mode: CapabilityRunMode,
    allow_delegation: bool,
    compact: bool,
) -> Option<(CapabilityId, serde_json::Value)> {
    match resolve_tool_call(catalog, name, arguments, mode, allow_delegation, compact) {
        Ok(result) => Some(result),
        Err(error) => {
            let mut reply = serde_json::json!({"role":"tool", "content":error});
            if let Some(id) = call_id {
                reply["tool_call_id"] = id.into();
            } else {
                reply["tool_name"] = name.into();
            }
            messages.push(reply);
            None
        }
    }
}

/// Count a schema-valid request on the provider thread before batching.
/// A later broker denial or failed earlier read may prevent execution; these
/// counts are requests, not evidence that an action happened.
pub fn observe_tool(id: CapabilityId) {
    if id == CapabilityId::ToolCatalog {
        crate::provider_observation::efficiency_event(|e| {
            e.catalog_discoveries = e.catalog_discoveries.saturating_add(1)
        });
    }
    let name = id.provider_tool_name();
    let class = if matches!(
        id,
        CapabilityId::WorkspaceRead
            | CapabilityId::WorkspaceReadRange
            | CapabilityId::WorkspaceReadEditor
    ) {
        "workspace-read"
    } else if id == CapabilityId::WorkspaceSearch {
        "workspace-search"
    } else if id == CapabilityId::WorkspaceList {
        "workspace-list"
    } else if matches!(
        id,
        CapabilityId::WorkspaceEdit | CapabilityId::WorkspaceProposeEdit
    ) || matches!(
        crate::capability_descriptor(id).class,
        CapabilityClass::WorkspaceWrite
    ) {
        "workspace-write"
    } else if name.starts_with("gyro_terminal_") {
        "terminal"
    } else if name.starts_with("gyro_browser_") {
        "browser"
    } else if name.starts_with("gyro_git_")
        || name.starts_with("gyro_workspace_git_")
        || name.starts_with("gyro_github_")
    {
        "git"
    } else if name.starts_with("gyro_web_") {
        "web"
    } else if name.starts_with("gyro_code_") {
        "code"
    } else if name.starts_with("gyro_agent_") || name.starts_with("gyro_research") {
        "agent"
    } else if name.starts_with("gyro_memory_") {
        "memory"
    } else {
        "other"
    };
    crate::provider_observation::observe_tool_class(class);
}

pub fn append_ordered_tool_messages(
    messages: &mut Vec<serde_json::Value>,
    replies: Vec<Option<serde_json::Value>>,
) -> anyhow::Result<()> {
    let replies = replies
        .into_iter()
        .enumerate()
        .map(|(index, reply)| {
            reply.ok_or_else(|| anyhow::anyhow!("missing tool reply at slot {index}"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    messages.extend(replies);
    Ok(())
}

pub fn inline_tool_schema(id: CapabilityId) -> bool {
    matches!(
        id,
        CapabilityId::WorkspaceList
            | CapabilityId::WorkspaceSearch
            | CapabilityId::WorkspaceRead
            | CapabilityId::WorkspaceReadRange
            | CapabilityId::WorkspaceEdit
            | CapabilityId::WorkspaceProposeEdit
            | CapabilityId::TerminalOpen
            | CapabilityId::TerminalRead
            | CapabilityId::TerminalWait
            | CapabilityId::WebFetch
            | CapabilityId::WebSearch
            | CapabilityId::ToolCatalog
    )
}

pub fn catalog_prefix(id: CapabilityId) -> &'static str {
    let name = id.provider_tool_name();
    [
        "gyro_workspace_",
        "gyro_code_",
        "gyro_terminal_",
        "gyro_browser_",
        "gyro_git_",
        "gyro_ide_",
        "gyro_github_",
        "gyro_memory_",
        "gyro_research_",
        "gyro_agent_",
    ]
    .into_iter()
    .find(|prefix| name.starts_with(prefix))
    .unwrap_or("gyro_")
}

/// What the always-on tool list says.
///
/// Inlined tools keep their full description, because the model calls them
/// without a catalog page. Deferred tools keep the first sentence: enough to
/// choose the tool. The catalog page still carries the rest, and that page is
/// left in the request so the model does not pay a round trip to load it again.
pub fn advertised_description(id: CapabilityId, full: &'static str) -> &'static str {
    if inline_tool_schema(id) {
        full
    } else {
        first_sentence(full)
    }
}

/// The first sentence, so a deferred tool does not carry its whole manual on
/// every request. Abbreviations such as "e.g." are not sentence ends.
pub fn first_sentence(text: &str) -> &str {
    let bytes = text.as_bytes();
    let mut start = 0;
    while let Some(relative) = text[start..].find(['.', '!', '?']) {
        let index = start + relative;
        let next = bytes.get(index + 1).copied();
        let boundary = next.is_none_or(|byte| byte.is_ascii_whitespace());
        let previous_word_short = text[..index]
            .rsplit(|character: char| character.is_whitespace())
            .next()
            .is_some_and(|word| word.len() <= 2);
        if boundary && !previous_word_short {
            return &text[..=index];
        }
        start = index + 1;
    }
    text
}

pub fn advertised_tool_parameters(
    catalog: &dyn ToolCatalog,
    id: CapabilityId,
) -> serde_json::Value {
    if inline_tool_schema(id) {
        catalog.schema_ref(id).into_owned()
    } else {
        // Keep concise argument guidance (reference sources, units, defaults)
        // so deferred tools are callable without a discovery round. The catalog
        // retains the complete documentation.
        catalog.compact_schema_ref(id).into_owned()
    }
}

fn advertised_tool_definition(
    catalog: &dyn ToolCatalog,
    descriptor: &crate::CapabilityDescriptor,
    schema_field: &str,
) -> serde_json::Value {
    let id = descriptor.id;
    let mut definition = serde_json::json!({
        "name": id.provider_tool_name(),
        "description": advertised_description(id, descriptor.description),
    });
    // Moving the owned schema into the object avoids serializing its JSON
    // tree back into another Value through the json! macro.
    definition[schema_field] = advertised_tool_parameters(catalog, id);
    definition
}

/// Keep the first sentence of schema documentation, without changing validation
/// or literal data such as defaults and enum values. Only recurse into schema
/// locations: a property named "description" is an argument, not documentation.
pub fn compact_parameter_schema(value: &serde_json::Value) -> serde_json::Value {
    let Some(map) = value.as_object() else {
        return value.clone();
    };
    let mut compact = serde_json::Map::new();
    for (key, child) in map {
        let shortened = match key.as_str() {
            "description" if child.is_string() => {
                serde_json::Value::String(first_sentence(child.as_str().unwrap()).to_string())
            }
            "properties" | "patternProperties" | "$defs" | "definitions" | "dependentSchemas" => {
                if let Some(schemas) = child.as_object() {
                    serde_json::Value::Object(
                        schemas
                            .iter()
                            .map(|(name, schema)| (name.clone(), compact_parameter_schema(schema)))
                            .collect(),
                    )
                } else {
                    child.clone()
                }
            }
            "allOf" | "anyOf" | "oneOf" | "prefixItems" | "items" if child.is_array() => {
                serde_json::Value::Array(
                    child
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(compact_parameter_schema)
                        .collect(),
                )
            }
            "items"
            | "additionalItems"
            | "additionalProperties"
            | "unevaluatedProperties"
            | "unevaluatedItems"
            | "contains"
            | "propertyNames"
            | "not"
            | "if"
            | "then"
            | "else" => compact_parameter_schema(child),
            _ => child.clone(),
        };
        compact.insert(key.clone(), shortened);
    }
    serde_json::Value::Object(compact)
}

pub const SPILL_TEXT_FIELDS: &[&str] = &["content", "stdout", "stderr", "output", "text"];

fn spill_minimum(window: Option<usize>) -> usize {
    use crate::efficiency::spill;
    window.map_or(spill::SPILL_MIN_BYTES, |bytes| {
        bytes.clamp(spill::FRESH_READ_MIN_BYTES, spill::FRESH_READ_MAX_BYTES) + 1
    })
}

fn is_paged_spill_read(capability: &str, data: &serde_json::Value) -> bool {
    matches!(
        capability,
        "workspace.read" | "workspace.read_range" | "workspace.read_editor"
    ) && data["source"] == "spill"
}

fn spills_terminal_pane(capability: &str) -> bool {
    matches!(
        capability,
        "terminal.open" | "terminal.read" | "terminal.wait" | "terminal.input" | "terminal.stop"
    )
}

fn may_spill_result(capability: &str, data: &serde_json::Value, minimum: usize) -> bool {
    !is_paged_spill_read(capability, data)
        && (SPILL_TEXT_FIELDS.iter().any(|field| {
            data[*field]
                .as_str()
                .is_some_and(|text| text.len() >= minimum)
        }) || (spills_terminal_pane(capability)
            && data
                .get("pane")
                .is_some_and(|pane| may_spill_result(capability, pane, minimum))))
}

/// Replace oversized string fields with a head/tail preview and a spill:// address.
/// A failed persist keeps the original text. Errors and image bytes are not passed here.
pub fn spill_result_data(capability: &str, tool: &str, data: &mut serde_json::Value) {
    let window = efficiency_config().fresh_read_window(capability);
    spill_result_data_within(capability, tool, data, window);
}

/// [`spill_result_data`] with the fresh-read window already resolved.
pub fn spill_result_data_within(
    capability: &str,
    tool: &str,
    data: &mut serde_json::Value,
    window: Option<usize>,
) {
    use crate::efficiency::spill;
    // A recovery read is already paged at the tool boundary. Re-spilling it
    // hides the requested middle and leaves offsets describing bytes the model
    // never received, causing recursive recovery calls or skipped evidence.
    if is_paged_spill_read(capability, data) {
        return;
    }
    // Terminal snapshots nest their output under pane, unlike command results.
    // Apply the same recoverable preview there; keep status, paging and revision
    // fields intact. Do not recurse into arbitrary tool data or user documents.
    if spills_terminal_pane(capability) {
        if let Some(pane) = data.get_mut("pane").filter(|pane| pane.is_object()) {
            spill_result_data_within(capability, tool, pane, window);
        }
    }
    let Some(object) = data.as_object_mut() else {
        return;
    };
    let min_bytes = spill_minimum(window);
    for &field in SPILL_TEXT_FIELDS {
        let Some(slot) = object.get_mut(field) else {
            continue;
        };
        let Some(text) = slot.as_str().filter(|text| text.len() >= min_bytes) else {
            continue;
        };
        let preview = match window {
            Some(bytes) => spill::preview_within(capability, tool, text, bytes),
            None => spill::preview(capability, tool, text),
        };
        if preview.address.is_empty() {
            continue;
        }
        if !spill::persist(&preview.address, text) {
            crate::provider_observation::efficiency_event(|e| {
                e.spill_failures = e.spill_failures.saturating_add(1)
            });
            continue;
        }
        *slot = serde_json::Value::String(preview.text);
    }
}

/// Native tools get the same single corrective retry as the JSON bridge.
/// Execution failures are observed results; only an all-invalid name/schema
/// batch spends this recovery budget.
pub fn check_native_tool_recovery(
    valid_calls: usize,
    malformed_responses: &mut usize,
) -> anyhow::Result<()> {
    if valid_calls > 0 {
        *malformed_responses = 0;
        return Ok(());
    }
    *malformed_responses += 1;
    anyhow::ensure!(
        *malformed_responses <= 1,
        "The model returned only invalid Gyro tool calls after one corrective retry; no invalid actions were executed. Check the tool names and arguments before continuing."
    );
    Ok(())
}

/// Keep actionable capability evidence in provider context without repeatedly
/// sending the desktop IPC envelope, duplicate call ids, or absent fields.
pub fn model_response_text(response: &CapabilityResponse) -> anyhow::Result<String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Evidence<'a> {
        capability_id: CapabilityId,
        summary: &'a str,
        data: Cow<'a, serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resource: Option<&'a CapabilityResourceRef>,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        status: CapabilityStatus,
        call_id: Uuid,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Evidence<'a>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a crate::capabilities::CapabilityError>,
        #[serde(skip_serializing_if = "Option::is_none")]
        compatible: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        schema: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        app_version: Option<&'a str>,
    }
    // Borrow potentially large evidence instead of cloning its JSON tree.
    let payload = Payload {
        status: response.status,
        call_id: response.call_id,
        result: response.result.as_ref().map(|result| {
            let capability = result.capability_id.as_str();
            let window = efficiency_config().fresh_read_window(capability);
            let data = if may_spill_result(capability, &result.data, spill_minimum(window)) {
                let mut data = result.data.clone();
                spill_result_data_within(
                    capability,
                    result.capability_id.provider_tool_name(),
                    &mut data,
                    window,
                );
                Cow::Owned(data)
            } else {
                Cow::Borrowed(&result.data)
            };
            Evidence {
                capability_id: result.capability_id,
                summary: &result.summary,
                data,
                resource: result.resource.as_ref(),
            }
        }),
        error: response.error.as_ref(),
        compatible: (!response.compatible).then_some(false),
        schema: (!response.compatible).then_some(response.schema.as_str()),
        app_version: (!response.compatible).then_some(response.app_version.as_str()),
    };
    Ok(serde_json::to_string(&payload)?)
}

pub fn is_workspace_test(id: CapabilityId, arguments: &serde_json::Value) -> bool {
    id == CapabilityId::WorkspaceRunTest
        || (id == CapabilityId::WorkspaceRunCommand
            && crate::execution::is_foreground_test_command(
                arguments["program"].as_str().unwrap_or_default(),
                arguments["args"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(serde_json::Value::as_str),
            ))
}

pub(super) fn execute_with_reused_tests(
    calls: &[(CapabilityId, serde_json::Value)],
    slots: impl Iterator<Item = usize>,
    user_message: &str,
    execute: impl FnOnce(
        &[(CapabilityId, serde_json::Value)],
    ) -> anyhow::Result<Vec<CapabilityResponse>>,
) -> anyhow::Result<Vec<CapabilityResponse>> {
    let mut duplicates = Vec::new();
    let mut previous_slot: Option<usize> = None;
    let mut first = 0;
    for (index, slot) in slots.enumerate() {
        if previous_slot.is_some_and(|previous| previous.checked_add(1) == Some(slot))
            && calls[index] == calls[index - 1]
            && is_reusable_foreground_test(&calls[index])
        {
            duplicates.push((index, first));
        } else {
            first = index;
        }
        previous_slot = Some(slot);
    }
    if duplicates.is_empty() || requests_repeated_tests(user_message) {
        return execute(calls);
    }

    let mut omitted = duplicates.iter().peekable();
    let unique = calls
        .iter()
        .enumerate()
        .filter_map(|(index, call)| {
            if omitted
                .next_if(|(duplicate, _)| *duplicate == index)
                .is_some()
            {
                None
            } else {
                Some(call.clone())
            }
        })
        .collect::<Vec<_>>();
    let mut executed = execute(&unique)?.into_iter();
    let mut omitted = duplicates.into_iter().peekable();
    let mut results = Vec::with_capacity(calls.len());
    for index in 0..calls.len() {
        if let Some((_, first)) = omitted.next_if(|(duplicate, _)| *duplicate == index) {
            results.push(reused_test_response(&results[first]));
        } else {
            results.push(
                executed
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("missing executed test batch result"))?,
            );
        }
    }
    anyhow::ensure!(executed.next().is_none(), "unexpected test batch result");
    Ok(results)
}

fn is_reusable_foreground_test((id, arguments): &(CapabilityId, serde_json::Value)) -> bool {
    !arguments["background"].as_bool().unwrap_or(false)
        && arguments["networkDestinations"]
            .as_array()
            .is_none_or(Vec::is_empty)
        && is_workspace_test(*id, arguments)
}

fn requests_repeated_tests(message: &str) -> bool {
    message
        .to_ascii_lowercase()
        .split(|character: char| !character.is_ascii_alphabetic() && character != '-')
        .any(|word| {
            matches!(
                word,
                "again"
                    | "repeat"
                    | "repeated"
                    | "repeatedly"
                    | "repetition"
                    | "rerun"
                    | "reruns"
                    | "re-run"
                    | "twice"
                    | "thrice"
                    | "times"
                    | "iterations"
                    | "consecutive"
                    | "flaky"
                    | "flake"
                    | "flakiness"
            )
        })
}

fn reused_test_response(original: &CapabilityResponse) -> CapabilityResponse {
    let call_id = Uuid::new_v4();
    let mut response = CapabilityResponse {
        schema: original.schema.clone(),
        app_version: original.app_version.clone(),
        compatible: original.compatible,
        call_id,
        status: original.status,
        result: None,
        error: original.error.clone(),
    };
    if let Some(result) = &original.result {
        let mut data = serde_json::json!({"reusedCallId": original.call_id, "executed": false});
        for field in ["status", "exitCode"] {
            if let Some(value) = result.data.get(field) {
                data[field] = value.clone();
            }
        }
        response.result = Some(crate::CapabilityResult {
            call_id,
            capability_id: result.capability_id,
            summary: "This identical test used the preceding tool result. Gyro started no additional test process.".into(),
            data,
            resource: None,
        });
    }
    if let Some(error) = &mut response.error {
        error.message = format!("This duplicate test did not start another process. Use the earlier test result ({}). {}", original.call_id, error.message);
    }
    response
}

#[test]
fn reuses_one_observed_result_for_adjacent_identical_tests() {
    use serde_json::json;
    let calls = [
        (
            CapabilityId::WorkspaceRunCommand,
            json!({"program":"node","args":["--test","sum.test.mjs"],"cwd":"."}),
        ),
        (
            CapabilityId::WorkspaceRunCommand,
            json!({"cwd":".","args":["--test","sum.test.mjs"],"program":"node"}),
        ),
        (
            CapabilityId::WorkspaceRunCommand,
            json!({"program":"node","args":["--test","sum.test.mjs"],"cwd":"."}),
        ),
    ];
    let source_id = Uuid::new_v4();
    let results = execute_with_reused_tests(&calls, 0..3, "Run the test", |unique| {
        assert_eq!(unique, &calls[..1]);
        Ok(vec![CapabilityResponse::completed(
            "fixture",
            crate::CapabilityResult {
                call_id: source_id,
                capability_id: CapabilityId::WorkspaceRunCommand,
                summary: "Test failed".into(),
                data: json!({"status":"failed","exitCode":1,"stdout":"Long test output"}),
                resource: None,
            },
        )])
    })
    .unwrap();
    assert_eq!(results.len(), 3);
    assert_eq!(results[0].call_id, source_id);
    assert_eq!(
        results[0].result.as_ref().unwrap().data["stdout"],
        "Long test output"
    );
    for result in &results[1..] {
        assert_ne!(result.call_id, source_id);
        assert_eq!(
            result.result.as_ref().unwrap().data,
            json!({"reusedCallId":source_id,"executed":false,"status":"failed","exitCode":1})
        );
    }
    assert_ne!(results[1].call_id, results[2].call_id);
}

#[test]
fn preserves_explicit_repeats_and_test_boundaries() {
    use serde_json::json;
    let test = (CapabilityId::WorkspaceRunTest, json!({"taskId":"test"}));
    let background = (
        CapabilityId::WorkspaceRunTest,
        json!({"taskId":"test","background":true}),
    );
    let network = (
        CapabilityId::WorkspaceRunCommand,
        json!({"program":"node","args":["--test"],"networkDestinations":["example.com"]}),
    );
    let other = (
        CapabilityId::WorkspaceRunCommand,
        json!({"program":"node","args":["--version"]}),
    );
    for (call, slots, prompt) in [
        (test.clone(), [0, 1], "Run the exact same test twice."),
        (test, [0, 2], "Run the test."),
        (background, [0, 1], "Run the test."),
        (network, [0, 1], "Run the test."),
        (other, [0, 1], "Run the command."),
    ] {
        let calls = [call.clone(), call];
        execute_with_reused_tests(&calls, slots.into_iter(), prompt, |unique| {
            assert_eq!(unique, calls);
            Ok(vec![])
        })
        .unwrap();
    }
}

#[test]
fn a_denied_test_is_not_resent_for_duplicate_approval() {
    let call = (
        CapabilityId::WorkspaceRunTest,
        serde_json::json!({"taskId":"test"}),
    );
    let denied = CapabilityResponse::failed("fixture", Uuid::new_v4(), "denied", "Approval denied");
    let calls = [call.clone(), call];
    let results = execute_with_reused_tests(&calls, 0..2, "Run the test", |unique| {
        assert_eq!(unique, &calls[..1]);
        Ok(vec![denied.clone()])
    })
    .unwrap();
    assert_eq!(results[0], denied);
    assert!(results[1].result.is_none());
    assert_eq!(results[1].status, denied.status);
    let error = results[1].error.as_ref().unwrap();
    assert_eq!(error.code, "denied");
    assert!(error.message.contains(&denied.call_id.to_string()));
}

pub fn ordered<T: Send>(
    calls: &[(CapabilityId, serde_json::Value)],
    invoke: impl Fn(CapabilityId, &serde_json::Value) -> anyhow::Result<T> + Sync,
) -> anyhow::Result<Vec<T>> {
    let mut results = Vec::with_capacity(calls.len());
    let mut offset = 0;
    while offset < calls.len() {
        if !independent_read(calls[offset].0) {
            results.push(invoke(calls[offset].0, &calls[offset].1)?);
            offset += 1;
            continue;
        }
        let count = calls[offset..]
            .iter()
            .take(4)
            .take_while(|(id, _)| independent_read(*id))
            .count();
        if count == 1 {
            results.push(invoke(calls[offset].0, &calls[offset].1)?);
            offset += 1;
            continue;
        }
        let trace = timing::capture();
        let batch = std::thread::scope(|scope| {
            // The existing runner worker handles one read while up to three
            // peers run beside it. This keeps the four-read limit without
            // paying for a thread that merely waits on the other readers.
            let workers = calls[offset..offset + count - 1]
                .iter()
                .map(|(id, arguments)| {
                    let invoke = &invoke;
                    let trace = trace.clone();
                    std::thread::Builder::new().spawn_scoped(scope, move || {
                        let _trace = timing::attach(trace);
                        invoke(*id, arguments)
                    })
                })
                .collect::<Vec<_>>();
            let last = &calls[offset + count - 1];
            let last_result = read_on_worker(|| invoke(last.0, &last.1));
            // Join all readers before crossing a write barrier, even on error.
            let mut batch = workers
                .into_iter()
                .enumerate()
                .map(|(index, worker)| match worker {
                    Ok(worker) => worker
                        .join()
                        .unwrap_or_else(|_| Err(anyhow::anyhow!("Gyro tool worker failed"))),
                    // A resource-limited host can still read on the existing
                    // worker, without failing the turn and replaying tools.
                    Err(_) => {
                        let (id, arguments) = &calls[offset + index];
                        read_on_worker(|| invoke(*id, arguments))
                    }
                })
                .collect::<Vec<_>>();
            batch.push(last_result);
            batch
        });
        for result in batch {
            results.push(result?);
        }
        offset += count;
    }
    Ok(results)
}

pub fn read_on_worker<T>(invoke: impl FnOnce() -> anyhow::Result<T>) -> anyhow::Result<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(invoke))
        .unwrap_or_else(|_| Err(anyhow::anyhow!("Gyro tool worker failed")))
}

#[cfg(test)]
mod terminal_evidence_tests {
    use super::*;
    use crate::efficiency::spill;
    use serde_json::json;

    #[test]
    fn nested_terminal_output_is_bounded_recoverable_and_idempotent() {
        let output = format!(
            "START\n{}\nFAILED: exact diagnostic 🦀",
            "build detail\n".repeat(1000)
        );
        for capability in [
            "terminal.open",
            "terminal.read",
            "terminal.wait",
            "terminal.stop",
        ] {
            let mut data = json!({
                "completed": true,
                "exitCode": 101,
                "pane": {
                    "output": output,
                    "outputRevision": 42,
                    "outputComplete": true,
                    "status": "done",
                    "command": "cargo test"
                },
                "outputWindow": {"offset": 900, "nextOffset": null, "previousOffset": 0},
                "owner": {"kind": "model", "callId": "original"}
            });
            let original = data.clone();
            spill_result_data_within(capability, "gyro_terminal_read", &mut data, None);
            let preview = data["pane"]["output"].as_str().unwrap();
            assert!(preview.starts_with("START\n"));
            assert!(preview.ends_with("FAILED: exact diagnostic 🦀"));
            assert!(preview.len() * 4 < output.len());
            let address = spill::address(capability, "gyro_terminal_read", &output);
            assert!(preview.contains(&address));
            let restored = spill::read_window(&address, 0, output.len())
                .unwrap()
                .unwrap();
            assert_eq!(restored.text, output);
            let mut metadata = data.clone();
            metadata["pane"]["output"] = original["pane"]["output"].clone();
            assert_eq!(metadata, original);
            let first = data.clone();
            spill_result_data_within(capability, "gyro_terminal_read", &mut data, None);
            assert_eq!(data, first);
        }
    }

    #[test]
    fn small_terminal_output_and_unrelated_nested_data_stay_exact() {
        let mut small = json!({"pane": {"output": "exact output\n"}, "exitCode": null});
        let original = small.clone();
        spill_result_data_within("terminal.read", "gyro_terminal_read", &mut small, None);
        assert_eq!(small, original);
        let mut document = json!({"pane": {"output": "user data".repeat(1000)}});
        let original = document.clone();
        spill_result_data_within("workspace.read", "gyro_workspace_read", &mut document, None);
        assert_eq!(document, original);
    }
}

pub fn mark_browser_image_attached(response: &mut CapabilityResponse) {
    if let Some(result) = response.result.as_mut() {
        result.data["evidence"]["screenshotModelVisible"] = serde_json::json!(true);
        result.data["evidence"]["visualNote"] = serde_json::json!(
            "PNG image content is attached. Visual inspection requires an image-capable model and client."
        );
    }
}
