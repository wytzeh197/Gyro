//! Immutable review evidence and validated advisory results. No provider or
//! mutation authority is derived from a snapshot or a model finding.
mod findings;
mod fix_types;
pub use fix_types::{ReviewFixIntent, ReviewFixStatus};
mod snapshot;
mod types;
pub use findings::parse_review_result;
pub use snapshot::{
    build_snapshot, captured_diff, delete_review_artifacts, delete_snapshot_artifact,
    open_review_partial, pack_review_input, read_review_output, read_snapshot,
    reconstruct_recorded_original, remove_review_partial, write_review_output, write_snapshot,
};
pub use types::{
    CapturedReviewFile, CodeReviewRun, FindingDisposition, ParsedReview, ReviewExclusion,
    ReviewFinding, ReviewResolution, ReviewScope, ReviewSeverity, ReviewSide, ReviewSnapshot,
    ReviewStatus, SnapshotInput, MAX_REVIEW_CAPTURE_BYTES, MAX_REVIEW_FILES, MAX_REVIEW_SIDE_BYTES,
    RESULT_SCHEMA, SNAPSHOT_SCHEMA,
};
#[cfg(test)]
mod tests;
