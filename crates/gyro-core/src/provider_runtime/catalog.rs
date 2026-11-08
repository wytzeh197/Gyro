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
