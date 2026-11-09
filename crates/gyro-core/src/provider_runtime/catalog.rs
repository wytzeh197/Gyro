//! Host-owned tool definitions and observation policy, shared by API transports.
use crate::{CapabilityDescriptor, CapabilityId, CapabilityRunMode};
use serde_json::Value;

pub trait ToolCatalog: Send + Sync {
    fn descriptors(
        &self,
        mode: CapabilityRunMode,
    ) -> Box<dyn Iterator<Item = &'static CapabilityDescriptor> + '_>;
    fn schema(&self, id: CapabilityId) -> Value;
    fn observation_byte_limit(&self, arguments: &Value) -> anyhow::Result<usize>;
}

pub fn validate_compatibility_schema_value(
    value: &serde_json::Value,
    schema: &serde_json::Value,
    path: &str,
) -> anyhow::Result<()> {
    let valid_type = match schema["type"].as_str() {
        Some("string") => value.is_string(),
        Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
        Some("number") => value.is_number(),
        Some("boolean") => value.is_boolean(),
        Some("array") => value.is_array(),
        Some("object") => value.is_object(),
        _ => true,
    };
    anyhow::ensure!(valid_type, "invalid type for {path}");
    if let Some(options) = schema["enum"].as_array() {
        anyhow::ensure!(options.contains(value), "invalid value for {path}");
    }
    if let Some(number) = value.as_f64() {
        if let Some(minimum) = schema["minimum"].as_f64() {
            anyhow::ensure!(number >= minimum, "{path} is below the minimum");
        }
        if let Some(maximum) = schema["maximum"].as_f64() {
            anyhow::ensure!(number <= maximum, "{path} exceeds the maximum");
        }
    }
    if let Some(text) = value.as_str() {
        if let Some(maximum) = schema["maxLength"].as_u64() {
            anyhow::ensure!(text.chars().count() as u64 <= maximum, "{path} is too long");
        }
    }
    if let Some(items) = value.as_array() {
        if let Some(maximum) = schema["maxItems"].as_u64() {
            anyhow::ensure!(items.len() as u64 <= maximum, "{path} has too many items");
        }
        if schema.get("items").is_some() {
            for (index, item) in items.iter().enumerate() {
                validate_compatibility_schema_value(
                    item,
                    &schema["items"],
                    &format!("{path}[{index}]"),
                )?;
            }
        }
    }
    if let Some(fields) = value.as_object() {
        for required in schema["required"].as_array().into_iter().flatten() {
            let name = required
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid tool schema"))?;
            anyhow::ensure!(
                fields.contains_key(name),
                "missing required argument: {name}"
            );
        }
        let properties = schema["properties"].as_object();
        for (name, child) in fields {
            match properties.and_then(|properties| properties.get(name)) {
                Some(definition) => validate_compatibility_schema_value(
                    child,
                    definition,
                    &format!("{path}.{name}"),
                )?,
                None if schema["additionalProperties"] == false => {
                    anyhow::bail!("unknown tool argument: {name}")
                }
                None => {}
            }
        }
    }
    Ok(())
}
pub fn delegation_tool(id: CapabilityId) -> bool {
    matches!(
        id,
        CapabilityId::AgentSpawn | CapabilityId::AgentSend | CapabilityId::ResearchRun
    )
}
