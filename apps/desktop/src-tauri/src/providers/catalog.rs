//! Desktop tool definitions retain their domain-owned schemas and live policy.
use gyro_core::{
    provider_runtime::catalog::ToolCatalog, CapabilityDescriptor, CapabilityId, CapabilityRunMode,
};
use serde_json::Value;
use std::borrow::Cow;

pub(crate) struct DesktopToolCatalog {
    root_count: Option<usize>,
}
pub(crate) static DESKTOP_TOOL_CATALOG: DesktopToolCatalog =
    DesktopToolCatalog { root_count: None };

impl DesktopToolCatalog {
    pub(crate) fn for_workspace_roots(root_count: Option<usize>) -> Self {
        Self { root_count }
    }

    pub(super) fn workspace_root_count(&self) -> Option<usize> {
        self.root_count
    }
}

impl ToolCatalog for DesktopToolCatalog {
    fn descriptors(
        &self,
        mode: CapabilityRunMode,
    ) -> Box<dyn Iterator<Item = &'static CapabilityDescriptor> + '_> {
        Box::new(crate::capabilities::mcp_server::advertised_capability_descriptors(mode))
    }
    fn schema(&self, id: CapabilityId) -> Value {
        crate::capabilities::mcp_server::desktop_capability_tool_schema(id)
    }
    fn schema_ref(&self, id: CapabilityId) -> Cow<'_, Value> {
        crate::capabilities::mcp_server::desktop_capability_tool_schema_ref(id)
    }
    fn compact_schema_ref(&self, id: CapabilityId) -> Cow<'_, Value> {
        crate::capabilities::mcp_server::desktop_compact_tool_schema_ref(id)
    }
    fn advertised_schema_ref(&self, id: CapabilityId, compact: bool) -> Cow<'_, Value> {
        let schema = if compact {
            self.compact_schema_ref(id)
        } else {
            self.schema_ref(id)
        };
        let Some(root_count) = self.root_count.filter(|count| *count > 0) else {
            return schema;
        };
        if schema["properties"].get("rootId").is_none() {
            return schema;
        }
        let mut schema = schema.into_owned();
        if root_count == 1 {
            if let Some(properties) = schema["properties"].as_object_mut() {
                properties.remove("rootId");
            }
            if let Some(required) = schema["required"].as_array_mut() {
                required.retain(|field| field != "rootId");
            }
        } else {
            schema["properties"]["rootId"]["description"] =
                "Workspace root ID returned by gyro_workspace_get_context.".into();
            if let Some(required) = schema["required"].as_array_mut() {
                if !required.iter().any(|field| field == "rootId") {
                    required.push("rootId".into());
                }
            } else {
                schema["required"] = serde_json::json!(["rootId"]);
            }
        }
        Cow::Owned(schema)
    }
    fn observation_byte_limit(&self, arguments: &Value) -> anyhow::Result<usize> {
        crate::capability_workspace_helpers::workspace_result_byte_limit(arguments)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gyro_core::{
        efficiency::Config,
        provider_runtime::{
            runners::ollama::ollama_compatibility_catalog, tool_batch::model_tools_for,
        },
    };

    #[test]
    fn model_tool_schemas_follow_the_bound_root_count() {
        let id = CapabilityId::WorkspaceRead;
        let name = id.provider_tool_name();
        let baseline = DESKTOP_TOOL_CATALOG.schema(id);
        for roots in [1, 2] {
            let catalog = DesktopToolCatalog::for_workspace_roots(Some(roots));
            let tools = model_tools_for(
                &catalog,
                CapabilityRunMode::Normal,
                false,
                &Config::default(),
            );
            let tool = tools
                .iter()
                .find(|tool| tool["function"]["name"] == name)
                .unwrap();
            let page = ollama_compatibility_catalog(
                &catalog,
                CapabilityRunMode::Normal,
                Some(name),
                0,
                false,
            );
            let discovered = page["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap();
            for parameters in [&tool["function"]["parameters"], &discovered["parameters"]] {
                let mut expected = baseline.clone();
                if roots == 1 {
                    expected["properties"]
                        .as_object_mut()
                        .unwrap()
                        .remove("rootId");
                } else {
                    expected["properties"]["rootId"]["description"] =
                        "Workspace root ID returned by gyro_workspace_get_context.".into();
                    expected["required"]
                        .as_array_mut()
                        .unwrap()
                        .push("rootId".into());
                }
                assert_eq!(parameters, &expected);
            }
            assert_eq!(catalog.schema_ref(id).as_ref(), &baseline);
            assert_eq!(
                catalog.advertised_schema_ref(CapabilityId::WorkspaceContext, false),
                DESKTOP_TOOL_CATALOG.schema_ref(CapabilityId::WorkspaceContext)
            );
        }
    }

    #[test]
    fn compact_multi_root_catalog_exposes_root_discovery_directly() {
        let catalog = DesktopToolCatalog::for_workspace_roots(Some(2));
        let config = Config {
            experimental: true,
            compact_tool_catalog: true,
            ..Config::default()
        };
        let tools = model_tools_for(&catalog, CapabilityRunMode::Normal, false, &config);
        assert!(tools
            .iter()
            .any(|tool| tool["function"]["name"] == "gyro_tool_invoke"));
        let name = CapabilityId::WorkspaceContext.provider_tool_name();
        let context = tools
            .iter()
            .find(|tool| tool["function"]["name"] == name)
            .unwrap();
        assert!(context["function"]["parameters"]["properties"]
            .get("rootId")
            .is_none());
    }
}
