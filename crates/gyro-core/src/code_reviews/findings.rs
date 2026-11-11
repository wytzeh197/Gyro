use super::types::{
    FindingDisposition, ParsedReview, ReviewFinding, ReviewResolution, ReviewSeverity, ReviewSide,
    ReviewSnapshot, RESULT_SCHEMA,
};
use anyhow::{ensure, Result};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Output {
    #[serde(default)]
    resolutions: Vec<Resolution>,
    schema: String,
    summary: String,
    reviewed_files: Vec<String>,
    findings: Vec<Finding>,
    limitations: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Finding {
    path: String,
    side: ReviewSide,
    line_start: usize,
    line_end: usize,
    severity: ReviewSeverity,
    title: String,
    explanation: String,
    #[serde(default)]
    suggested_resolution: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resolution {
    finding_id: Uuid,
    path: String,
    side: ReviewSide,
    line_start: usize,
    line_end: usize,
    explanation: String,
}

pub fn parse_review_result(
    review_id: Uuid,
    snapshot: &ReviewSnapshot,
    response: &str,
) -> Result<ParsedReview> {
    ensure!(
        response.len() <= 128 * 1024,
        "review result exceeds its size limit"
    );
    let output: Output = serde_json::from_str(response.trim())?;
    ensure!(
        output.schema == RESULT_SCHEMA,
        "unsupported review result schema"
    );
    ensure!(
        !output.summary.trim().is_empty()
            && output.summary.len() <= 2000
            && output.findings.len() <= 100
            && output.limitations.len() <= 20
            && output.limitations.iter().all(|text| text.len() <= 1000),
        "review result exceeds its limits"
    );
    let intended: std::collections::BTreeSet<_> = snapshot
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    let reviewed: std::collections::BTreeSet<_> =
        output.reviewed_files.iter().map(String::as_str).collect();
    ensure!(
        reviewed == intended && reviewed.len() == output.reviewed_files.len(),
        "review coverage does not match the complete supplied snapshot"
    );
    let mut findings = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for finding in output.findings {
        let file = snapshot
            .files
            .iter()
            .find(|file| file.path == finding.path)
            .ok_or_else(|| anyhow::anyhow!("finding path is outside the snapshot"))?;
        let text = match finding.side {
            ReviewSide::Original => file.original.as_deref(),
            ReviewSide::Modified => file.modified.as_deref(),
        }
        .ok_or_else(|| anyhow::anyhow!("finding side was not captured"))?;
        let lines: Vec<_> = text.lines().collect();
        ensure!(
            finding.line_start > 0
                && finding.line_end >= finding.line_start
                && finding.line_end <= lines.len()
                && finding.line_end - finding.line_start < 20,
            "finding location is outside captured text or is too broad"
        );
        ensure!(
            !finding.title.trim().is_empty()
                && finding.title.len() <= 200
                && !finding.explanation.trim().is_empty()
                && finding.explanation.len() <= 4000
                && finding
                    .suggested_resolution
                    .as_ref()
                    .is_none_or(|text| text.len() <= 2000),
            "finding text is missing or exceeds its limits"
        );
        let anchor_hash = crate::mutations::content_hash(
            lines[finding.line_start - 1..finding.line_end]
                .join("\n")
                .as_bytes(),
        );
        let logical_finding_id = crate::mutations::content_hash(
            format!(
                "{}:{:?}:{anchor_hash}:{}",
                finding.path,
                finding.side,
                finding.title.to_lowercase()
            )
            .as_bytes(),
        );
        ensure!(
            seen.insert(logical_finding_id.clone()),
            "duplicate review finding"
        );
        findings.push(ReviewFinding {
            resolved_by_review_id: None,
            id: Uuid::new_v4(),
            review_id,
            logical_finding_id,
            snapshot_id: snapshot.id,
            path: finding.path,
            side: finding.side,
            line_start: finding.line_start,
            line_end: finding.line_end,
            anchor_hash,
            title: finding.title,
            severity: finding.severity,
            explanation: finding.explanation,
            suggested_resolution: finding.suggested_resolution,
            disposition: FindingDisposition::Open,
            revision: 1,
        });
    }
    ensure!(
        output.resolutions.len() <= 100,
        "too many finding resolutions"
    );
    let mut resolutions = Vec::new();
    let mut resolved = std::collections::HashSet::new();
    for resolution in output.resolutions {
        let previous = snapshot
            .previous_findings
            .iter()
            .find(|finding| finding.id == resolution.finding_id)
            .ok_or_else(|| {
                anyhow::anyhow!("resolution does not identify a captured previous finding")
            })?;
        ensure!(
            resolved.insert(previous.id)
                && matches!(
                    previous.disposition,
                    FindingDisposition::Open
                        | FindingDisposition::SentForFix
                        | FindingDisposition::FixClaimed
                ),
            "finding cannot be resolved"
        );
        let file = snapshot
            .files
            .iter()
            .find(|file| {
                file.path == resolution.path
                    && (file.path == previous.path
                        || file.original_path.as_deref() == Some(previous.path.as_str()))
            })
            .ok_or_else(|| anyhow::anyhow!("resolution has no captured file mapping"))?;
        let text = match resolution.side {
            ReviewSide::Original => file.original.as_deref(),
            ReviewSide::Modified => file.modified.as_deref(),
        }
        .ok_or_else(|| anyhow::anyhow!("resolution side was not captured"))?;
        let lines: Vec<_> = text.lines().collect();
        ensure!(
            resolution.line_start > 0
                && resolution.line_end >= resolution.line_start
                && resolution.line_end <= lines.len()
                && resolution.line_end - resolution.line_start < 20,
            "resolution has no narrow captured anchor"
        );
        ensure!(
            !resolution.explanation.trim().is_empty() && resolution.explanation.len() <= 4000,
            "resolution explanation is missing or too large"
        );
        resolutions.push(ReviewResolution {
            finding_id: previous.id,
            expected_revision: previous.revision,
            previous_anchor_hash: previous.anchor_hash.clone(),
            evidence_path: resolution.path,
            evidence_anchor_hash: crate::mutations::content_hash(
                lines[resolution.line_start - 1..resolution.line_end]
                    .join("\n")
                    .as_bytes(),
            ),
            explanation: resolution.explanation,
        });
    }
    Ok(ParsedReview {
        resolutions,
        summary: output.summary,
        findings,
        limitations: output.limitations,
    })
}
