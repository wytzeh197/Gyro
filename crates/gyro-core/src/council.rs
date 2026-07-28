//! Advisory Model Council: parallel non-mutating seats + structured synthesis.
//!
//! MVP seats cannot use tools or mutate the workspace. Full bodies live as
//! session-private artifacts; session events hold summaries and refs.

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const COUNCIL_SCHEMA_V1: &str = "gyro.council.v1";
pub const COUNCIL_MIN_SEATS: usize = 2;
pub const COUNCIL_MAX_SEATS: usize = 4;
pub const DEFAULT_SEAT_TIMEOUT_SECONDS: u64 = 300;
pub const DEFAULT_SYNTHESIZER_TIMEOUT_SECONDS: u64 = 180;

pub const SYNTHESIZER_SYSTEM_PROMPT: &str = r#"You are the Gyro Council synthesizer for a coding workbench.

You receive N independent model answers to the SAME coding task, with the SAME
frozen context. Seats had no tools and could not mutate the workspace.

Produce a structured result with these sections:

1. recommendation — clear primary recommendation (plan, approach, or answer)
2. agreement — bullet list of points most seats share; attribute seats by label
3. disagreements — list of { topic, positions[{seatLabel, summary}], recommendation }
4. uniqueInsights — list of { seatLabel, insight } for valuable minority points
5. risksAndTests — concrete risks and how to verify
6. adoptionSteps — ordered steps if the user implements next
7. unifiedMarkdown — full answer combining the above in readable markdown

Rules:
- Prefer explicit trade-offs over averaging conflicting code.
- When implementations diverge, name Approach A/B, compare blast radius,
  complexity, testability, and fit to the given context, then pick one.
- Attribute claims to seat labels.
- Do not invent workspace facts not present in the prompt/context/seat answers.
- Do not claim seats used tools or ran commands.
- If seats conflict and evidence is weak, say what is uncertain.
- Keep adoptionSteps actionable for a single follow-up implementation run.

Prefer JSON with keys: recommendation, agreement, disagreements, uniqueInsights,
risksAndTests, adoptionSteps, unifiedMarkdown.
If you cannot emit JSON, use markdown headings:
## Recommendation
## Agreement
## Disagreements
## Unique insights
## Risks & tests
## Adoption
"#;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CouncilRunStatus {
    Queued,
    Running,
    Synthesizing,
    Done,
    Partial,
    Failed,
    Cancelled,
}

impl CouncilRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Synthesizing => "synthesizing",
            Self::Done => "done",
            Self::Partial => "partial",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Done | Self::Partial | Self::Failed | Self::Cancelled
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CouncilSeatStatus {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl CouncilSeatStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

/// MVP seats cannot call tools. Later: `ReadOnly`.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CouncilToolPolicy {
    #[default]
    None,
}

impl CouncilToolPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilPreset {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub seat_provider_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub seat_model_ids: BTreeMap<String, Option<String>>,
    pub synthesizer_provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synthesizer_model_id: Option<String>,
    #[serde(default)]
    pub tool_policy: CouncilToolPolicy,
    #[serde(default)]
    pub built_in: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilConfig {
    #[serde(default = "default_preset_id")]
    pub default_preset_id: String,
    #[serde(default)]
    pub presets: Vec<CouncilPreset>,
    #[serde(default = "default_max_seats")]
    pub max_seats: usize,
    #[serde(default = "default_seat_timeout")]
    pub seat_timeout_seconds: u64,
    #[serde(default = "default_synth_timeout")]
    pub synthesizer_timeout_seconds: u64,
    #[serde(default = "default_true")]
    pub synthesize_on_partial: bool,
    /// Staged alpha switch. When false, Chat should not offer Council mode.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_preset_id() -> String {
    "code-focused".into()
}

fn default_max_seats() -> usize {
    COUNCIL_MAX_SEATS
}

fn default_seat_timeout() -> u64 {
    DEFAULT_SEAT_TIMEOUT_SECONDS
}

fn default_synth_timeout() -> u64 {
    DEFAULT_SYNTHESIZER_TIMEOUT_SECONDS
}

fn default_true() -> bool {
    true
}

impl Default for CouncilConfig {
    fn default() -> Self {
        Self {
            default_preset_id: default_preset_id(),
            presets: built_in_council_presets(),
            max_seats: COUNCIL_MAX_SEATS,
            seat_timeout_seconds: DEFAULT_SEAT_TIMEOUT_SECONDS,
            synthesizer_timeout_seconds: DEFAULT_SYNTHESIZER_TIMEOUT_SECONDS,
            synthesize_on_partial: true,
            enabled: true,
        }
    }
}

impl CouncilConfig {
    /// Merge user presets over built-ins (user id wins). Ensure built-ins exist.
    pub fn normalized(mut self) -> Self {
        if self.max_seats < COUNCIL_MIN_SEATS {
            self.max_seats = COUNCIL_MIN_SEATS;
        }
        if self.max_seats > COUNCIL_MAX_SEATS {
            self.max_seats = COUNCIL_MAX_SEATS;
        }
        if self.seat_timeout_seconds == 0 {
            self.seat_timeout_seconds = DEFAULT_SEAT_TIMEOUT_SECONDS;
        }
        if self.synthesizer_timeout_seconds == 0 {
            self.synthesizer_timeout_seconds = DEFAULT_SYNTHESIZER_TIMEOUT_SECONDS;
        }

        // Keep built-in order stable for config round-trips; user presets override
        // by id, and unknown custom presets append after built-ins.
        let mut built_ins = built_in_council_presets();
        let mut overrides = BTreeMap::new();
        let mut custom = Vec::new();
        for preset in self.presets.drain(..) {
            if built_ins.iter().any(|built_in| built_in.id == preset.id) {
                overrides.insert(preset.id.clone(), preset);
            } else {
                custom.push(preset);
            }
        }
        for preset in &mut built_ins {
            if let Some(overridden) = overrides.remove(&preset.id) {
                *preset = overridden;
            }
        }
        built_ins.extend(custom);
        self.presets = built_ins;
        if !self
            .presets
            .iter()
            .any(|preset| preset.id == self.default_preset_id)
        {
            self.default_preset_id = default_preset_id();
        }
        self
    }

    pub fn preset(&self, id: &str) -> Option<&CouncilPreset> {
        self.presets.iter().find(|preset| preset.id == id)
    }
}

pub fn built_in_council_presets() -> Vec<CouncilPreset> {
    vec![
        CouncilPreset {
            id: "code-focused".into(),
            name: "Code-focused council".into(),
            description: Some(
                "Strong coding providers in parallel; best available synthesizer.".into(),
            ),
            seat_provider_ids: vec!["anthropic".into(), "openai".into()],
            seat_model_ids: BTreeMap::new(),
            synthesizer_provider_id: "anthropic".into(),
            synthesizer_model_id: None,
            tool_policy: CouncilToolPolicy::None,
            built_in: true,
        },
        CouncilPreset {
            id: "strong-reasoning".into(),
            name: "Strong reasoning council".into(),
            description: Some(
                "Prefer deep-reasoning providers for architecture and hard bugs.".into(),
            ),
            seat_provider_ids: vec!["anthropic".into(), "openai".into(), "xai".into()],
            seat_model_ids: BTreeMap::new(),
            synthesizer_provider_id: "anthropic".into(),
            synthesizer_model_id: None,
            tool_policy: CouncilToolPolicy::None,
            built_in: true,
        },
        CouncilPreset {
            id: "cheap-local".into(),
            name: "Cheap + local council".into(),
            description: Some(
                "Lower-cost and local-capable seats when available.".into(),
            ),
            seat_provider_ids: vec!["kimi".into(), "gemini".into()],
            seat_model_ids: BTreeMap::new(),
            synthesizer_provider_id: "kimi".into(),
            synthesizer_model_id: None,
            tool_policy: CouncilToolPolicy::None,
            built_in: true,
        },
    ]
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilAttachmentRef {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilContextSnapshot {
    pub id: Uuid,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub attachments: Vec<CouncilAttachmentRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_summary: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilSeat {
    pub id: Uuid,
    pub council_run_id: Uuid,
    pub run_id: Uuid,
    pub provider_id: String,
    pub provider_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_label: Option<String>,
    pub status: CouncilSeatStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u128>,
    /// Full text when loaded; prefer artifact file for large bodies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilDisagreementPosition {
    pub seat_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seat_label: Option<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilDisagreement {
    pub topic: String,
    pub positions: Vec<CouncilDisagreementPosition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommendation: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilUniqueInsight {
    pub seat_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seat_label: Option<String>,
    pub insight: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilSynthesis {
    pub synthesizer_provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synthesizer_model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synthesizer_run_id: Option<Uuid>,
    pub unified_markdown: String,
    pub recommendation: String,
    #[serde(default)]
    pub agreement: Vec<String>,
    #[serde(default)]
    pub disagreements: Vec<CouncilDisagreement>,
    #[serde(default)]
    pub unique_insights: Vec<CouncilUniqueInsight>,
    #[serde(default)]
    pub risks_and_tests: Vec<String>,
    #[serde(default)]
    pub adoption_steps: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parse_warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u128>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_edited_markdown: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilRunTotals {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wall_duration_ms: Option<u128>,
    pub seats_succeeded: u32,
    pub seats_failed: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_cost_usd: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilRun {
    pub schema: String,
    pub id: Uuid,
    pub session_id: Uuid,
    pub status: CouncilRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    pub snapshot: CouncilContextSnapshot,
    pub seats: Vec<CouncilSeat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synthesis: Option<CouncilSynthesis>,
    #[serde(default)]
    pub tool_policy: CouncilToolPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synthesizer_provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synthesizer_model_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancelled_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totals: Option<CouncilRunTotals>,
}

impl CouncilRun {
    pub fn new(
        session_id: Uuid,
        snapshot: CouncilContextSnapshot,
        mut seats: Vec<CouncilSeat>,
        preset_id: Option<String>,
        tool_policy: CouncilToolPolicy,
        synthesizer_provider_id: Option<String>,
        synthesizer_model_id: Option<String>,
    ) -> Result<Self> {
        validate_seat_count(seats.len())?;
        let now = Utc::now();
        let id = Uuid::new_v4();
        for seat in &mut seats {
            seat.council_run_id = id;
        }
        Ok(Self {
            schema: COUNCIL_SCHEMA_V1.into(),
            id,
            session_id,
            status: CouncilRunStatus::Queued,
            preset_id,
            snapshot,
            seats,
            synthesis: None,
            tool_policy,
            synthesizer_provider_id,
            synthesizer_model_id,
            created_at: now,
            updated_at: now,
            cancelled_at: None,
            totals: None,
        })
    }

    pub fn seats_succeeded(&self) -> u32 {
        self.seats
            .iter()
            .filter(|seat| seat.status == CouncilSeatStatus::Done)
            .count() as u32
    }

    pub fn seats_failed(&self) -> u32 {
        self.seats
            .iter()
            .filter(|seat| {
                matches!(
                    seat.status,
                    CouncilSeatStatus::Failed | CouncilSeatStatus::Cancelled
                )
            })
            .count() as u32
    }

    pub fn all_seats_terminal(&self) -> bool {
        self.seats.iter().all(|seat| seat.status.is_terminal())
    }

    pub fn recompute_totals(&mut self) {
        let wall_duration_ms = if self.updated_at >= self.created_at {
            (self.updated_at - self.created_at).num_milliseconds().max(0) as u128
        } else {
            0
        };
        self.totals = Some(CouncilRunTotals {
            wall_duration_ms: Some(wall_duration_ms),
            seats_succeeded: self.seats_succeeded(),
            seats_failed: self.seats_failed(),
            estimated_cost_usd: None,
        });
    }
}

pub fn validate_seat_count(count: usize) -> Result<()> {
    if count < COUNCIL_MIN_SEATS {
        return Err(anyhow!(
            "council requires at least {COUNCIL_MIN_SEATS} seats (got {count})"
        ));
    }
    if count > COUNCIL_MAX_SEATS {
        return Err(anyhow!(
            "council allows at most {COUNCIL_MAX_SEATS} seats (got {count})"
        ));
    }
    Ok(())
}

/// What the orchestrator should do after every seat is terminal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CouncilBarrierDecision {
    /// User cancelled before or during seats; keep partial artifacts.
    Cancelled,
    /// No successful seats — do not synthesize.
    FailNoSuccessfulSeats,
    /// Run the synthesizer over these successful seat ids (in seat order).
    Synthesize { seat_ids: Vec<Uuid> },
}

pub fn barrier_decision(
    seats: &[CouncilSeat],
    synthesize_on_partial: bool,
    cancelled: bool,
) -> CouncilBarrierDecision {
    let successful: Vec<Uuid> = seats
        .iter()
        .filter(|seat| seat.status == CouncilSeatStatus::Done)
        .map(|seat| seat.id)
        .collect();

    if successful.is_empty() {
        return if cancelled {
            CouncilBarrierDecision::Cancelled
        } else {
            CouncilBarrierDecision::FailNoSuccessfulSeats
        };
    }

    let all_succeeded = seats
        .iter()
        .all(|seat| seat.status == CouncilSeatStatus::Done);

    if cancelled && !synthesize_on_partial {
        return CouncilBarrierDecision::Cancelled;
    }

    if !all_succeeded && !synthesize_on_partial {
        // Keep seat outputs; orchestrator skips synthesis.
        return CouncilBarrierDecision::FailNoSuccessfulSeats;
    }

    CouncilBarrierDecision::Synthesize {
        seat_ids: successful,
    }
}

/// Final run status after synthesis attempt (or failure to synthesize).
pub fn final_run_status(
    seats: &[CouncilSeat],
    synthesis_ok: bool,
    cancelled: bool,
) -> CouncilRunStatus {
    if cancelled {
        return CouncilRunStatus::Cancelled;
    }
    let succeeded = seats
        .iter()
        .filter(|s| s.status == CouncilSeatStatus::Done)
        .count();
    let failed = seats
        .iter()
        .filter(|s| {
            matches!(
                s.status,
                CouncilSeatStatus::Failed | CouncilSeatStatus::Cancelled
            )
        })
        .count();
    if succeeded == 0 {
        return CouncilRunStatus::Failed;
    }
    if !synthesis_ok {
        // Seats may still be useful without synthesis.
        return if failed > 0 {
            CouncilRunStatus::Partial
        } else {
            CouncilRunStatus::Failed
        };
    }
    if failed > 0 {
        CouncilRunStatus::Partial
    } else {
        CouncilRunStatus::Done
    }
}

pub fn seat_label_map(seats: &[CouncilSeat]) -> BTreeMap<Uuid, String> {
    seats
        .iter()
        .map(|seat| (seat.id, seat.provider_label.clone()))
        .collect()
}

pub fn successful_seat_answers(seats: &[CouncilSeat]) -> Vec<CouncilSeatAnswer> {
    seats
        .iter()
        .filter(|seat| seat.status == CouncilSeatStatus::Done)
        .filter_map(|seat| {
            let raw = seat.raw_output.as_ref()?.clone();
            Some(CouncilSeatAnswer {
                seat_id: seat.id,
                label: seat.provider_label.clone(),
                provider_id: seat.provider_id.clone(),
                model_id: seat.model_id.clone(),
                raw_output: raw,
            })
        })
        .collect()
}

/// Filter a preset's seat list to providers the caller marks as ready.
pub fn resolve_ready_seats(
    preset: &CouncilPreset,
    ready_provider_ids: &[String],
    max_seats: usize,
) -> Vec<String> {
    let max_seats = max_seats.clamp(COUNCIL_MIN_SEATS, COUNCIL_MAX_SEATS);
    preset
        .seat_provider_ids
        .iter()
        .filter(|id| ready_provider_ids.iter().any(|ready| ready == *id))
        .take(max_seats)
        .cloned()
        .collect()
}

// --- Artifact layout ---------------------------------------------------------

pub fn council_run_dir(sessions_dir: &Path, session_id: Uuid, council_run_id: Uuid) -> PathBuf {
    sessions_dir
        .join(session_id.to_string())
        .join("council")
        .join(council_run_id.to_string())
}

pub fn council_manifest_path(run_dir: &Path) -> PathBuf {
    run_dir.join("run.json")
}

pub fn council_seat_artifact_path(run_dir: &Path, seat_id: Uuid) -> PathBuf {
    run_dir.join(format!("seat-{seat_id}.md"))
}

pub fn council_synthesis_artifact_path(run_dir: &Path) -> PathBuf {
    run_dir.join("synthesis.md")
}

pub fn council_snapshot_path(run_dir: &Path) -> PathBuf {
    run_dir.join("snapshot.json")
}

pub fn ensure_council_run_dir(run_dir: &Path) -> Result<()> {
    fs::create_dir_all(run_dir).with_context(|| format!("create {}", run_dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(run_dir, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("secure {}", run_dir.display()))?;
    }
    Ok(())
}

pub fn write_council_run_manifest(run_dir: &Path, run: &CouncilRun) -> Result<()> {
    ensure_council_run_dir(run_dir)?;
    let path = council_manifest_path(run_dir);
    let mut bytes = serde_json::to_vec_pretty(run)?;
    bytes.push(b'\n');
    atomic_write_private(&path, &bytes)?;
    Ok(())
}

pub fn read_council_run_manifest(run_dir: &Path) -> Result<CouncilRun> {
    let path = council_manifest_path(run_dir);
    let raw = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let run: CouncilRun = serde_json::from_str(&raw)
        .with_context(|| format!("parse council manifest {}", path.display()))?;
    if run.schema != COUNCIL_SCHEMA_V1 {
        return Err(anyhow!("unsupported council schema {}", run.schema));
    }
    Ok(run)
}

pub fn write_council_snapshot(run_dir: &Path, snapshot: &CouncilContextSnapshot) -> Result<()> {
    ensure_council_run_dir(run_dir)?;
    let path = council_snapshot_path(run_dir);
    let mut bytes = serde_json::to_vec_pretty(snapshot)?;
    bytes.push(b'\n');
    atomic_write_private(&path, &bytes)?;
    Ok(())
}

pub fn write_seat_artifact(run_dir: &Path, seat_id: Uuid, body: &str) -> Result<PathBuf> {
    ensure_council_run_dir(run_dir)?;
    let path = council_seat_artifact_path(run_dir, seat_id);
    atomic_write_private(&path, body.as_bytes())?;
    Ok(path)
}

pub fn write_synthesis_artifact(run_dir: &Path, body: &str) -> Result<PathBuf> {
    ensure_council_run_dir(run_dir)?;
    let path = council_synthesis_artifact_path(run_dir);
    atomic_write_private(&path, body.as_bytes())?;
    Ok(path)
}

pub fn read_seat_artifact(run_dir: &Path, seat_id: Uuid) -> Result<String> {
    let path = council_seat_artifact_path(run_dir, seat_id);
    fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))
}

fn atomic_write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("path has no parent: {}", path.display()))?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("council"),
        Uuid::new_v4()
    ));
    fs::write(&tmp, bytes).with_context(|| format!("write {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("secure {}", tmp.display()))?;
    }
    fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))?;
    Ok(())
}

// --- Synthesizer prompt + parse ----------------------------------------------

#[derive(Clone, Debug)]
pub struct CouncilSeatAnswer {
    pub seat_id: Uuid,
    pub label: String,
    pub provider_id: String,
    pub model_id: Option<String>,
    pub raw_output: String,
}

pub fn build_synthesizer_user_prompt(
    original_prompt: &str,
    answers: &[CouncilSeatAnswer],
) -> String {
    let mut out = String::new();
    out.push_str("## Original task\n\n");
    out.push_str(original_prompt.trim());
    out.push_str("\n\n## Seat answers\n");
    for (index, answer) in answers.iter().enumerate() {
        out.push_str(&format!(
            "\n### Seat {} — {} ({})",
            index + 1,
            answer.label,
            answer.provider_id
        ));
        if let Some(model) = &answer.model_id {
            out.push_str(&format!(" · model `{model}`"));
        }
        out.push_str(&format!("\nseatId: {}\n\n", answer.seat_id));
        out.push_str(answer.raw_output.trim());
        out.push('\n');
    }
    out.push_str(
        "\nSynthesize the seats into the structured result described in your system instructions.\n",
    );
    out
}

/// Parse synthesizer model output as JSON object or markdown sections.
pub fn parse_council_synthesis(
    raw: &str,
    synthesizer_provider_id: &str,
    synthesizer_model_id: Option<String>,
    synthesizer_run_id: Option<Uuid>,
    seat_label_by_id: &BTreeMap<Uuid, String>,
) -> CouncilSynthesis {
    let trimmed = raw.trim();
    if let Some(mut synthesis) = try_parse_synthesis_json(trimmed) {
        synthesis.synthesizer_provider_id = synthesizer_provider_id.into();
        synthesis.synthesizer_model_id = synthesizer_model_id;
        synthesis.synthesizer_run_id = synthesizer_run_id;
        fill_seat_labels(&mut synthesis, seat_label_by_id);
        if synthesis.unified_markdown.trim().is_empty() {
            synthesis.unified_markdown = render_unified_markdown(&synthesis);
        }
        return synthesis;
    }

    let mut warnings = vec!["Synthesizer output was not valid structured JSON; used markdown section fallback.".into()];
    let recommendation = section_body(trimmed, &["recommendation"]).unwrap_or_default();
    let agreement = bullets_from(section_body(trimmed, &["agreement"]).as_deref().unwrap_or(""));
    let unique_raw = section_body(trimmed, &["unique insights", "unique-insights", "uniqueinsights"]);
    let risks_raw = section_body(trimmed, &["risks & tests", "risks and tests", "risks"]);
    let adoption_raw = section_body(trimmed, &["adoption", "adoption steps"]);
    let disagreements_raw = section_body(trimmed, &["disagreements", "disagreement"]);

    if recommendation.is_empty() {
        warnings.push("Missing ## Recommendation section.".into());
    }

    let mut synthesis = CouncilSynthesis {
        synthesizer_provider_id: synthesizer_provider_id.into(),
        synthesizer_model_id,
        synthesizer_run_id,
        unified_markdown: if has_any_section(trimmed) {
            trimmed.into()
        } else {
            format!("## Recommendation\n\n{trimmed}")
        },
        recommendation: if recommendation.is_empty() {
            trimmed.chars().take(2_000).collect()
        } else {
            recommendation
        },
        agreement,
        disagreements: parse_disagreement_bullets(
            disagreements_raw.as_deref().unwrap_or(""),
            seat_label_by_id,
        ),
        unique_insights: parse_unique_bullets(
            unique_raw.as_deref().unwrap_or(""),
            seat_label_by_id,
        ),
        risks_and_tests: bullets_from(risks_raw.as_deref().unwrap_or("")),
        adoption_steps: bullets_from(adoption_raw.as_deref().unwrap_or("")),
        parse_warnings: warnings,
        started_at: None,
        completed_at: None,
        duration_ms: None,
        user_edited_markdown: None,
        artifact_path: None,
    };
    fill_seat_labels(&mut synthesis, seat_label_by_id);
    synthesis
}

fn try_parse_synthesis_json(raw: &str) -> Option<CouncilSynthesis> {
    let json_slice = extract_json_object(raw)?;
    let value: serde_json::Value = serde_json::from_str(json_slice).ok()?;

    let recommendation = value
        .get("recommendation")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let unified = value
        .get("unifiedMarkdown")
        .or_else(|| value.get("unified_markdown"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let agreement = string_list_field(&value, &["agreement"]);
    let risks = string_list_field(&value, &["risksAndTests", "risks_and_tests"]);
    let adoption = string_list_field(&value, &["adoptionSteps", "adoption_steps"]);

    let disagreements = value
        .get("disagreements")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let topic = item.get("topic")?.as_str()?.to_string();
                    let positions = item
                        .get("positions")
                        .and_then(|p| p.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|pos| {
                                    let summary = pos.get("summary")?.as_str()?.to_string();
                                    let seat_label = pos
                                        .get("seatLabel")
                                        .or_else(|| pos.get("seat_label"))
                                        .and_then(|v| v.as_str())
                                        .map(str::to_string);
                                    let seat_id = pos
                                        .get("seatId")
                                        .or_else(|| pos.get("seat_id"))
                                        .and_then(|v| v.as_str())
                                        .and_then(|s| Uuid::parse_str(s).ok())
                                        .unwrap_or_else(Uuid::nil);
                                    Some(CouncilDisagreementPosition {
                                        seat_id,
                                        seat_label,
                                        summary,
                                    })
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let recommendation = item
                        .get("recommendation")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    Some(CouncilDisagreement {
                        topic,
                        positions,
                        recommendation,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let unique_insights = value
        .get("uniqueInsights")
        .or_else(|| value.get("unique_insights"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let insight = item.get("insight")?.as_str()?.to_string();
                    let seat_label = item
                        .get("seatLabel")
                        .or_else(|| item.get("seat_label"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    let seat_id = item
                        .get("seatId")
                        .or_else(|| item.get("seat_id"))
                        .and_then(|v| v.as_str())
                        .and_then(|s| Uuid::parse_str(s).ok())
                        .unwrap_or_else(Uuid::nil);
                    Some(CouncilUniqueInsight {
                        seat_id,
                        seat_label,
                        insight,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if recommendation.is_empty() && unified.is_empty() && agreement.is_empty() {
        return None;
    }

    Some(CouncilSynthesis {
        synthesizer_provider_id: String::new(),
        synthesizer_model_id: None,
        synthesizer_run_id: None,
        unified_markdown: unified,
        recommendation,
        agreement,
        disagreements,
        unique_insights,
        risks_and_tests: risks,
        adoption_steps: adoption,
        parse_warnings: Vec::new(),
        started_at: None,
        completed_at: None,
        duration_ms: None,
        user_edited_markdown: None,
        artifact_path: None,
    })
}

fn extract_json_object(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') {
        return Some(trimmed);
    }
    let fence_start = trimmed.find("```")?;
    let after = &trimmed[fence_start + 3..];
    let after = after
        .strip_prefix("json")
        .or_else(|| after.strip_prefix("JSON"))
        .unwrap_or(after)
        .trim_start_matches(|c: char| c == '\r' || c == '\n');
    let end = after.find("```")?;
    let inner = after[..end].trim();
    if inner.starts_with('{') {
        Some(inner)
    } else {
        None
    }
}

fn string_list_field(value: &serde_json::Value, keys: &[&str]) -> Vec<String> {
    for key in keys {
        if let Some(arr) = value.get(*key).and_then(|v| v.as_array()) {
            return arr
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .filter(|s| !s.trim().is_empty())
                .collect();
        }
        if let Some(s) = value.get(*key).and_then(|v| v.as_str()) {
            return bullets_from(s);
        }
    }
    Vec::new()
}

fn section_body(markdown: &str, titles: &[&str]) -> Option<String> {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();
        if let Some(heading) = line.strip_prefix("## ") {
            let heading_norm = normalize_heading(heading);
            if titles
                .iter()
                .any(|title| heading_norm == normalize_heading(title))
            {
                i += 1;
                let mut body = Vec::new();
                while i < lines.len() {
                    let next = lines[i];
                    if next.trim_start().starts_with("## ") {
                        break;
                    }
                    body.push(next);
                    i += 1;
                }
                let text = body.join("\n").trim().to_string();
                if !text.is_empty() {
                    return Some(text);
                }
                return Some(String::new());
            }
        }
        i += 1;
    }
    None
}

fn has_any_section(markdown: &str) -> bool {
    markdown.lines().any(|line| line.trim_start().starts_with("## "))
}

fn normalize_heading(value: &str) -> String {
    value
        .trim()
        .trim_start_matches(['#', ' '])
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn bullets_from(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            line.trim_start_matches(['-', '*', '•'])
                .trim_start_matches(|c: char| c.is_ascii_digit())
                .trim_start_matches(['.', ')', ' '])
                .trim()
                .to_string()
        })
        .filter(|line| !line.is_empty())
        .collect()
}

fn parse_disagreement_bullets(
    text: &str,
    seat_label_by_id: &BTreeMap<Uuid, String>,
) -> Vec<CouncilDisagreement> {
    bullets_from(text)
        .into_iter()
        .map(|line| CouncilDisagreement {
            topic: line.clone(),
            positions: seat_label_by_id
                .iter()
                .map(|(id, label)| CouncilDisagreementPosition {
                    seat_id: *id,
                    seat_label: Some(label.clone()),
                    summary: String::new(),
                })
                .collect(),
            recommendation: None,
        })
        .filter(|d| !d.topic.is_empty())
        .collect()
}

fn parse_unique_bullets(
    text: &str,
    seat_label_by_id: &BTreeMap<Uuid, String>,
) -> Vec<CouncilUniqueInsight> {
    bullets_from(text)
        .into_iter()
        .map(|line| {
            let (seat_label, insight) = if let Some((left, right)) = line.split_once(':') {
                (Some(left.trim().to_string()), right.trim().to_string())
            } else {
                (None, line)
            };
            let seat_id = seat_label
                .as_ref()
                .and_then(|label| {
                    seat_label_by_id
                        .iter()
                        .find(|(_, known)| known.eq_ignore_ascii_case(label))
                        .map(|(id, _)| *id)
                })
                .unwrap_or_else(Uuid::nil);
            CouncilUniqueInsight {
                seat_id,
                seat_label,
                insight,
            }
        })
        .filter(|item| !item.insight.is_empty())
        .collect()
}

fn fill_seat_labels(synthesis: &mut CouncilSynthesis, seat_label_by_id: &BTreeMap<Uuid, String>) {
    for disagreement in &mut synthesis.disagreements {
        for position in &mut disagreement.positions {
            if position.seat_label.is_none() {
                position.seat_label = seat_label_by_id.get(&position.seat_id).cloned();
            }
        }
    }
    for insight in &mut synthesis.unique_insights {
        if insight.seat_label.is_none() {
            insight.seat_label = seat_label_by_id.get(&insight.seat_id).cloned();
        }
    }
}

fn render_unified_markdown(synthesis: &CouncilSynthesis) -> String {
    let mut out = String::new();
    out.push_str("## Recommendation\n\n");
    out.push_str(synthesis.recommendation.trim());
    out.push_str("\n\n## Agreement\n\n");
    for item in &synthesis.agreement {
        out.push_str(&format!("- {item}\n"));
    }
    out.push_str("\n## Disagreements\n\n");
    for item in &synthesis.disagreements {
        out.push_str(&format!("- **{}**", item.topic));
        if let Some(rec) = &item.recommendation {
            out.push_str(&format!(" — {rec}"));
        }
        out.push('\n');
        for position in &item.positions {
            if !position.summary.is_empty() {
                let label = position
                    .seat_label
                    .clone()
                    .unwrap_or_else(|| position.seat_id.to_string());
                out.push_str(&format!("  - {label}: {}\n", position.summary));
            }
        }
    }
    out.push_str("\n## Unique insights\n\n");
    for item in &synthesis.unique_insights {
        let label = item
            .seat_label
            .clone()
            .unwrap_or_else(|| "Seat".into());
        out.push_str(&format!("- {label}: {}\n", item.insight));
    }
    out.push_str("\n## Risks & tests\n\n");
    for item in &synthesis.risks_and_tests {
        out.push_str(&format!("- {item}\n"));
    }
    out.push_str("\n## Adoption\n\n");
    for (index, item) in synthesis.adoption_steps.iter().enumerate() {
        out.push_str(&format!("{}. {item}\n", index + 1));
    }
    out
}

/// Whether a capability class is allowed under council advisory policy.
///
/// Council is stricter than plan mode: **all** capabilities are denied so seats
/// cannot pull live workspace state beyond the frozen snapshot.
pub fn council_capability_allowed(_class: crate::capabilities::CapabilityClass) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn seat_count_bounds() {
        assert!(validate_seat_count(2).is_ok());
        assert!(validate_seat_count(4).is_ok());
        assert!(validate_seat_count(1).is_err());
        assert!(validate_seat_count(5).is_err());
    }

    #[test]
    fn ready_seats_filter_and_cap() {
        let preset = built_in_council_presets()
            .into_iter()
            .find(|p| p.id == "strong-reasoning")
            .unwrap();
        let ready = vec!["openai".to_string(), "xai".to_string()];
        let seats = resolve_ready_seats(&preset, &ready, 4);
        assert_eq!(
            seats,
            vec!["openai".to_string(), "xai".to_string()]
        );
    }

    #[test]
    fn config_normalized_merges_built_ins() {
        let config = CouncilConfig {
            default_preset_id: "custom".into(),
            presets: vec![CouncilPreset {
                id: "custom".into(),
                name: "Custom".into(),
                description: None,
                seat_provider_ids: vec!["openai".into(), "anthropic".into()],
                seat_model_ids: BTreeMap::new(),
                synthesizer_provider_id: "openai".into(),
                synthesizer_model_id: None,
                tool_policy: CouncilToolPolicy::None,
                built_in: false,
            }],
            max_seats: 99,
            seat_timeout_seconds: 0,
            synthesizer_timeout_seconds: 0,
            synthesize_on_partial: true,
            enabled: true,
        }
        .normalized();
        assert_eq!(config.max_seats, COUNCIL_MAX_SEATS);
        assert_eq!(config.seat_timeout_seconds, DEFAULT_SEAT_TIMEOUT_SECONDS);
        assert!(config.preset("code-focused").is_some());
        assert!(config.preset("custom").is_some());
        assert_eq!(config.default_preset_id, "custom");
    }

    #[test]
    fn persist_and_reload_run_manifest() {
        let dir = tempdir().unwrap();
        let session_id = Uuid::new_v4();
        let seat_a = Uuid::new_v4();
        let seat_b = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let snapshot = CouncilContextSnapshot {
            id: Uuid::new_v4(),
            prompt: "Review this design".into(),
            project_key: Some("proj".into()),
            workspace_path: Some("/tmp/proj".into()),
            attachments: Vec::new(),
            git_summary: Some("main clean".into()),
            created_at: Utc::now(),
        };
        let mut run = CouncilRun::new(
            session_id,
            snapshot,
            vec![
                CouncilSeat {
                    id: seat_a,
                    council_run_id: run_id,
                    run_id: Uuid::new_v4(),
                    provider_id: "anthropic".into(),
                    provider_label: "Claude".into(),
                    model_id: None,
                    model_label: None,
                    status: CouncilSeatStatus::Done,
                    started_at: None,
                    completed_at: None,
                    duration_ms: Some(1200),
                    raw_output: None,
                    artifact_path: None,
                    error: None,
                },
                CouncilSeat {
                    id: seat_b,
                    council_run_id: run_id,
                    run_id: Uuid::new_v4(),
                    provider_id: "openai".into(),
                    provider_label: "Codex".into(),
                    model_id: None,
                    model_label: None,
                    status: CouncilSeatStatus::Done,
                    started_at: None,
                    completed_at: None,
                    duration_ms: Some(900),
                    raw_output: None,
                    artifact_path: None,
                    error: None,
                },
            ],
            Some("code-focused".into()),
            CouncilToolPolicy::None,
            Some("anthropic".into()),
            None,
        )
        .unwrap();
        // Align ids for a consistent artifact tree.
        let council_id = run.id;
        for seat in &mut run.seats {
            seat.council_run_id = council_id;
        }

        let run_dir = dir.path().join("council-run");
        write_council_run_manifest(&run_dir, &run).unwrap();
        write_seat_artifact(&run_dir, seat_a, "Answer A").unwrap();
        write_seat_artifact(&run_dir, seat_b, "Answer B").unwrap();
        write_synthesis_artifact(&run_dir, "## Recommendation\n\nGo with A").unwrap();

        let loaded = read_council_run_manifest(&run_dir).unwrap();
        assert_eq!(loaded.id, council_id);
        assert_eq!(loaded.seats.len(), 2);
        assert_eq!(read_seat_artifact(&run_dir, seat_a).unwrap(), "Answer A");
    }

    #[test]
    fn parse_json_synthesis() {
        let seat = Uuid::new_v4();
        let raw = serde_json::json!({
            "recommendation": "Use approach A",
            "agreement": ["Need tests", "Keep API stable"],
            "disagreements": [{
                "topic": "Caching",
                "positions": [{
                    "seatId": "00000000-0000-0000-0000-000000000000",
                    "seatLabel": "Claude",
                    "summary": "Redis"
                }],
                "recommendation": "Start without cache"
            }],
            "uniqueInsights": [{
                "seatId": "00000000-0000-0000-0000-000000000000",
                "seatLabel": "Codex",
                "insight": "Watch race on resume"
            }],
            "risksAndTests": ["Add concurrency test"],
            "adoptionSteps": ["Land types", "Wire UI"],
            "unifiedMarkdown": "## Recommendation\n\nUse approach A"
        })
        .to_string();
        let mut labels = BTreeMap::new();
        labels.insert(seat, "Claude".into());
        let synthesis = parse_council_synthesis(&raw, "anthropic", None, None, &labels);
        assert_eq!(synthesis.recommendation, "Use approach A");
        assert_eq!(synthesis.agreement.len(), 2);
        assert_eq!(synthesis.disagreements.len(), 1);
        assert!(synthesis.parse_warnings.is_empty());
    }

    #[test]
    fn parse_markdown_fallback() {
        let raw = r#"## Recommendation

Ship advisory council first.

## Agreement

- Freeze context for all seats
- Synthesis primary in UI

## Unique insights

- Codex: Prefer structured artifacts

## Risks & tests

- Partial seat failure path

## Adoption

1. Land types
2. Wire orchestrator
"#;
        let synthesis =
            parse_council_synthesis(raw, "openai", Some("gpt".into()), None, &BTreeMap::new());
        assert!(synthesis.recommendation.contains("advisory council"));
        assert_eq!(synthesis.agreement.len(), 2);
        assert!(!synthesis.parse_warnings.is_empty());
        assert_eq!(synthesis.adoption_steps.len(), 2);
    }

    #[test]
    fn synthesizer_prompt_includes_all_seats() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let prompt = build_synthesizer_user_prompt(
            "What is wrong?",
            &[
                CouncilSeatAnswer {
                    seat_id: a,
                    label: "Claude".into(),
                    provider_id: "anthropic".into(),
                    model_id: None,
                    raw_output: "Race condition".into(),
                },
                CouncilSeatAnswer {
                    seat_id: b,
                    label: "Codex".into(),
                    provider_id: "openai".into(),
                    model_id: Some("o3".into()),
                    raw_output: "Missing lock".into(),
                },
            ],
        );
        assert!(prompt.contains("Race condition"));
        assert!(prompt.contains("Missing lock"));
        assert!(prompt.contains(&a.to_string()));
    }

    #[test]
    fn council_denies_all_capabilities() {
        use crate::capabilities::CapabilityClass;
        assert!(!council_capability_allowed(CapabilityClass::WorkspaceInspect));
        assert!(!council_capability_allowed(CapabilityClass::TerminalExecute));
        assert!(!council_capability_allowed(CapabilityClass::GithubWrite));
    }

    fn sample_seat(status: CouncilSeatStatus) -> CouncilSeat {
        CouncilSeat {
            id: Uuid::new_v4(),
            council_run_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            provider_id: "openai".into(),
            provider_label: "Codex".into(),
            model_id: None,
            model_label: None,
            status,
            started_at: None,
            completed_at: None,
            duration_ms: None,
            raw_output: Some("ok".into()),
            artifact_path: None,
            error: None,
        }
    }

    #[test]
    fn barrier_synthesizes_when_all_seats_succeed() {
        let seats = vec![
            sample_seat(CouncilSeatStatus::Done),
            sample_seat(CouncilSeatStatus::Done),
        ];
        match barrier_decision(&seats, true, false) {
            CouncilBarrierDecision::Synthesize { seat_ids } => {
                assert_eq!(seat_ids.len(), 2);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn barrier_partial_respects_synthesize_flag() {
        let seats = vec![
            sample_seat(CouncilSeatStatus::Done),
            sample_seat(CouncilSeatStatus::Failed),
        ];
        assert!(matches!(
            barrier_decision(&seats, true, false),
            CouncilBarrierDecision::Synthesize { .. }
        ));
        assert!(matches!(
            barrier_decision(&seats, false, false),
            CouncilBarrierDecision::FailNoSuccessfulSeats
        ));
    }

    #[test]
    fn barrier_fails_when_no_seats_succeed() {
        let seats = vec![
            sample_seat(CouncilSeatStatus::Failed),
            sample_seat(CouncilSeatStatus::Failed),
        ];
        assert_eq!(
            barrier_decision(&seats, true, false),
            CouncilBarrierDecision::FailNoSuccessfulSeats
        );
    }

    #[test]
    fn final_status_partial_when_mixed_and_synth_ok() {
        let seats = vec![
            sample_seat(CouncilSeatStatus::Done),
            sample_seat(CouncilSeatStatus::Failed),
        ];
        assert_eq!(
            final_run_status(&seats, true, false),
            CouncilRunStatus::Partial
        );
        assert_eq!(
            final_run_status(&seats, true, true),
            CouncilRunStatus::Cancelled
        );
    }
}
