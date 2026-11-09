//! Shared tool advertisement, bounded observations and ordered read batches.
use super::{
    catalog::{delegation_tool, ToolCatalog},
    reliability as provider_reliability,
    support::efficiency_config,
};
use crate::{
    timing, CapabilityClass, CapabilityId, CapabilityResourceRef, CapabilityResponse,
    CapabilityRunMode, CapabilityStatus,
};
use serde::Serialize;
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
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": descriptor.id.provider_tool_name(),
                    "description": advertised_description(descriptor.id, descriptor.description),
                    "parameters": advertised_tool_parameters(catalog, descriptor.id),
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
        .map(|descriptor| {
            serde_json::json!({
                "name": descriptor.id.provider_tool_name(),
                "description": advertised_description(descriptor.id, descriptor.description),
                "inputSchema": advertised_tool_parameters(catalog, descriptor.id),
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
    let schema = catalog.schema(id);
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
        if !crate::efficiency::spill::persist(&preview.address, &text) {
            crate::provider_observation::efficiency_event(|e| {
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

pub fn mark_browser_image_attached(response: &mut CapabilityResponse) {
    if let Some(result) = response.result.as_mut() {
        result.data["evidence"]["screenshotModelVisible"] = serde_json::json!(true);
        result.data["evidence"]["visualNote"] = serde_json::json!(
            "PNG image content is attached. Visual inspection requires an image-capable model and client."
        );
    }
}
