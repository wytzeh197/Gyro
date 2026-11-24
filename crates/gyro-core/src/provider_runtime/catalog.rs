//! Host-owned tool definitions and observation policy, shared by API transports.
use crate::{CapabilityDescriptor, CapabilityId, CapabilityRunMode};
use serde_json::Value;
use std::borrow::Cow;

pub trait ToolCatalog: Send + Sync {
    fn descriptors(
        &self,
        mode: CapabilityRunMode,
    ) -> Box<dyn Iterator<Item = &'static CapabilityDescriptor> + '_>;
    fn schema(&self, id: CapabilityId) -> Value;
    /// Same full schema as `schema`. Catalogs with reusable definitions can
    /// lend a value to readers without rebuilding or cloning it.
    fn schema_ref(&self, id: CapabilityId) -> Cow<'_, Value> {
        Cow::Owned(self.schema(id))
    }
    /// The model-facing schema for tools whose full documentation is deferred.
    fn compact_schema_ref(&self, id: CapabilityId) -> Cow<'_, Value> {
        Cow::Owned(super::tool_batch::compact_parameter_schema(
            self.schema_ref(id).as_ref(),
        ))
    }
    /// The parameters shown to the model for this turn. A host can narrow
    /// what it advertises while keeping the full schema for call validation.
    fn advertised_schema_ref(&self, id: CapabilityId, compact: bool) -> Cow<'_, Value> {
        if compact {
            self.compact_schema_ref(id)
        } else {
            self.schema_ref(id)
        }
    }
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
        let properties = schema["properties"].as_object();
        let mut missing = Vec::new();
        for required in schema["required"].as_array().into_iter().flatten() {
            let name = required
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid tool schema"))?;
            if !fields.contains_key(name) {
                missing.push(name);
            }
        }
        const MAX_UNKNOWN_FIELDS: usize = 3;
        let unknown = if schema["additionalProperties"] == false {
            fields
                .keys()
                .filter(|name| {
                    !properties.is_some_and(|definitions| definitions.contains_key(*name))
                })
                .take(MAX_UNKNOWN_FIELDS + 1)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        if !missing.is_empty() || !unknown.is_empty() {
            let mut issues = Vec::new();
            if !missing.is_empty() {
                let label = if missing.len() == 1 {
                    "missing required argument"
                } else {
                    "missing required arguments"
                };
                issues.push(format!("{label}: {}", missing.join(", ")));
            }
            if !unknown.is_empty() {
                let label = if unknown.len() == 1 {
                    "unknown tool argument"
                } else {
                    "unknown tool arguments"
                };
                let mut names = unknown
                    .iter()
                    .take(MAX_UNKNOWN_FIELDS)
                    .map(|name| {
                        let short = name.chars().take(64).collect::<String>();
                        format!("{:?}", crate::sanitize_capability_summary(&short))
                    })
                    .collect::<Vec<_>>();
                if unknown.len() > MAX_UNKNOWN_FIELDS {
                    names.push("others".into());
                }
                issues.push(format!("{label}: {}", names.join(", ")));
            }
            let location = if path == "arguments" {
                String::new()
            } else {
                format!(" at {path}")
            };
            anyhow::bail!("{}{location}", issues.join(". "));
        }
        let Some(properties) = properties else {
            return Ok(());
        };
        for (name, child) in fields {
            if let Some(definition) = properties.get(name) {
                validate_compatibility_schema_value(child, definition, &format!("{path}.{name}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nested_shape_feedback_identifies_object_and_caps_unknown_keys() {
        let schema = json!({"type":"object", "properties": {"edits": {
            "type":"array", "items": {"type":"object", "required":["old", "new"],
                "properties":{"old":{"type":"string"},"new":{"type":"string"}},
                "additionalProperties":false}
        }}});
        let value = json!({"edits":[{"old":"x","badA":0,"badB":0,"badC":0,"badD":0,"badE":0}]});
        let error = validate_compatibility_schema_value(&value, &schema, "arguments")
            .unwrap_err()
            .to_string();
        assert_eq!(error, "missing required argument: new. unknown tool arguments: \"badA\", \"badB\", \"badC\", others at arguments.edits[0]");

        let wrong_type = json!({"edits":[{"old":"x", "new":3}]});
        let error = validate_compatibility_schema_value(&wrong_type, &schema, "arguments")
            .unwrap_err()
            .to_string();
        assert_eq!(error, "invalid type for arguments.edits[0].new");
    }
}
