//! Desktop tool definitions retain their domain-owned schemas and live policy.
use gyro_core::{
    provider_runtime::catalog::ToolCatalog, CapabilityDescriptor, CapabilityId, CapabilityRunMode,
};
use serde_json::Value;

pub(crate) struct DesktopToolCatalog;
pub(crate) static DESKTOP_TOOL_CATALOG: DesktopToolCatalog = DesktopToolCatalog;

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
    fn observation_byte_limit(&self, arguments: &Value) -> anyhow::Result<usize> {
        crate::capability_workspace_helpers::workspace_result_byte_limit(arguments)
    }
}
