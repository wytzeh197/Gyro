//! Local usage ledger: one row per provider call.
//!
//! Gyro cannot rely on providers to say what a session cost. Codex reports a
//! used percentage, Claude Code names its windows without ever measuring them,
//! and Kimi, xAI, and Gemini report nothing at all. So the ledger is written
//! locally, from what each run actually consumed.
//!
//! Rows are per *provider call*, not per user turn: one council turn is four
//! seats plus a synthesizer, and collapsing those into a single row is exactly
//! how quota disappears without a trace.
//!
//! A row records whether its token counts were measured or estimated, and the
//! two are never mixed into one number. An estimate is still counted — an
//! unmeasured provider is not a free one — but it is never presented as fact.

use anyhow::Result;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// What asked for the provider call. One user keypress can produce several.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageOrigin {
    /// A turn the user sent from the composer.
    Chat,
    /// A scheduled automation run, spent while nobody is watching.
    Automation,
    /// One seat of a Council turn.
    CouncilSeat,
    /// The Council synthesizer pass over the seat answers.
    CouncilSynthesis,
    /// A synthesis the user asked to run again.
    CouncilResynthesis,
}

impl UsageOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Automation => "automation",
            Self::CouncilSeat => "council-seat",
            Self::CouncilSynthesis => "council-synthesis",
            Self::CouncilResynthesis => "council-resynthesis",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "automation" => Self::Automation,
            "council-seat" => Self::CouncilSeat,
            "council-synthesis" => Self::CouncilSynthesis,
            "council-resynthesis" => Self::CouncilResynthesis,
            _ => Self::Chat,
        }
    }

    /// Human-facing name for the "where did it go" breakdown.
    pub fn label(self) -> &'static str {
        match self {
            Self::Chat => "Chat",
            Self::Automation => "Automations",
            Self::CouncilSeat => "Council seats",
            Self::CouncilSynthesis => "Council synthesis",
            Self::CouncilResynthesis => "Council re-synthesis",
        }
    }
}

/// How the call ended. Failed and cancelled calls are recorded too: a run that
/// burned tokens and then timed out still spent them.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageOutcome {
    Done,
    Failed,
    Cancelled,
}

impl UsageOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Done,
        }
    }
}

/// Token counts for one call.
///
/// `measured` separates what a provider reported from what Gyro estimated. The
/// distinction survives all the way to the UI; a guess is never rendered as a
/// measurement.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokens {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
    pub measured: bool,
}

impl UsageTokens {
    /// Tokens a provider reported.
    ///
    /// `total_tokens` and the input/output pair disagree often enough that the
    /// larger of the two is the honest reading, matching how the composer
    /// context meter resolves the same conflict.
    pub fn measured(
        input_tokens: Option<u64>,
        cached_input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        reasoning_output_tokens: Option<u64>,
        total_tokens: Option<u64>,
    ) -> Self {
        let input = input_tokens.unwrap_or_default();
        let output = output_tokens.unwrap_or_default();
        Self {
            input_tokens: input,
            cached_input_tokens: cached_input_tokens.unwrap_or_default(),
            output_tokens: output,
            reasoning_output_tokens: reasoning_output_tokens.unwrap_or_default(),
            total_tokens: total_tokens.unwrap_or_default().max(input + output),
            measured: true,
        }
    }

    /// A fallback reading for providers that report nothing.
    ///
    /// Four characters per token is the same rough ratio the composer meter
    /// uses. It is wrong in both directions and is labelled as an estimate
    /// everywhere it surfaces.
    pub fn estimated(prompt_chars: usize, response_chars: usize) -> Self {
        let input = estimate_tokens(prompt_chars);
        let output = estimate_tokens(response_chars);
        Self {
            input_tokens: input,
            cached_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: 0,
            total_tokens: input + output,
            measured: false,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.total_tokens == 0 && self.input_tokens == 0 && self.output_tokens == 0
    }
}

pub fn estimate_tokens(characters: usize) -> u64 {
    (characters as u64).div_ceil(4)
}

/// One provider call, as written to the ledger.
#[derive(Clone, Debug)]
pub struct UsageEntry {
    pub session_id: Uuid,
    pub turn_id: Option<Uuid>,
    /// Set for Council seats, so a seat's spend can be traced back to it.
    pub seat_id: Option<Uuid>,
    pub provider_id: String,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub origin: UsageOrigin,
    pub outcome: UsageOutcome,
    pub tokens: UsageTokens,
    pub wall_ms: u64,
    /// Provider-level retries folded into this call. A retry nobody counted is
    /// how quota vanishes silently.
    pub retry_count: u32,
}

/// Spend for one origin within a set of calls.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageOriginTotals {
    pub origin: String,
    pub label: String,
    pub calls: u32,
    pub total_tokens: u64,
}

/// Aggregated spend, as the session cost line and later the budgets read it.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub calls: u32,
    /// Calls whose tokens the provider reported.
    pub measured_calls: u32,
    /// Calls whose tokens Gyro estimated because the provider reported nothing.
    pub estimated_calls: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub by_origin: Vec<UsageOriginTotals>,
    pub first_call_at: Option<DateTime<Utc>>,
    pub last_call_at: Option<DateTime<Utc>>,
}

impl UsageTotals {
    /// Whether any part of this total rests on an estimate.
    pub fn has_estimates(&self) -> bool {
        self.estimated_calls > 0
    }
}

/// Ceilings that stop spending nobody chose.
///
/// Preflight covers the deliberate expensive send. These cover the rest: a
/// retry loop, an automation that reschedules itself, a turn that keeps
/// growing. They are counted from the ledger, so they apply to every provider
/// including the ones that report no usage of their own.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageGuardConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// The current hold on provider runs, with its reason and expiry.
    #[serde(default)]
    pub pause: PauseState,
    /// Per-provider spend caps measured against the ledger.
    #[serde(default)]
    pub budgets: Vec<UsageBudget>,
    /// How far back the call-rate ceilings look.
    #[serde(default = "default_guard_window_minutes")]
    pub window_minutes: u32,
    /// Calls allowed in the window across all origins.
    #[serde(default = "default_max_calls_per_window")]
    pub max_calls_per_window: u32,
    /// Calls allowed in the window for unattended work.
    ///
    /// Lower than the overall ceiling on purpose: a schedule running while
    /// nobody watches is the spend most worth catching early.
    #[serde(default = "default_max_unattended_calls_per_window")]
    pub max_unattended_calls_per_window: u32,
    /// Tokens one call may bill before it is stopped. Zero disables it.
    #[serde(default = "default_max_tokens_per_call")]
    pub max_tokens_per_call: u64,
    /// Council re-syntheses allowed in the window.
    ///
    /// Re-running a synthesis is a full provider call each time, and it is the
    /// one retry a user can trigger repeatedly by hand.
    #[serde(default = "default_max_resyntheses_per_window")]
    pub max_resyntheses_per_window: u32,
}

fn default_true() -> bool {
    true
}

fn default_guard_window_minutes() -> u32 {
    10
}

fn default_max_calls_per_window() -> u32 {
    40
}

fn default_max_unattended_calls_per_window() -> u32 {
    12
}

fn default_max_tokens_per_call() -> u64 {
    2_000_000
}

fn default_max_resyntheses_per_window() -> u32 {
    3
}

impl Default for UsageGuardConfig {
    fn default() -> Self {
        Self {
            enabled: default_true(),
            pause: PauseState::default(),
            budgets: Vec::new(),
            window_minutes: default_guard_window_minutes(),
            max_calls_per_window: default_max_calls_per_window(),
            max_unattended_calls_per_window: default_max_unattended_calls_per_window(),
            max_tokens_per_call: default_max_tokens_per_call(),
            max_resyntheses_per_window: default_max_resyntheses_per_window(),
        }
    }
}

/// Why Gyro is holding provider runs.
///
/// A pause carries its provenance so the user is told what stopped work and
/// when it resumes. A bare boolean could only say "no".
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PauseReason {
    /// The user pressed stop.
    Manual,
    /// A budget ran out. Lifts by itself when the window rolls.
    BudgetExhausted { provider_id: String },
}

/// What a pause covers.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PauseScope {
    /// Every provider run.
    #[default]
    All,
    /// Only unattended work, so a schedule stops but the user can keep going.
    Automations,
}

/// A hold on provider runs, with its reason and its own expiry.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseState {
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub scope: PauseScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<PauseReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<DateTime<Utc>>,
    /// When the pause lifts on its own. A budget pause ends when its window
    /// rolls; a manual pause has no expiry and waits for the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_resume_at: Option<DateTime<Utc>>,
}

impl PauseState {
    pub fn manual(scope: PauseScope) -> Self {
        Self {
            active: true,
            scope,
            reason: Some(PauseReason::Manual),
            since: Some(Utc::now()),
            auto_resume_at: None,
        }
    }

    pub fn budget_exhausted(provider_id: &str, auto_resume_at: DateTime<Utc>) -> Self {
        Self {
            active: true,
            scope: PauseScope::All,
            reason: Some(PauseReason::BudgetExhausted {
                provider_id: provider_id.into(),
            }),
            since: Some(Utc::now()),
            auto_resume_at: Some(auto_resume_at),
        }
    }

    /// Whether the pause still applies at this instant.
    ///
    /// An expired auto-resume is not a pause: the window it was waiting on has
    /// rolled, so work continues without the user having to clear anything.
    pub fn is_active_at(&self, now: DateTime<Utc>) -> bool {
        self.active && self.auto_resume_at.is_none_or(|resume| now < resume)
    }

    pub fn covers(&self, origin: UsageOrigin) -> bool {
        match self.scope {
            PauseScope::All => true,
            PauseScope::Automations => origin == UsageOrigin::Automation,
        }
    }

    /// User-facing sentence for a blocked run.
    pub fn explain(&self) -> String {
        match &self.reason {
            Some(PauseReason::BudgetExhausted { provider_id }) => {
                let resume = self
                    .auto_resume_at
                    .map(|at| format!(" It resumes at {}.", at.format("%H:%M")))
                    .unwrap_or_default();
                format!("The {provider_id} budget is spent, so Gyro paused provider runs.{resume}")
            }
            Some(PauseReason::Manual) | None => match self.scope {
                PauseScope::Automations => "Automations are paused. Chat still runs.".into(),
                PauseScope::All => {
                    "Gyro is paused. Provider runs are on hold until you resume them.".into()
                }
            },
        }
    }
}

/// A cap on what one provider may spend in a rolling window.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBudget {
    pub provider_id: String,
    #[serde(default = "default_budget_window_hours")]
    pub window_hours: u32,
    /// Tokens allowed in the window. Zero means the budget is off.
    pub max_tokens: u64,
    #[serde(default = "default_notify_percent")]
    pub notify_percent: u8,
    #[serde(default = "default_throttle_percent")]
    pub throttle_percent: u8,
}

fn default_budget_window_hours() -> u32 {
    24
}

fn default_notify_percent() -> u8 {
    70
}

fn default_throttle_percent() -> u8 {
    90
}

/// How close a budget is to its cap.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BudgetLevel {
    Ok,
    /// Worth showing, not worth interrupting for.
    Notify,
    /// Expensive work needs to wait; ordinary turns continue.
    Throttle,
    /// Nothing more starts on this provider.
    Exhausted,
}

/// A budget measured against the ledger.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetState {
    pub provider_id: String,
    pub used_tokens: u64,
    pub max_tokens: u64,
    pub percent: u8,
    pub level: BudgetLevel,
    pub window_hours: u32,
    /// When the window this budget measures rolls past its oldest call.
    pub window_resets_at: DateTime<Utc>,
    /// Whether any spend counted here was estimated rather than reported.
    pub has_estimates: bool,
}

/// Measure one budget against what the ledger says was spent in its window.
pub fn budget_state(
    conn: &Connection,
    budget: &UsageBudget,
    now: DateTime<Utc>,
) -> Result<BudgetState> {
    let window_hours = budget.window_hours.max(1);
    let since = now - chrono::Duration::hours(i64::from(window_hours));
    let totals = provider_usage_totals_since(conn, &budget.provider_id, since)?;
    let percent = if budget.max_tokens == 0 {
        0
    } else {
        ((totals.total_tokens.saturating_mul(100)) / budget.max_tokens).min(255) as u8
    };
    let level = if budget.max_tokens == 0 {
        BudgetLevel::Ok
    } else if percent >= 100 {
        BudgetLevel::Exhausted
    } else if percent >= budget.throttle_percent {
        BudgetLevel::Throttle
    } else if percent >= budget.notify_percent {
        BudgetLevel::Notify
    } else {
        BudgetLevel::Ok
    };
    // The window is rolling, so it frees up when its oldest call ages out.
    let window_resets_at = totals
        .first_call_at
        .map(|first| first + chrono::Duration::hours(i64::from(window_hours)))
        .unwrap_or(now);
    Ok(BudgetState {
        has_estimates: totals.has_estimates(),
        level,
        max_tokens: budget.max_tokens,
        percent: percent.min(100),
        provider_id: budget.provider_id.clone(),
        used_tokens: totals.total_tokens,
        window_hours,
        window_resets_at,
    })
}

/// Whether a budget lets this call start.
///
/// Exhausted stops everything on that provider. Throttle stops only the
/// expensive shapes — fan-out, synthesis, and unattended work — so the last
/// tenth of a budget stays available for the person at the keyboard.
pub fn budget_decision(state: &BudgetState, origin: UsageOrigin) -> GuardVerdict {
    match state.level {
        BudgetLevel::Ok | BudgetLevel::Notify => GuardVerdict::Allow,
        BudgetLevel::Throttle => {
            if matches!(origin, UsageOrigin::Chat) {
                GuardVerdict::Allow
            } else {
                GuardVerdict::Block(format!(
                    "The {} budget is {}% spent, so Gyro is holding council runs and automations until it frees up. Ordinary turns still work.",
                    state.provider_id, state.percent
                ))
            }
        }
        BudgetLevel::Exhausted => GuardVerdict::Block(format!(
            "The {} budget for the last {} hours is spent ({} of {} tokens).",
            state.provider_id, state.window_hours, state.used_tokens, state.max_tokens
        )),
    }
}

/// What the ledger says about the recent past, for a guard decision.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RecentUsage {
    pub calls: u32,
    pub unattended_calls: u32,
    pub resynthesis_calls: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GuardVerdict {
    Allow,
    /// The call must not start. The reason is user-facing.
    Block(String),
}

impl GuardVerdict {
    pub fn is_blocked(&self) -> bool {
        matches!(self, Self::Block(_))
    }
}

/// Decide whether one more provider call may start.
///
/// Deliberately pure: the counts come from the ledger and the thresholds from
/// config, so the rule itself can be tested without a database or a provider.
pub fn guard_decision(
    config: &UsageGuardConfig,
    origin: UsageOrigin,
    recent: RecentUsage,
) -> GuardVerdict {
    if config.pause.is_active_at(Utc::now()) && config.pause.covers(origin) {
        return GuardVerdict::Block(config.pause.explain());
    }
    if !config.enabled {
        return GuardVerdict::Allow;
    }
    let window = config.window_minutes.max(1);
    if origin == UsageOrigin::Automation
        && config.max_unattended_calls_per_window > 0
        && recent.unattended_calls >= config.max_unattended_calls_per_window
    {
        return GuardVerdict::Block(format!(
            "Automations have made {} provider calls in the last {window} minutes, which is the unattended limit. Gyro paused this run so a schedule cannot keep spending unattended.",
            recent.unattended_calls
        ));
    }
    if origin == UsageOrigin::CouncilResynthesis
        && config.max_resyntheses_per_window > 0
        && recent.resynthesis_calls >= config.max_resyntheses_per_window
    {
        return GuardVerdict::Block(format!(
            "This synthesis has already been re-run {} times in the last {window} minutes. Each re-run is a full provider call, so Gyro stopped here.",
            recent.resynthesis_calls
        ));
    }
    if config.max_calls_per_window > 0 && recent.calls >= config.max_calls_per_window {
        return GuardVerdict::Block(format!(
            "There have been {} provider calls in the last {window} minutes, which is the safety limit. Gyro stopped this run in case something is looping.",
            recent.calls
        ));
    }
    GuardVerdict::Allow
}

/// Whether a call that has already billed this much should be cut short.
pub fn exceeds_call_ceiling(config: &UsageGuardConfig, billed_tokens: u64) -> bool {
    config.enabled && config.max_tokens_per_call > 0 && billed_tokens > config.max_tokens_per_call
}

/// Ledger counts for the guard window.
pub fn recent_usage(conn: &Connection, since: DateTime<Utc>) -> Result<RecentUsage> {
    let since = since.to_rfc3339();
    let mut stmt = conn.prepare(
        "select origin, count(*) from usage_ledger where occurred_at >= ?1 group by origin",
    )?;
    let rows = stmt.query_map([&since], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut recent = RecentUsage::default();
    for row in rows {
        let (origin, count) = row?;
        let count = count.max(0) as u32;
        recent.calls += count;
        match UsageOrigin::from_str(&origin) {
            UsageOrigin::Automation => recent.unattended_calls += count,
            UsageOrigin::CouncilResynthesis => recent.resynthesis_calls += count,
            _ => {}
        }
    }
    Ok(recent)
}

pub fn ensure_usage_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "create table if not exists usage_ledger (
           id text primary key not null,
           occurred_at text not null,
           session_id text not null,
           turn_id text,
           seat_id text,
           provider_id text not null,
           model_id text,
           reasoning_effort text,
           origin text not null,
           outcome text not null,
           input_tokens integer not null default 0,
           cached_input_tokens integer not null default 0,
           output_tokens integer not null default 0,
           reasoning_output_tokens integer not null default 0,
           total_tokens integer not null default 0,
           measured integer not null default 0,
           wall_ms integer not null default 0,
           retry_count integer not null default 0
         );

         create index if not exists idx_usage_ledger_session
         on usage_ledger(session_id, occurred_at desc);

         create index if not exists idx_usage_ledger_occurred_at
         on usage_ledger(occurred_at desc);

         create index if not exists idx_usage_ledger_provider_window
         on usage_ledger(provider_id, occurred_at desc);",
    )?;
    Ok(())
}

/// Append one call. The ledger is append-only; rows are never rewritten.
pub fn insert_usage_entry(conn: &Connection, entry: &UsageEntry) -> Result<Uuid> {
    let id = Uuid::new_v4();
    conn.execute(
        "insert into usage_ledger (
           id, occurred_at, session_id, turn_id, seat_id, provider_id, model_id,
           reasoning_effort, origin, outcome, input_tokens, cached_input_tokens,
           output_tokens, reasoning_output_tokens, total_tokens, measured,
           wall_ms, retry_count
         ) values (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
           ?16, ?17, ?18
         )",
        params![
            id.to_string(),
            Utc::now().to_rfc3339(),
            entry.session_id.to_string(),
            entry.turn_id.map(|value| value.to_string()),
            entry.seat_id.map(|value| value.to_string()),
            entry.provider_id,
            entry.model_id,
            entry.reasoning_effort,
            entry.origin.as_str(),
            entry.outcome.as_str(),
            entry.tokens.input_tokens,
            entry.tokens.cached_input_tokens,
            entry.tokens.output_tokens,
            entry.tokens.reasoning_output_tokens,
            entry.tokens.total_tokens,
            i64::from(entry.tokens.measured),
            entry.wall_ms,
            entry.retry_count,
        ],
    )?;
    Ok(id)
}

fn totals_from_rows(
    conn: &Connection,
    where_clause: &str,
    bind: &[&dyn rusqlite::ToSql],
) -> Result<UsageTotals> {
    let mut totals = UsageTotals::default();
    let mut stmt = conn.prepare(&format!(
        "select origin, measured, input_tokens, output_tokens, total_tokens, occurred_at
         from usage_ledger where {where_clause} order by occurred_at asc"
    ))?;
    let rows = stmt.query_map(bind, |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;

    let mut by_origin: Vec<UsageOriginTotals> = Vec::new();
    for row in rows {
        let (origin, measured, input_tokens, output_tokens, total_tokens, occurred_at) = row?;
        totals.calls += 1;
        if measured != 0 {
            totals.measured_calls += 1;
        } else {
            totals.estimated_calls += 1;
        }
        totals.input_tokens += input_tokens.max(0) as u64;
        totals.output_tokens += output_tokens.max(0) as u64;
        totals.total_tokens += total_tokens.max(0) as u64;

        let parsed = DateTime::parse_from_rfc3339(&occurred_at)
            .ok()
            .map(|value| value.with_timezone(&Utc));
        if let Some(parsed) = parsed {
            if totals.first_call_at.is_none() {
                totals.first_call_at = Some(parsed);
            }
            totals.last_call_at = Some(parsed);
        }

        match by_origin.iter_mut().find(|item| item.origin == origin) {
            Some(existing) => {
                existing.calls += 1;
                existing.total_tokens += total_tokens.max(0) as u64;
            }
            None => {
                let parsed_origin = UsageOrigin::from_str(&origin);
                by_origin.push(UsageOriginTotals {
                    origin: parsed_origin.as_str().into(),
                    label: parsed_origin.label().into(),
                    calls: 1,
                    total_tokens: total_tokens.max(0) as u64,
                });
            }
        }
    }

    // Biggest spender first: the breakdown exists to answer "where did it go".
    by_origin.sort_by(|left, right| {
        right
            .total_tokens
            .cmp(&left.total_tokens)
            .then_with(|| right.calls.cmp(&left.calls))
    });
    totals.by_origin = by_origin;
    Ok(totals)
}

/// What one chat has cost, across every call it produced.
pub fn session_usage_totals(conn: &Connection, session_id: Uuid) -> Result<UsageTotals> {
    let session = session_id.to_string();
    totals_from_rows(conn, "session_id = ?1", &[&session])
}

/// What every provider has cost since a point in time. The budgets in the next
/// layer read their windows from here.
pub fn usage_totals_since(conn: &Connection, since: DateTime<Utc>) -> Result<UsageTotals> {
    let since = since.to_rfc3339();
    totals_from_rows(conn, "occurred_at >= ?1", &[&since])
}

/// What a single provider has cost since a point in time.
pub fn provider_usage_totals_since(
    conn: &Connection,
    provider_id: &str,
    since: DateTime<Utc>,
) -> Result<UsageTotals> {
    let since = since.to_rfc3339();
    totals_from_rows(
        conn,
        "provider_id = ?1 and occurred_at >= ?2",
        &[&provider_id, &since],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        ensure_usage_schema(&conn).expect("create usage schema");
        conn
    }

    fn entry(session_id: Uuid, origin: UsageOrigin, tokens: UsageTokens) -> UsageEntry {
        UsageEntry {
            session_id,
            turn_id: None,
            seat_id: None,
            provider_id: "anthropic".into(),
            model_id: Some("claude-sonnet-5".into()),
            reasoning_effort: Some("high".into()),
            origin,
            outcome: UsageOutcome::Done,
            tokens,
            wall_ms: 1_200,
            retry_count: 0,
        }
    }

    #[test]
    fn measured_tokens_prefer_the_larger_of_total_and_the_pair() {
        let tokens = UsageTokens::measured(Some(900), Some(100), Some(300), Some(120), Some(50));
        assert_eq!(tokens.total_tokens, 1_200);
        assert!(tokens.measured);

        let trusted_total = UsageTokens::measured(Some(10), None, Some(10), None, Some(9_000));
        assert_eq!(trusted_total.total_tokens, 9_000);
    }

    #[test]
    fn estimates_are_marked_as_estimates() {
        let tokens = UsageTokens::estimated(400, 800);
        assert_eq!(tokens.input_tokens, 100);
        assert_eq!(tokens.output_tokens, 200);
        assert_eq!(tokens.total_tokens, 300);
        assert!(!tokens.measured);
    }

    #[test]
    fn a_council_turn_is_recorded_as_one_row_per_seat() {
        let conn = memory_conn();
        let session_id = Uuid::new_v4();
        for _ in 0..4 {
            insert_usage_entry(
                &conn,
                &entry(
                    session_id,
                    UsageOrigin::CouncilSeat,
                    UsageTokens::measured(Some(1_000), None, Some(500), None, None),
                ),
            )
            .expect("insert seat");
        }
        insert_usage_entry(
            &conn,
            &entry(
                session_id,
                UsageOrigin::CouncilSynthesis,
                UsageTokens::measured(Some(2_000), None, Some(400), None, None),
            ),
        )
        .expect("insert synthesis");

        let totals = session_usage_totals(&conn, session_id).expect("totals");
        assert_eq!(totals.calls, 5);
        assert_eq!(totals.total_tokens, 4 * 1_500 + 2_400);
        assert_eq!(totals.by_origin.len(), 2);
        // Seats outspend the synthesizer, so they lead the breakdown.
        assert_eq!(totals.by_origin[0].origin, "council-seat");
        assert_eq!(totals.by_origin[0].calls, 4);
        assert!(!totals.has_estimates());
    }

    #[test]
    fn estimated_and_measured_calls_are_counted_apart() {
        let conn = memory_conn();
        let session_id = Uuid::new_v4();
        insert_usage_entry(
            &conn,
            &entry(
                session_id,
                UsageOrigin::Chat,
                UsageTokens::measured(Some(100), None, Some(50), None, None),
            ),
        )
        .expect("insert measured");
        insert_usage_entry(
            &conn,
            &entry(
                session_id,
                UsageOrigin::Chat,
                UsageTokens::estimated(400, 400),
            ),
        )
        .expect("insert estimated");

        let totals = session_usage_totals(&conn, session_id).expect("totals");
        assert_eq!(totals.calls, 2);
        assert_eq!(totals.measured_calls, 1);
        assert_eq!(totals.estimated_calls, 1);
        assert!(totals.has_estimates());
    }

    #[test]
    fn failed_calls_still_count_against_spend() {
        let conn = memory_conn();
        let session_id = Uuid::new_v4();
        let mut failed = entry(
            session_id,
            UsageOrigin::Chat,
            UsageTokens::measured(Some(5_000), None, Some(0), None, None),
        );
        failed.outcome = UsageOutcome::Failed;
        insert_usage_entry(&conn, &failed).expect("insert failed call");

        let totals = session_usage_totals(&conn, session_id).expect("totals");
        assert_eq!(totals.calls, 1);
        assert_eq!(totals.total_tokens, 5_000);
    }

    #[test]
    fn a_pause_stops_every_origin() {
        let config = UsageGuardConfig {
            pause: PauseState::manual(PauseScope::All),
            ..UsageGuardConfig::default()
        };
        for origin in [
            UsageOrigin::Chat,
            UsageOrigin::Automation,
            UsageOrigin::CouncilSeat,
        ] {
            assert!(guard_decision(&config, origin, RecentUsage::default()).is_blocked());
        }
    }

    #[test]
    fn an_automations_pause_leaves_the_keyboard_working() {
        let config = UsageGuardConfig {
            pause: PauseState::manual(PauseScope::Automations),
            ..UsageGuardConfig::default()
        };
        assert!(
            guard_decision(&config, UsageOrigin::Automation, RecentUsage::default()).is_blocked()
        );
        assert_eq!(
            guard_decision(&config, UsageOrigin::Chat, RecentUsage::default()),
            GuardVerdict::Allow
        );
    }

    #[test]
    fn a_budget_pause_lifts_itself_when_its_window_rolls() {
        let expired =
            PauseState::budget_exhausted("anthropic", Utc::now() - chrono::Duration::minutes(1));
        assert!(!expired.is_active_at(Utc::now()));
        let config = UsageGuardConfig {
            pause: expired,
            ..UsageGuardConfig::default()
        };
        assert_eq!(
            guard_decision(&config, UsageOrigin::Chat, RecentUsage::default()),
            GuardVerdict::Allow
        );

        let live =
            PauseState::budget_exhausted("anthropic", Utc::now() + chrono::Duration::hours(2));
        assert!(live.is_active_at(Utc::now()));
        assert!(live.explain().contains("anthropic"));
        // A manual pause has no expiry and waits for the user.
        assert!(PauseState::manual(PauseScope::All)
            .is_active_at(Utc::now() + chrono::Duration::days(365)));
    }

    #[test]
    fn a_budget_throttles_fan_out_before_it_stops_chat() {
        let conn = memory_conn();
        let session_id = Uuid::new_v4();
        // 9,500 of a 10,000 token budget: past throttle, not yet spent.
        insert_usage_entry(
            &conn,
            &entry(
                session_id,
                UsageOrigin::Chat,
                UsageTokens::measured(Some(9_000), None, Some(500), None, None),
            ),
        )
        .expect("insert call");
        let budget = UsageBudget {
            provider_id: "anthropic".into(),
            window_hours: 24,
            max_tokens: 10_000,
            notify_percent: 70,
            throttle_percent: 90,
        };
        let state = budget_state(&conn, &budget, Utc::now()).expect("budget state");
        assert_eq!(state.level, BudgetLevel::Throttle);
        assert_eq!(state.percent, 95);
        assert_eq!(
            budget_decision(&state, UsageOrigin::Chat),
            GuardVerdict::Allow
        );
        assert!(budget_decision(&state, UsageOrigin::CouncilSeat).is_blocked());
        assert!(budget_decision(&state, UsageOrigin::Automation).is_blocked());
    }

    #[test]
    fn an_exhausted_budget_stops_everything_on_that_provider() {
        let conn = memory_conn();
        let session_id = Uuid::new_v4();
        insert_usage_entry(
            &conn,
            &entry(
                session_id,
                UsageOrigin::Chat,
                UsageTokens::measured(Some(12_000), None, Some(0), None, None),
            ),
        )
        .expect("insert call");
        let budget = UsageBudget {
            provider_id: "anthropic".into(),
            window_hours: 24,
            max_tokens: 10_000,
            notify_percent: 70,
            throttle_percent: 90,
        };
        let state = budget_state(&conn, &budget, Utc::now()).expect("budget state");
        assert_eq!(state.level, BudgetLevel::Exhausted);
        assert_eq!(state.percent, 100);
        assert!(budget_decision(&state, UsageOrigin::Chat).is_blocked());
        // The rolling window frees up a day after the oldest call in it.
        assert!(state.window_resets_at > Utc::now() + chrono::Duration::hours(23));
    }

    #[test]
    fn a_budget_with_no_cap_never_blocks_and_estimates_are_flagged() {
        let conn = memory_conn();
        let session_id = Uuid::new_v4();
        insert_usage_entry(
            &conn,
            &entry(
                session_id,
                UsageOrigin::Chat,
                UsageTokens::estimated(4_000, 4_000),
            ),
        )
        .expect("insert call");
        let budget = UsageBudget {
            provider_id: "anthropic".into(),
            window_hours: 24,
            max_tokens: 0,
            notify_percent: 70,
            throttle_percent: 90,
        };
        let state = budget_state(&conn, &budget, Utc::now()).expect("budget state");
        assert_eq!(state.level, BudgetLevel::Ok);
        assert!(state.has_estimates);
        assert_eq!(
            budget_decision(&state, UsageOrigin::CouncilSeat),
            GuardVerdict::Allow
        );
    }

    #[test]
    fn automations_hit_a_lower_ceiling_than_the_person_at_the_keyboard() {
        let config = UsageGuardConfig::default();
        let recent = RecentUsage {
            calls: 12,
            unattended_calls: 12,
            resynthesis_calls: 0,
        };
        assert!(guard_decision(&config, UsageOrigin::Automation, recent).is_blocked());
        // The same history does not stop an interactive turn.
        assert_eq!(
            guard_decision(&config, UsageOrigin::Chat, recent),
            GuardVerdict::Allow
        );
    }

    #[test]
    fn a_runaway_call_rate_stops_everything() {
        let config = UsageGuardConfig::default();
        let recent = RecentUsage {
            calls: 40,
            unattended_calls: 0,
            resynthesis_calls: 0,
        };
        let verdict = guard_decision(&config, UsageOrigin::Chat, recent);
        assert!(verdict.is_blocked());
        match verdict {
            GuardVerdict::Block(reason) => assert!(reason.contains("looping")),
            GuardVerdict::Allow => unreachable!(),
        }
    }

    #[test]
    fn disabled_guards_allow_everything_but_a_pause_still_holds() {
        let config = UsageGuardConfig {
            enabled: false,
            ..UsageGuardConfig::default()
        };
        let recent = RecentUsage {
            calls: 9_999,
            unattended_calls: 9_999,
            resynthesis_calls: 9_999,
        };
        assert_eq!(
            guard_decision(&config, UsageOrigin::Automation, recent),
            GuardVerdict::Allow
        );
        assert!(!exceeds_call_ceiling(&config, u64::MAX));

        let paused = UsageGuardConfig {
            enabled: false,
            pause: PauseState::manual(PauseScope::All),
            ..UsageGuardConfig::default()
        };
        assert!(guard_decision(&paused, UsageOrigin::Chat, RecentUsage::default()).is_blocked());
    }

    #[test]
    fn the_per_call_ceiling_only_trips_above_the_limit() {
        let config = UsageGuardConfig {
            max_tokens_per_call: 1_000,
            ..UsageGuardConfig::default()
        };
        assert!(!exceeds_call_ceiling(&config, 1_000));
        assert!(exceeds_call_ceiling(&config, 1_001));

        let off = UsageGuardConfig {
            max_tokens_per_call: 0,
            ..UsageGuardConfig::default()
        };
        assert!(!exceeds_call_ceiling(&off, u64::MAX));
    }

    #[test]
    fn re_synthesis_has_its_own_budget() {
        let config = UsageGuardConfig::default();
        let recent = RecentUsage {
            calls: 3,
            unattended_calls: 0,
            resynthesis_calls: 3,
        };
        let verdict = guard_decision(&config, UsageOrigin::CouncilResynthesis, recent);
        assert!(verdict.is_blocked());
        match verdict {
            GuardVerdict::Block(reason) => assert!(reason.contains("re-run 3 times")),
            GuardVerdict::Allow => unreachable!(),
        }
        // The same history leaves ordinary turns and fresh council runs alone.
        assert_eq!(
            guard_decision(&config, UsageOrigin::Chat, recent),
            GuardVerdict::Allow
        );
        assert_eq!(
            guard_decision(&config, UsageOrigin::CouncilSynthesis, recent),
            GuardVerdict::Allow
        );
    }

    #[test]
    fn recent_usage_counts_unattended_calls_apart() {
        let conn = memory_conn();
        let session_id = Uuid::new_v4();
        for origin in [
            UsageOrigin::Chat,
            UsageOrigin::Automation,
            UsageOrigin::Automation,
            UsageOrigin::CouncilSeat,
            UsageOrigin::CouncilResynthesis,
        ] {
            insert_usage_entry(
                &conn,
                &entry(session_id, origin, UsageTokens::estimated(40, 40)),
            )
            .expect("insert call");
        }

        let recent =
            recent_usage(&conn, Utc::now() - chrono::Duration::minutes(10)).expect("recent usage");
        assert_eq!(recent.calls, 5);
        assert_eq!(recent.unattended_calls, 2);
        assert_eq!(recent.resynthesis_calls, 1);

        let future =
            recent_usage(&conn, Utc::now() + chrono::Duration::minutes(10)).expect("future window");
        assert_eq!(future.calls, 0);
    }

    #[test]
    fn windows_scope_totals_by_time_and_provider() {
        let conn = memory_conn();
        let session_id = Uuid::new_v4();
        insert_usage_entry(
            &conn,
            &entry(
                session_id,
                UsageOrigin::Chat,
                UsageTokens::measured(Some(700), None, Some(300), None, None),
            ),
        )
        .expect("insert call");

        let since = Utc::now() - chrono::Duration::hours(1);
        assert_eq!(
            usage_totals_since(&conn, since)
                .expect("window totals")
                .total_tokens,
            1_000
        );
        assert_eq!(
            provider_usage_totals_since(&conn, "anthropic", since)
                .expect("provider totals")
                .total_tokens,
            1_000
        );
        assert_eq!(
            provider_usage_totals_since(&conn, "openai", since)
                .expect("other provider totals")
                .calls,
            0
        );
        let future = Utc::now() + chrono::Duration::hours(1);
        assert_eq!(
            usage_totals_since(&conn, future)
                .expect("future totals")
                .calls,
            0
        );
    }
}
