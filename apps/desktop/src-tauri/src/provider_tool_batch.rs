use crate::{
    capabilities::mcp_server::{advertised_capability_descriptors, desktop_capability_tool_schema},
    delegated_agents, efficiency, provider_reliability,
    providers::tauri_host::invoke_run_capability,
};
use gyro_core::{
    timing, CapabilityClass, CapabilityId, CapabilityResourceRef, CapabilityResponse,
    CapabilityRunMode, CapabilityStatus,
};
use serde::Serialize;
use uuid::Uuid;
// Explicit allowlist: these observe disk state without changing the workspace,
// opening an editor, running a command, or driving a shared browser session.
fn independent_read(id: CapabilityId) -> bool {
    matches!(
        id,
        CapabilityId::WorkspaceList
            | CapabilityId::WorkspaceSearch
            | CapabilityId::WorkspaceRead
            | CapabilityId::WorkspaceReadRange
    )
}

pub(super) fn model_tools(
    mode: CapabilityRunMode,
    allow_delegation: bool,
) -> Vec<serde_json::Value> {
    model_tools_for(mode, allow_delegation, &efficiency::config())
}

const RETAINED_CATALOG: &str = "Gyro retained tool schemas (local definitions): ";

/// Turn-local schemas only. No user arguments or tool output enter receipts.
#[derive(Default)]
pub(super) struct CatalogMemory {
    schemas: std::collections::BTreeMap<String, serde_json::Value>,
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
            gyro_core::provider_observation::efficiency_event(|e| {
                e.catalog_rediscoveries = e.catalog_rediscoveries.saturating_add(1)
            });
        }
        if self.appendix().len() > gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES {
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

pub(super) fn observe_response(response: &CapabilityResponse, spill_requested: bool) {
    gyro_core::provider_observation::efficiency_event(|e| {
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

pub(super) const COMPACT_INVOKE: &str = "gyro_tool_invoke";
const COMPACT_INVOKE_DESCRIPTION: &str =
    "Call a Gyro tool discovered by gyro_tool_catalog. Existing policy and approvals still apply.";
/// Absent means the full list, so panes and older launchers fail closed.
pub(super) const COMPACT_CATALOG_ENV: &str = "GYRO_CAPABILITY_COMPACT_CATALOG";
pub(super) const COMPACT_GUIDANCE: &str = "For tools not in the direct list, call gyro_tool_catalog with a domain prefix or exact tool name, then call gyro_tool_invoke with the discovered name and its arguments object. The same Gyro approval and execution rules apply. Prefixes include gyro_workspace_, gyro_code_, gyro_terminal_, gyro_browser_, gyro_git_, gyro_ide_, gyro_github_, gyro_memory_, gyro_research, gyro_agent_, and gyro_task_. Use gyro_ to browse the full catalog.";
pub(super) const BASELINE_GUIDANCE: &str = "Deferred tools include a compact argument schema (names, types, and limits). Call them directly. Use gyro_tool_catalog with the tool's domain prefix only when an argument is still unclear or a call is rejected as invalid.";

pub(super) fn apply_compact_guidance(system: &mut String) {
    if system.contains(BASELINE_GUIDANCE) {
        *system = system.replace(BASELINE_GUIDANCE, COMPACT_GUIDANCE);
    } else {
        system.push('\n');
        system.push_str(COMPACT_GUIDANCE);
    }
}

fn compact_invoke_parameters() -> serde_json::Value {
    serde_json::json!({"type":"object","properties":{
        "name":{"type":"string","description":"Exact discovered Gyro tool name."},
        "arguments":{"type":"object","description":"Arguments matching that tool's catalog schema."}
    },"required":["name","arguments"],"additionalProperties":false})
}

/// Only CLIs whose allowlist and approval handling for a new tool were read.
/// Request-owned routes use `compact_tool_catalog` instead.
pub(super) fn compact_cli_catalog_active(
    provider_id: &str,
    config: &gyro_core::efficiency::Config,
) -> bool {
    config.policies()
        && config.compact_cli_catalog
        && matches!(provider_id, "anthropic" | "openai" | "xai" | "kimi")
}

pub(super) const BATCH_GUIDANCE: &str = "When several read-only lookups are already known, request them together in one response instead of one per response. Do not batch a call that depends on an earlier result, or any edit or command.";

pub(super) fn apply_batch_guidance(system: &mut String) {
    system.push('\n');
    system.push_str(BATCH_GUIDANCE);
}

pub(super) const FULL_CATALOG_FALLBACK_NOTICE: &str = "The compact tool catalog could not be retained or read. All permitted tools are now supplied directly; call them by their own names and schemas. Existing approval rules still apply.";

pub(super) fn restore_catalog_guidance(messages: &mut Vec<serde_json::Value>) {
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

pub(super) fn catalog_discovery_failed(
    compact: bool,
    id: CapabilityId,
    response: &CapabilityResponse,
) -> bool {
    compact && id == CapabilityId::ToolCatalog && response.status != CapabilityStatus::Completed
}

pub(super) fn full_catalog_config(
    config: &gyro_core::efficiency::Config,
) -> gyro_core::efficiency::Config {
    let mut restored = config.clone();
    restored.compact_tool_catalog = false;
    restored
}

pub(super) fn model_tools_for(
    mode: CapabilityRunMode,
    allow_delegation: bool,
    config: &gyro_core::efficiency::Config,
) -> Vec<serde_json::Value> {
    let compact = config.policies() && config.compact_tool_catalog;
    let mut tools: Vec<serde_json::Value> = advertised_capability_descriptors(mode)
        .filter(|descriptor| allow_delegation || !delegated_agents::delegation_tool(descriptor.id))
        .filter(|descriptor| !compact || inline_tool_schema(descriptor.id))
        .map(|descriptor| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": descriptor.id.provider_tool_name(),
                    "description": advertised_description(descriptor.id, descriptor.description),
                    "parameters": advertised_tool_parameters(descriptor.id),
                }
            })
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
        gyro_core::efficiency::context::stable_tools(&mut tools);
    }
    tools
}

/// The list a CLI's capability server serves. It shortens the same way
/// `model_tools_for` does, and keeps the descriptor order otherwise.
pub(super) fn mcp_tools_for(
    mode: CapabilityRunMode,
    allow_delegation: bool,
    compact: bool,
) -> Vec<serde_json::Value> {
    let mut tools: Vec<serde_json::Value> = advertised_capability_descriptors(mode)
        .filter(|descriptor| allow_delegation || !delegated_agents::delegation_tool(descriptor.id))
        .filter(|descriptor| !compact || inline_tool_schema(descriptor.id))
        .map(|descriptor| {
            serde_json::json!({
                "name": descriptor.id.provider_tool_name(),
                "description": advertised_description(descriptor.id, descriptor.description),
                "inputSchema": advertised_tool_parameters(descriptor.id),
            })
        })
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
pub(super) fn resolve_tool_call(
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
    let id = provider_reliability::validate_tool_call(actual_name, actual_arguments)?;
    if compact
        && (!advertised_capability_descriptors(mode).any(|d| d.id == id)
            || (!allow_delegation && delegated_agents::delegation_tool(id))
            || (name != COMPACT_INVOKE && !inline_tool_schema(id)))
    {
        return Err("This tool is not offered in the current mode. Discover permitted tools with gyro_tool_catalog. No action was executed.".into());
    }
    Ok((id, actual_arguments.clone()))
}

pub(super) fn prepare_routed_tool_call(
    messages: &mut Vec<serde_json::Value>,
    name: &str,
    arguments: &serde_json::Value,
    call_id: Option<&str>,
    mode: CapabilityRunMode,
    allow_delegation: bool,
    compact: bool,
) -> Option<(CapabilityId, serde_json::Value)> {
    match resolve_tool_call(name, arguments, mode, allow_delegation, compact) {
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
pub(super) fn observe_tool(id: CapabilityId) {
    if id == CapabilityId::ToolCatalog {
        gyro_core::provider_observation::efficiency_event(|e| {
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
        gyro_core::capability_descriptor(id).class,
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
    gyro_core::provider_observation::observe_tool_class(class);
}

pub(super) fn append_ordered_tool_messages(
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

pub(super) fn inline_tool_schema(id: CapabilityId) -> bool {
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
            | CapabilityId::ToolCatalog
    )
}

pub(super) fn catalog_prefix(id: CapabilityId) -> &'static str {
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
pub(super) fn advertised_description(id: CapabilityId, full: &'static str) -> &'static str {
    if inline_tool_schema(id) {
        full
    } else {
        first_sentence(full)
    }
}

/// The first sentence, so a deferred tool does not carry its whole manual on
/// every request. Abbreviations such as "e.g." are not sentence ends.
fn first_sentence(text: &str) -> &str {
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

pub(super) fn advertised_tool_parameters(id: CapabilityId) -> serde_json::Value {
    let schema = desktop_capability_tool_schema(id);
    if inline_tool_schema(id) {
        schema
    } else {
        // Keep concise argument guidance (reference sources, units, defaults)
        // so deferred tools are callable without a discovery round. The catalog
        // retains the complete documentation.
        compact_parameter_schema(&schema)
    }
}

/// Keep the first sentence of schema documentation, without changing validation
/// or literal data such as defaults and enum values. Only recurse into schema
/// locations: a property named "description" is an argument, not documentation.
pub(super) fn compact_parameter_schema(value: &serde_json::Value) -> serde_json::Value {
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

const SPILL_TEXT_FIELDS: &[&str] = &["content", "stdout", "stderr", "output", "text"];

/// Replace oversized string fields with a head/tail preview and a spill:// address.
/// A failed persist keeps the original text. Errors and image bytes are not passed here.
pub(super) fn spill_result_data(capability: &str, tool: &str, data: &mut serde_json::Value) {
    let window = super::efficiency::config().fresh_read_window(capability);
    spill_result_data_within(capability, tool, data, window);
}

/// [`spill_result_data`] with the fresh-read window already resolved.
fn spill_result_data_within(
    capability: &str,
    tool: &str,
    data: &mut serde_json::Value,
    window: Option<usize>,
) {
    use gyro_core::efficiency::spill;
    let Some(object) = data.as_object() else {
        return;
    };
    let min_bytes = window.map_or(spill::SPILL_MIN_BYTES, |bytes| {
        bytes.clamp(spill::FRESH_READ_MIN_BYTES, spill::FRESH_READ_MAX_BYTES) + 1
    });
    let pending: Vec<(String, String)> = SPILL_TEXT_FIELDS
        .iter()
        .filter_map(|field| {
            let text = object.get(*field).and_then(serde_json::Value::as_str)?;
            if text.len() < min_bytes {
                return None;
            }
            Some(((*field).to_string(), text.to_string()))
        })
        .collect();
    for (field, text) in pending {
        let preview = match window {
            Some(bytes) => spill::preview_within(capability, tool, &text, bytes),
            None => spill::preview(capability, tool, &text),
        };
        if preview.address.is_empty() {
            continue;
        }
        if !gyro_core::efficiency::spill::persist(&preview.address, &text) {
            gyro_core::provider_observation::efficiency_event(|e| {
                e.spill_failures = e.spill_failures.saturating_add(1)
            });
            continue;
        }
        if let Some(object) = data.as_object_mut() {
            object.insert(field, serde_json::Value::String(preview.text));
        }
    }
}

/// Native tools get the same single corrective retry as the JSON bridge.
/// Execution failures are observed results; only an all-invalid name/schema
/// batch spends this recovery budget.
pub(super) fn check_native_tool_recovery(
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
pub(super) fn model_response_text(response: &CapabilityResponse) -> anyhow::Result<String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Evidence<'a> {
        capability_id: CapabilityId,
        summary: &'a str,
        data: serde_json::Value,
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
        error: Option<&'a gyro_core::capabilities::CapabilityError>,
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
            let mut data = result.data.clone();
            spill_result_data(
                result.capability_id.as_str(),
                result.capability_id.provider_tool_name(),
                &mut data,
            );
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

pub(super) fn execute(
    app: &tauri::AppHandle,
    session_id: &str,
    calls: &[(CapabilityId, serde_json::Value)],
) -> anyhow::Result<Vec<CapabilityResponse>> {
    let results = ordered(calls, |id, arguments| {
        invoke_run_capability(app, session_id, id, arguments.clone())
    })?;
    for ((_, args), response) in calls.iter().zip(&results) {
        observe_response(
            response,
            args["path"]
                .as_str()
                .is_some_and(gyro_core::efficiency::spill::is_address),
        );
    }
    Ok(results)
}

fn ordered<T: Send>(
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

fn read_on_worker<T>(invoke: impl FnOnce() -> anyhow::Result<T>) -> anyhow::Result<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(invoke))
        .unwrap_or_else(|_| Err(anyhow::anyhow!("Gyro tool worker failed")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gyro_core::CapabilityResult;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn cli_catalog_needs_both_switches_and_a_reviewed_cli() {
        let on = gyro_core::efficiency::Config {
            experimental: true,
            compact_cli_catalog: true,
            ..Default::default()
        };
        for provider in ["anthropic", "openai", "xai", "kimi"] {
            assert!(compact_cli_catalog_active(provider, &on), "{provider}");
        }
        for provider in ["gemini", "cursor", "opencode", "antigravity", "deepseek"] {
            assert!(!compact_cli_catalog_active(provider, &on), "{provider}");
        }
        for off in [
            gyro_core::efficiency::Config {
                experimental: false,
                ..on.clone()
            },
            gyro_core::efficiency::Config {
                enabled: false,
                ..on.clone()
            },
            gyro_core::efficiency::Config {
                compact_cli_catalog: false,
                ..on.clone()
            },
        ] {
            assert!(!compact_cli_catalog_active("openai", &off));
        }
    }

    #[test]
    fn mcp_compact_list_stays_reachable_and_is_much_shorter() {
        let names = |tools: &[serde_json::Value]| {
            tools
                .iter()
                .map(|tool| tool["name"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        let full = mcp_tools_for(CapabilityRunMode::Normal, true, false);
        let compact = mcp_tools_for(CapabilityRunMode::Normal, true, true);
        let (full_names, compact_names) = (names(&full), names(&compact));
        assert!(!full_names.iter().any(|name| name == COMPACT_INVOKE));
        assert!(full_names.iter().any(|name| name == "gyro_browser_click"));
        assert!(!compact_names
            .iter()
            .any(|name| name == "gyro_browser_click"));
        assert!(compact_names.iter().any(|name| name == "gyro_tool_catalog"));
        assert_eq!(compact.last().unwrap()["name"], COMPACT_INVOKE);
        // Every tool the short list drops is still reachable through the wrapper.
        for name in full_names
            .iter()
            .filter(|name| !compact_names.contains(name))
        {
            let id = CapabilityId::from_provider_tool_name(name).unwrap();
            assert!(!inline_tool_schema(id), "{name}");
        }
        let (full_bytes, compact_bytes) = (
            serde_json::to_string(&full).unwrap().len(),
            serde_json::to_string(&compact).unwrap().len(),
        );
        println!("mcp tool list: full {full_bytes} bytes, compact {compact_bytes} bytes");
        assert!(compact_bytes * 2 < full_bytes);

        // The wrapper follows discovery: Plan keeps both, Council lists nothing.
        let plan = names(&mcp_tools_for(CapabilityRunMode::Plan, false, true));
        assert!(plan.iter().any(|name| name == COMPACT_INVOKE));
        let council = mcp_tools_for(CapabilityRunMode::Council, false, true);
        assert!(!names(&council).iter().any(|name| name == COMPACT_INVOKE));
    }

    #[test]
    fn deferred_parameters_keep_browser_and_git_argument_guidance() {
        let tools = model_tools_for(
            CapabilityRunMode::Normal,
            false,
            &gyro_core::efficiency::Config::default(),
        );
        for (name, field, expected) in [
            (
                "gyro_browser_click",
                "ref",
                "Element ref from read_page or find",
            ),
            (
                "gyro_browser_mouse",
                "captureId",
                "Filename from a recent screenshot of this chat's browser",
            ),
            (
                "gyro_browser_mouse",
                "x",
                "Start X in browser CSS pixels from the screenshot's top-left",
            ),
            (
                "gyro_browser_mouse",
                "toX",
                "Required destination X for drag",
            ),
            (
                "gyro_browser_type",
                "ref",
                "Optional element ref; defaults to focused element",
            ),
            (
                "gyro_git_log",
                "path",
                "Optional workspace-relative path to limit history to.",
            ),
        ] {
            let tool = tools
                .iter()
                .find(|tool| tool["function"]["name"] == name)
                .unwrap_or_else(|| panic!("missing tool {name}"));
            assert_eq!(
                tool["function"]["parameters"]["properties"][field]["description"], expected,
                "{name}.{field}"
            );
        }
    }

    #[test]
    fn compact_schema_preserves_literals_and_named_arguments() {
        let literal = serde_json::json!({
            "description": "Literal first sentence. Literal second sentence.",
            "properties": {"description": "Also literal."}
        });
        let schema = serde_json::json!({
            "type": "object",
            "description": "Tool guidance. Longer manual.",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "Text to store. Longer manual.",
                    "minLength": 1,
                    "default": "Keep this. And this."
                },
                "payload": {
                    "default": literal,
                    "const": literal,
                    "enum": [literal],
                    "examples": [literal]
                }
            },
            "required": ["description"],
            "additionalProperties": false
        });
        let compact = compact_parameter_schema(&schema);
        assert_eq!(compact["description"], "Tool guidance.");
        assert_eq!(
            compact["properties"]["description"]["description"],
            "Text to store."
        );
        assert_eq!(compact["properties"]["description"]["type"], "string");
        assert_eq!(compact["properties"]["description"]["minLength"], 1);
        assert_eq!(
            compact["properties"]["description"]["default"],
            "Keep this. And this."
        );
        assert_eq!(
            compact["properties"]["payload"],
            schema["properties"]["payload"]
        );
        assert_eq!(compact["required"], schema["required"]);
        assert_eq!(compact["additionalProperties"], false);
        assert!(
            serde_json::to_vec(&compact).unwrap().len()
                < serde_json::to_vec(&schema).unwrap().len()
        );
    }

    #[test]
    fn compact_schema_keeps_nested_constraints_and_shortens_only_documentation() {
        let schema = serde_json::json!({
            "type": "array",
            "items": {
                "anyOf": [
                    {"type": "number", "minimum": 1, "description": "Positive value. More detail."},
                    {"type": "string", "enum": ["a", "b"], "description": "Named value. More detail."}
                ]
            },
            "$defs": {
                "description": {"type": "string", "description": "Named schema. More detail."}
            }
        });
        let compact = compact_parameter_schema(&schema);
        assert_eq!(
            compact["items"]["anyOf"][0]["description"],
            "Positive value."
        );
        assert_eq!(compact["items"]["anyOf"][0]["minimum"], 1);
        assert_eq!(
            compact["items"]["anyOf"][1]["enum"],
            schema["items"]["anyOf"][1]["enum"]
        );
        assert_eq!(
            compact["$defs"]["description"]["description"],
            "Named schema."
        );
        assert_eq!(compact_parameter_schema(&serde_json::json!(false)), false);
    }

    #[test]
    fn consecutive_invalid_batches_get_one_correction_and_are_never_replayed() {
        let mut messages = Vec::new();
        let mut malformed = 0;
        for (index, (name, arguments)) in [
            ("unknown_tool", serde_json::json!({})),
            (
                CapabilityId::WorkspaceRead.provider_tool_name(),
                serde_json::json!({}),
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let valid = provider_reliability::prepare_tool_call(
                &mut messages,
                name,
                &arguments,
                Some("invalid-call"),
            );
            assert!(valid.is_none());
            let outcome = check_native_tool_recovery(usize::from(valid.is_some()), &mut malformed);
            if index == 0 {
                assert!(outcome.is_ok());
            } else {
                let error = outcome.unwrap_err().to_string();
                assert!(error.contains("one corrective retry"));
                assert!(!provider_reliability::is_transient_provider_error(&error));
            }
        }
        assert_eq!(messages.len(), 2);
    }

    #[test]
    fn valid_requests_reset_recovery_even_when_their_execution_can_fail() {
        let mut malformed = 0;
        check_native_tool_recovery(0, &mut malformed).unwrap();
        let mut messages = Vec::new();
        let valid = provider_reliability::prepare_tool_call(
            &mut messages,
            CapabilityId::WorkspaceRead.provider_tool_name(),
            &serde_json::json!({"path":"missing-file.rs"}),
            Some("valid-request"),
        );
        assert!(valid.is_some());
        check_native_tool_recovery(usize::from(valid.is_some()), &mut malformed).unwrap();
        assert_eq!(malformed, 0);
        // A missing file is still a valid request, not a malformed model reply.
        let failed =
            CapabilityResponse::failed("test", Uuid::new_v4(), "missing-file", "File missing");
        assert_eq!(failed.status, CapabilityStatus::Failed);
        check_native_tool_recovery(0, &mut malformed).unwrap();
        assert_eq!(malformed, 1);
    }

    #[test]
    fn compact_native_catalogs_keep_all_mode_capabilities_and_constraints() {
        for mode in [
            CapabilityRunMode::Normal,
            CapabilityRunMode::Plan,
            CapabilityRunMode::Council,
        ] {
            let current_tools = model_tools(mode, true);
            let descriptors = advertised_capability_descriptors(mode).collect::<Vec<_>>();
            assert_eq!(current_tools.len(), descriptors.len());
            for (tool, descriptor) in current_tools.iter().zip(descriptors) {
                assert_eq!(tool["function"]["name"], descriptor.id.provider_tool_name());
                if inline_tool_schema(descriptor.id) {
                    assert_eq!(
                        tool["function"]["parameters"],
                        desktop_capability_tool_schema(descriptor.id)
                    );
                } else {
                    let full = desktop_capability_tool_schema(descriptor.id);
                    let compact = compact_parameter_schema(&full);
                    assert_eq!(&tool["function"]["parameters"], &compact);
                    assert_eq!(compact["type"], "object");
                    assert_eq!(compact["additionalProperties"], false);
                    assert_eq!(compact["required"], full["required"]);
                    assert!(
                        serde_json::to_vec(&compact).unwrap().len()
                            <= serde_json::to_vec(&full).unwrap().len(),
                        "{}",
                        descriptor.id.provider_tool_name()
                    );
                }
            }
            let current = serde_json::Value::Array(current_tools);
            let mut legacy = current.clone();
            let mut rooted = 0;
            for tool in legacy.as_array_mut().unwrap() {
                if let Some(root) = tool.pointer_mut("/function/parameters/properties/rootId") {
                    rooted += 1;
                    root["description"] = "Workspace root ID from gyro_workspace_get_context. Required when this session has multiple roots.".into();
                }
            }
            let before_bytes = serde_json::to_vec(&legacy).unwrap().len();
            let after_bytes = serde_json::to_vec(&current).unwrap().len();
            let before_chars = gyro_core::provider_observation::text_size(&legacy).0;
            let after_chars = gyro_core::provider_observation::text_size(&current).0;
            if rooted > 0 {
                assert!(
                    after_chars < before_chars,
                    "root guidance must be shared instead of repeated"
                );
                assert!(after_bytes < before_bytes);
            }
            eprintln!("native catalog {mode:?}: {} tools, {rooted} root fields, {before_bytes} -> {after_bytes} bytes, {before_chars} -> {after_chars} text/schema characters", current.as_array().unwrap().len());
        }
        let create = model_tools(CapabilityRunMode::Normal, true)
            .into_iter()
            .find(|tool| tool["function"]["name"] == "gyro_workspace_create")
            .unwrap();
        assert_eq!(
            create["function"]["parameters"]["properties"]["kind"]["enum"],
            serde_json::json!(["file", "directory"])
        );
        assert!(create["function"]["parameters"]["properties"]["path"].is_object());
        assert!(create["function"]["parameters"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "path"));
        let without_delegation = model_tools(CapabilityRunMode::Normal, false);
        assert!(without_delegation.iter().all(|tool| {
            let name = tool["function"]["name"].as_str().unwrap();
            !delegated_agents::delegation_tool(CapabilityId::from_provider_tool_name(name).unwrap())
        }));
    }

    #[test]
    fn experimental_catalog_keeps_every_permitted_tool_discoverable() {
        let baseline = gyro_core::efficiency::Config::default();
        let mut candidate = baseline.clone();
        candidate.experimental = true;
        candidate.compact_tool_catalog = true;
        for mode in [CapabilityRunMode::Normal, CapabilityRunMode::Plan] {
            let old = model_tools_for(mode, false, &baseline);
            let compact = model_tools_for(mode, false, &candidate);
            eprintln!(
                "experimental {mode:?} catalog: {} -> {} serialized bytes",
                serde_json::to_vec(&old).unwrap().len(),
                serde_json::to_vec(&compact).unwrap().len()
            );
            assert!(
                serde_json::to_vec(&compact).unwrap().len()
                    < serde_json::to_vec(&old).unwrap().len()
            );
            assert_eq!(
                compact
                    .iter()
                    .filter(|tool| tool["function"]["name"] == COMPACT_INVOKE)
                    .count(),
                1
            );
            assert!(compact
                .iter()
                .any(|tool| tool["function"]["name"] == "gyro_tool_catalog"));
            assert_eq!(
                compact,
                model_tools_for(mode, false, &candidate),
                "stable prefix"
            );
            for descriptor in advertised_capability_descriptors(mode)
                .filter(|d| !delegated_agents::delegation_tool(d.id))
            {
                let name = descriptor.id.provider_tool_name();
                let direct = compact.iter().any(|tool| tool["function"]["name"] == name);
                assert_eq!(direct, inline_tool_schema(descriptor.id), "{name}");
                let page = super::super::ollama_runner::ollama_compatibility_catalog(
                    mode,
                    Some(name),
                    0,
                    false,
                );
                assert!(
                    page["tools"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|entry| entry["name"] == name
                            && entry["parameters"]
                                == desktop_capability_tool_schema(descriptor.id)),
                    "{name}"
                );
            }
        }
        assert!(model_tools_for(CapabilityRunMode::Council, false, &candidate).is_empty());
        candidate.experimental = false;
        assert_eq!(
            model_tools_for(CapabilityRunMode::Normal, false, &baseline),
            model_tools_for(CapabilityRunMode::Normal, false, &candidate),
            "disabled is byte-identical"
        );
    }

    #[test]
    fn experimental_wrapper_validates_schema_mode_and_delegation() {
        let args = serde_json::json!({"name":"gyro_browser_open","arguments":{"url":"https://example.com"}});
        let (id, resolved) = resolve_tool_call(
            COMPACT_INVOKE,
            &args,
            CapabilityRunMode::Normal,
            false,
            true,
        )
        .unwrap();
        assert_eq!(id, CapabilityId::BrowserOpen);
        assert_eq!(resolved, serde_json::json!({"url":"https://example.com"}));
        assert!(resolve_tool_call(
            COMPACT_INVOKE,
            &args,
            CapabilityRunMode::Normal,
            false,
            false
        )
        .is_err());
        assert!(resolve_tool_call(
            COMPACT_INVOKE,
            &serde_json::json!({"name":"gyro_browser_open","arguments":{}}),
            CapabilityRunMode::Normal,
            false,
            true
        )
        .is_err());
        let edit = serde_json::json!({"name":"gyro_workspace_edit","arguments":{"path":"file.txt","oldString":"old","newString":"new"}});
        assert!(
            resolve_tool_call(COMPACT_INVOKE, &edit, CapabilityRunMode::Plan, false, true).is_err()
        );
        assert!(resolve_tool_call(
            COMPACT_INVOKE,
            &edit,
            CapabilityRunMode::Normal,
            false,
            true
        )
        .is_ok());
        let delegate = serde_json::json!({"name":"gyro_agent_spawn","arguments":{"name":"worker","task":"inspect"}});
        assert!(resolve_tool_call(
            COMPACT_INVOKE,
            &delegate,
            CapabilityRunMode::Normal,
            false,
            true
        )
        .is_err());
        assert!(resolve_tool_call(
            COMPACT_INVOKE,
            &delegate,
            CapabilityRunMode::Normal,
            true,
            true
        )
        .is_ok());
        assert!(resolve_tool_call(
            COMPACT_INVOKE,
            &serde_json::json!({"name":"gyro_tool_invoke","arguments":{}}),
            CapabilityRunMode::Normal,
            false,
            true
        )
        .is_err());
        assert!(resolve_tool_call(COMPACT_INVOKE, &serde_json::json!({"name":"gyro_browser_open","arguments":{"url":"https://example.com"},"extra":1}), CapabilityRunMode::Normal, false, true).is_err());
        assert!(resolve_tool_call(
            "gyro_browser_open",
            &serde_json::json!({"url":"https://example.com"}),
            CapabilityRunMode::Normal,
            false,
            true
        )
        .is_err());
        let mut messages = vec![];
        assert!(prepare_routed_tool_call(
            &mut messages,
            COMPACT_INVOKE,
            &serde_json::json!({"name":"invented","arguments":{}}),
            Some("call-1"),
            CapabilityRunMode::Normal,
            false,
            true
        )
        .is_none());
        assert_eq!(messages[0]["tool_call_id"], "call-1");
        assert!(messages[0]["content"]
            .as_str()
            .unwrap()
            .contains("No action was executed"));
        let mut system = format!("start {BASELINE_GUIDANCE} end");
        apply_compact_guidance(&mut system);
        assert!(system.contains(COMPACT_GUIDANCE));
        assert!(!system.contains(BASELINE_GUIDANCE));
        let mut batched = String::from("start");
        apply_batch_guidance(&mut batched);
        assert_eq!(batched, format!("start\n{BATCH_GUIDANCE}"));
        let denied = CapabilityResponse::failed(
            "test",
            Uuid::new_v4(),
            "not-available",
            "Catalog unavailable",
        );
        assert!(catalog_discovery_failed(
            true,
            CapabilityId::ToolCatalog,
            &denied
        ));
        assert!(!catalog_discovery_failed(
            false,
            CapabilityId::ToolCatalog,
            &denied
        ));
        assert!(!catalog_discovery_failed(
            true,
            CapabilityId::WorkspaceRead,
            &denied
        ));
        let mut candidate = gyro_core::efficiency::Config::default();
        candidate.experimental = true;
        candidate.compact_tool_catalog = true;
        let restored = full_catalog_config(&candidate);
        assert!(
            model_tools_for(CapabilityRunMode::Normal, false, &restored).len()
                > model_tools_for(CapabilityRunMode::Normal, false, &candidate).len()
        );
    }

    #[test]
    fn validated_tool_requests_record_only_coarse_classes() {
        let _scope = gyro_core::provider_observation::Scope::start();
        observe_tool(CapabilityId::WorkspaceRead);
        observe_tool(CapabilityId::WorkspaceEdit);
        observe_tool(CapabilityId::BrowserOpen);
        observe_tool(CapabilityId::ResearchRun);
        observe_tool(CapabilityId::ToolCatalog);
        let summary = gyro_core::provider_observation::snapshot().unwrap();
        assert_eq!(summary.tool_class_counts.get("workspace-read"), Some(&1));
        assert_eq!(summary.tool_class_counts.get("workspace-write"), Some(&1));
        assert_eq!(summary.tool_class_counts.get("browser"), Some(&1));
        assert_eq!(summary.tool_class_counts.get("agent"), Some(&1));
        assert_eq!(summary.tool_class_counts.get("other"), Some(&1));
        assert_eq!(summary.tool_class_counts.len(), 5);
    }

    #[test]
    fn compact_guidance_prefixes_match_catalog_capabilities() {
        let names = gyro_core::advertised_capability_descriptors(CapabilityRunMode::Normal)
            .map(|descriptor| descriptor.id.provider_tool_name())
            .collect::<Vec<_>>();
        for prefix in [
            "gyro_workspace_",
            "gyro_code_",
            "gyro_terminal_",
            "gyro_browser_",
            "gyro_git_",
            "gyro_ide_",
            "gyro_github_",
            "gyro_memory_",
            "gyro_research",
            "gyro_agent_",
            "gyro_task_",
            "gyro_",
        ] {
            assert!(COMPACT_GUIDANCE.contains(prefix));
            assert!(
                names.iter().any(|name| name.starts_with(prefix)),
                "{prefix}"
            );
        }
        assert!(names.contains(&CapabilityId::TaskCheckpoint.provider_tool_name()));
        assert!(names.contains(&CapabilityId::WorkspaceOutline.provider_tool_name()));
    }

    #[test]
    fn ordered_messages_keep_openai_call_ids_and_error_slots() {
        let mut messages = Vec::new();
        append_ordered_tool_messages(
            &mut messages,
            vec![
                Some(serde_json::json!({"role":"tool", "tool_call_id":"first", "content":"first"})),
                Some(
                    serde_json::json!({"role":"tool", "tool_call_id":"invalid", "content":"error"}),
                ),
                Some(serde_json::json!({"role":"tool", "tool_call_id":"third", "content":"third"})),
            ],
        )
        .unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|m| m["tool_call_id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["first", "invalid", "third"]
        );
        assert!(append_ordered_tool_messages(&mut messages, vec![None]).is_err());
    }

    #[test]
    fn model_results_keep_evidence_and_resources_without_the_ipc_envelope() {
        let call_id = Uuid::new_v4();
        let response = CapabilityResponse::completed(
            "test-version",
            CapabilityResult {
                call_id,
                capability_id: CapabilityId::WorkspaceRead,
                summary: "Read file".into(),
                data: serde_json::json!({"text": "file contents", "truncated": false}),
                resource: Some(CapabilityResourceRef {
                    id: "file-resource".into(),
                    kind: "file".into(),
                    label: "example.rs".into(),
                }),
            },
        );
        let compact = model_response_text(&response).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&compact).unwrap();
        assert_eq!(payload["callId"], call_id.to_string());
        assert_eq!(payload["status"], "completed");
        assert_eq!(payload["result"]["summary"], "Read file");
        assert_eq!(
            payload["result"]["data"],
            response.result.as_ref().unwrap().data
        );
        assert_eq!(payload["result"]["resource"]["id"], "file-resource");
        for field in ["schema", "appVersion", "compatible", "error"] {
            assert!(payload.get(field).is_none());
        }
        assert!(payload["result"].get("callId").is_none());
        assert!(compact.len() + 100 < serde_json::to_string(&response).unwrap().len());
    }

    #[test]
    fn fresh_reads_stay_whole_within_their_window_and_other_tools_keep_the_default() {
        use gyro_core::efficiency::spill;
        let code = "fn line() {}\n".repeat(500); // 6.5KB
        let mut fresh = serde_json::json!({"content": code});
        spill_result_data_within(
            "workspace.read",
            "gyro_workspace_read",
            &mut fresh,
            Some(8 * 1024),
        );
        assert_eq!(
            fresh["content"], code,
            "an 8KB window keeps a 6.5KB read whole"
        );

        let mut narrow = serde_json::json!({"content": code});
        spill_result_data_within("workspace.read", "gyro_workspace_read", &mut narrow, None);
        assert!(narrow["content"].as_str().unwrap().contains("spill://"));

        let long = "fn line() {}\n".repeat(2_000); // 26KB
        let mut capped = serde_json::json!({"content": long});
        spill_result_data_within(
            "workspace.read",
            "gyro_workspace_read",
            &mut capped,
            Some(8 * 1024),
        );
        let kept = capped["content"].as_str().unwrap();
        assert!(
            kept.contains("spill://") && kept.len() <= 8 * 1024,
            "{}",
            kept.len()
        );
        assert!(kept.len() > spill::SPILL_MIN_BYTES * 3);

        // The window is clamped, so a tiny or huge setting stays bounded.
        let mut clamped = serde_json::json!({"content": long});
        spill_result_data_within(
            "workspace.read",
            "gyro_workspace_read",
            &mut clamped,
            Some(1 << 30),
        );
        assert!(clamped["content"].as_str().unwrap().len() <= spill::FRESH_READ_MAX_BYTES);

        let config = gyro_core::efficiency::Config {
            fresh_read_inline_bytes: 8 * 1024,
            ..Default::default()
        };
        assert_eq!(
            config.fresh_read_window("workspace.read_range"),
            Some(8 * 1024)
        );
        assert_eq!(config.fresh_read_window("terminal.read"), None);
        assert_eq!(config.fresh_read_window("workspace.search"), None);
        assert_eq!(
            gyro_core::efficiency::Config::default().fresh_read_window("workspace.read"),
            None
        );
    }

    #[test]
    fn large_tool_text_becomes_a_preview_and_a_readable_spill_address() {
        let body = "y".repeat(gyro_core::efficiency::spill::SPILL_MIN_BYTES + 80);
        let response = CapabilityResponse::completed(
            "test-version",
            CapabilityResult {
                call_id: Uuid::new_v4(),
                capability_id: CapabilityId::TerminalRead,
                summary: "Read terminal".into(),
                data: serde_json::json!({
                    "text": body,
                    "path": "pane.log",
                    "exitCode": 0
                }),
                resource: None,
            },
        );
        let compact = model_response_text(&response).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&compact).unwrap();
        let text = payload["result"]["data"]["text"].as_str().unwrap();
        assert!(text.contains("spill://"), "{text}");
        assert!(text.contains("bytes elided"));
        assert!(text.len() < body.len());
        assert_eq!(payload["result"]["data"]["path"], "pane.log");
        assert_eq!(payload["result"]["data"]["exitCode"], 0);
        let address = format!(
            "spill://{}",
            text.split("spill://")
                .nth(1)
                .unwrap()
                .split([' ', '·'])
                .next()
                .unwrap()
        );
        let window = gyro_core::efficiency::spill::read(address.trim()).unwrap();
        let window = window.expect("spill copy");
        assert!(window.text.contains('y'));
        assert_eq!(window.total_bytes, body.len());
    }

    #[test]
    fn deferred_tool_lists_keep_a_sentence_and_the_catalog_keeps_the_detail() {
        let mut full = 0usize;
        let mut shown = 0usize;
        for descriptor in advertised_capability_descriptors(CapabilityRunMode::Normal) {
            let advertised = advertised_description(descriptor.id, descriptor.description);
            full += descriptor.description.len();
            shown += advertised.len();
            assert!(
                descriptor.description.starts_with(advertised),
                "{}",
                descriptor.id.provider_tool_name()
            );
            if inline_tool_schema(descriptor.id) {
                assert_eq!(advertised, descriptor.description);
            }
        }
        assert!(
            full > shown + 2_500,
            "always-on tool text {shown} should be well under the full descriptions {full}"
        );
        let page = super::super::ollama_runner::ollama_compatibility_catalog(
            CapabilityRunMode::Normal,
            Some("gyro_browser_"),
            0,
            true,
        );
        let browser = advertised_capability_descriptors(CapabilityRunMode::Normal)
            .find(|descriptor| descriptor.id == CapabilityId::BrowserOpen)
            .unwrap();
        let open = page["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "gyro_browser_open")
            .unwrap();
        assert_eq!(open["description"], browser.description);
        assert!(
            advertised_description(browser.id, browser.description).len()
                < browser.description.len()
        );
    }

    #[test]
    fn catalog_page_schema_still_validates_a_real_call() {
        let page = super::super::ollama_runner::ollama_compatibility_catalog(
            CapabilityRunMode::Normal,
            Some("gyro_browser_"),
            0,
            true,
        );
        let open = page["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "gyro_browser_open")
            .unwrap();
        assert_eq!(
            open["parameters"],
            desktop_capability_tool_schema(CapabilityId::BrowserOpen)
        );
        assert!(provider_reliability::validate_tool_call(
            "gyro_browser_open",
            &serde_json::json!({"url": "https://example.com"})
        )
        .is_ok());
        let missing =
            provider_reliability::validate_tool_call("gyro_browser_click", &serde_json::json!({}))
                .unwrap_err();
        assert!(missing.contains("gyro_browser_"));
        assert!(missing.contains("gyro_tool_catalog"));
    }

    #[test]
    fn model_results_keep_failures_and_incompatibility_actionable() {
        let mut response = CapabilityResponse::failed(
            "test-version",
            Uuid::new_v4(),
            "incompatible-schema",
            "Update the provider adapter",
        );
        response.compatible = false;
        let payload: serde_json::Value =
            serde_json::from_str(&model_response_text(&response).unwrap()).unwrap();
        assert_eq!(payload["status"], "failed");
        assert_eq!(payload["error"]["code"], "incompatible-schema");
        assert_eq!(payload["error"]["message"], "Update the provider adapter");
        assert_eq!(payload["compatible"], false);
        assert_eq!(payload["schema"], response.schema);
        assert_eq!(payload["appVersion"], response.app_version);
        assert!(payload.get("result").is_none());
    }

    #[test]
    fn an_isolated_read_runs_on_the_existing_worker() {
        let caller = std::thread::current().id();
        ordered(
            &[(CapabilityId::WorkspaceRead, serde_json::json!({}))],
            |_, _| {
                assert_eq!(std::thread::current().id(), caller);
                Ok(())
            },
        )
        .unwrap();
    }
    #[test]
    fn concurrent_reads_preserve_result_order_and_finish_before_writes() {
        let barrier = std::sync::Barrier::new(2);
        let finished = AtomicUsize::new(0);
        let calls = vec![
            (CapabilityId::WorkspaceRead, serde_json::json!(0)),
            (CapabilityId::WorkspaceReadRange, serde_json::json!(1)),
            (CapabilityId::WorkspaceEdit, serde_json::json!(2)),
        ];
        let results = ordered(&calls, |id, argument| {
            if independent_read(id) {
                barrier.wait();
                finished.fetch_add(1, Ordering::SeqCst);
            } else {
                assert_eq!(finished.load(Ordering::SeqCst), 2);
            }
            Ok(argument.as_u64().unwrap())
        })
        .unwrap();
        assert_eq!(results, [0, 1, 2]);
        for id in [
            CapabilityId::WorkspaceReadEditor,
            CapabilityId::TerminalOpen,
            CapabilityId::BrowserInspect,
            CapabilityId::WorkspaceEdit,
            CapabilityId::WebFetch,
        ] {
            assert!(!independent_read(id));
        }
    }
    #[test]
    fn failed_read_never_starts_a_later_write() {
        let calls = [
            (CapabilityId::WorkspaceRead, serde_json::json!({})),
            (CapabilityId::WorkspaceEdit, serde_json::json!({})),
        ];
        assert!(ordered::<()>(&calls, |id, _| {
            assert_eq!(id, CapabilityId::WorkspaceRead);
            anyhow::bail!("cancelled")
        })
        .is_err());
    }

    #[test]
    fn read_batches_use_the_runner_and_cap_parallelism_at_four() {
        let caller = std::thread::current().id();
        let barrier = std::sync::Barrier::new(4);
        let caller_reads = AtomicUsize::new(0);
        let active = AtomicUsize::new(0);
        let maximum = AtomicUsize::new(0);
        let calls = (0..8)
            .map(|index| (CapabilityId::WorkspaceRead, serde_json::json!(index)))
            .collect::<Vec<_>>();
        let results = ordered(&calls, |_, argument| {
            if std::thread::current().id() == caller {
                caller_reads.fetch_add(1, Ordering::SeqCst);
            }
            let readers = active.fetch_add(1, Ordering::SeqCst) + 1;
            maximum.fetch_max(readers, Ordering::SeqCst);
            barrier.wait();
            active.fetch_sub(1, Ordering::SeqCst);
            Ok(argument.as_u64().unwrap())
        })
        .unwrap();
        assert_eq!(results, (0..8).collect::<Vec<_>>());
        assert_eq!(maximum.load(Ordering::SeqCst), 4);
        assert_eq!(caller_reads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_failed_concurrent_reader_finishes_its_peers_before_returning() {
        let barrier = std::sync::Barrier::new(2);
        let finished = AtomicUsize::new(0);
        let calls = [
            (CapabilityId::WorkspaceRead, serde_json::json!(0)),
            (CapabilityId::WorkspaceRead, serde_json::json!(1)),
            (CapabilityId::WorkspaceEdit, serde_json::json!(2)),
        ];
        assert!(ordered(&calls, |id, argument| {
            assert!(independent_read(id), "a failed read must stop later writes");
            barrier.wait();
            finished.fetch_add(1, Ordering::SeqCst);
            if argument == &serde_json::json!(0) {
                anyhow::bail!("read failed");
            }
            Ok(())
        })
        .is_err());
        assert_eq!(finished.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_panic_in_a_reader_never_starts_a_later_write() {
        for failed_index in [0, 1] {
            let calls = [
                (CapabilityId::WorkspaceRead, serde_json::json!(0)),
                (CapabilityId::WorkspaceRead, serde_json::json!(1)),
                (CapabilityId::WorkspaceEdit, serde_json::json!(2)),
            ];
            let error = ordered(&calls, |id, argument| {
                assert!(independent_read(id));
                assert_ne!(argument, &serde_json::json!(failed_index), "read panic");
                Ok(())
            })
            .unwrap_err();
            assert_eq!(error.to_string(), "Gyro tool worker failed");
        }
    }
    #[test]
    fn catalog_survives_compaction_without_orphaning_calls_and_remains_callable() {
        let mut memory = CatalogMemory::default();
        let page = super::super::ollama_runner::ollama_compatibility_catalog(
            CapabilityRunMode::Normal,
            Some("gyro_workspace_get_context"),
            0,
            false,
        );
        memory.page(&page);
        memory.page(&page);
        assert_eq!(
            memory.schemas.len(),
            page["tools"].as_array().unwrap().len()
        );
        let mut messages = vec![
            serde_json::json!({"role":"system","content":COMPACT_GUIDANCE}),
            serde_json::json!({"role":"user","content":"task and attachment"}),
            serde_json::json!({"role":"assistant","tool_calls":[{"id":"old","function":{"name":"gyro_tool_catalog"}}]}),
            serde_json::json!({"role":"tool","tool_call_id":"old","content":page.to_string()}),
            serde_json::json!({"role":"assistant","tool_calls":[{"id":"new","function":{"name":"gyro_workspace_read"}}]}),
            serde_json::json!({"role":"tool","tool_call_id":"new","content":"x".repeat(30000)}),
        ];
        let head = messages[..2].to_vec();
        let tail = messages[4..].to_vec();
        assert!(crate::provider_context::auto_compact_messages(
            &mut messages,
            Some(9000),
            Some(0),
            Some(10000),
            80
        )
        .is_some());
        memory.after_compaction(&mut messages, true);
        assert_eq!(messages[..2], head);
        assert!(messages[2]["content"]
            .as_str()
            .unwrap()
            .contains("gyro_workspace_get_context"));
        assert_eq!(&messages[messages.len() - 2..], tail.as_slice());
        memory.after_compaction(&mut messages, true);
        assert_eq!(
            messages
                .iter()
                .filter(|m| m["content"]
                    .as_str()
                    .is_some_and(|s| s.starts_with(RETAINED_CATALOG)))
                .count(),
            1
        );
        let (id, _) = resolve_tool_call(
            COMPACT_INVOKE,
            &serde_json::json!({"name":"gyro_workspace_get_context","arguments":{}}),
            CapabilityRunMode::Normal,
            false,
            true,
        )
        .unwrap();
        assert_eq!(id, CapabilityId::WorkspaceContext);
        memory.page(&serde_json::json!({"tools":[{"name":"oversized","parameters":{"description":"x".repeat(gyro_core::capabilities::MAX_CAPABILITY_RESULT_BYTES)}}]}));
        assert!(memory.overflow);
        memory.after_compaction(&mut messages, true);
        assert!(!messages.iter().any(|m| m["content"]
            .as_str()
            .is_some_and(|s| s.starts_with(RETAINED_CATALOG))));
        restore_catalog_guidance(&mut messages);
        assert_eq!(messages[0]["content"], BASELINE_GUIDANCE);
    }

    #[test]
    fn disabling_retention_leaves_compaction_without_an_appendix() {
        let mut memory = CatalogMemory::default();
        memory.page(&serde_json::json!({"tools":[{"name":"gyro_workspace_read","parameters":{}}]}));
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"rules"}),
            serde_json::json!({"role":"user","content":"task"}),
        ];
        memory.after_compaction(&mut messages, false);
        assert_eq!(messages.len(), 2);
    }
    #[test]
    fn numeric_events_count_recovery_failures_and_rediscovery_without_content() {
        let _scope = gyro_core::provider_observation::Scope::start();
        observe_tool(CapabilityId::ToolCatalog);
        let mut catalog = CatalogMemory::default();
        let page =
            serde_json::json!({"tools":[{"name":"gyro_workspace_get_context","parameters":{}}]});
        catalog.page(&page);
        let mut messages = vec![
            serde_json::json!({"role":"system","content":"rules"}),
            serde_json::json!({"role":"user","content":"task"}),
        ];
        catalog.after_compaction(&mut messages, true);
        catalog.page(&page);
        let response = CapabilityResponse::completed(
            "test",
            CapabilityResult {
                call_id: Uuid::new_v4(),
                capability_id: CapabilityId::WorkspaceRead,
                summary: "private sentinel".into(),
                data: serde_json::json!({"source":"spill","content":"private sentinel","progressAction":"correct"}),
                resource: None,
            },
        );
        observe_response(&response, true);
        observe_response(
            &CapabilityResponse::failed("test", Uuid::new_v4(), "missing", "private sentinel"),
            true,
        );
        let events = gyro_core::provider_observation::snapshot()
            .unwrap()
            .context_attribution
            .efficiency_events
            .unwrap();
        assert_eq!(events.catalog_discoveries, 1);
        assert_eq!(events.catalog_rediscoveries, 1);
        assert_eq!(events.spill_recoveries, 1);
        assert_eq!(events.spill_failures, 1);
        assert_eq!(events.repeated_call_notices, 1);
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("private sentinel"));
    }
}
