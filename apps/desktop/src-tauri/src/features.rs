//! Native boundaries for local memory, review and workflow domains.
#[path = "code_reviews/mod.rs"]
pub(crate) mod code_reviews;
#[path = "project_memory/mod.rs"]
pub(crate) mod project_memory;
pub(crate) mod scope;
pub(crate) mod workflows;
pub(crate) mod workflow_execution;
pub(crate) mod workflow_extraction;
