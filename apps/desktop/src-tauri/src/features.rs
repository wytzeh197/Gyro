//! Native boundaries for memory, review, workflows and optional device access.
#[path = "code_reviews/mod.rs"]
pub(crate) mod code_reviews;
#[path = "project_memory/mod.rs"]
pub(crate) mod project_memory;
pub(crate) mod scope;
pub(crate) mod workflow_execution;
pub(crate) mod workflow_extraction;
pub(crate) mod workflows;
pub(crate) mod remote_access;
