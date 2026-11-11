//! Portable project-memory documents. This domain performs no I/O and grants
//! no write authority; hosts apply plans through their governed mutation lane.
mod candidates;
mod context;
mod document;
mod files;
mod selection;
mod types;
mod write;

pub use candidates::{
    candidate_worthy_request, parse_memory_candidates, MemoryCandidate, CANDIDATE_INSTRUCTION,
    MEMORY_CANDIDATE_MARKER,
};
pub use context::{prepare_memory_context, MemorySettings};
pub use document::{MemoryDocument, MemoryEntry};
pub use files::{confined_bytes, read_project_memory};
pub use selection::{
    select_memory, MemoryBudget, MemoryEntryReceipt, MemoryQuery, MemoryReceipt, MemoryRootReceipt,
    MemorySelection, PreparedMemoryContext, DEFAULT_CONTEXT_BYTES, MAX_CONTEXT_BYTES,
    MAX_CONTEXT_ENTRIES,
};
pub use types::{
    MemoryDiagnostic, MemoryDraft, MemoryKind, MemoryMetadata, MemorySource, MemoryStatus,
};
pub use write::{plan_write, MemoryWrite, MemoryWritePlan};

pub const MEMORY_PATH: &str = ".gyro/memory.md";
pub const MEMORY_HEADER: &str =
    "# Project memory\n\nDurable notes this project carries between chats. One entry per line.\n\n";
pub const MAX_MEMORY_FILE_BYTES: usize = 256 * 1024;
pub const MAX_MEMORY_ENTRIES: usize = 200;
pub const MAX_MEMORY_ENTRY_CHARS: usize = 500;

pub fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod candidate_tests;
#[cfg(test)]
mod context_tests;
#[cfg(test)]
mod managed_tests;
#[cfg(test)]
mod selection_tests;
#[cfg(test)]
mod tests;
