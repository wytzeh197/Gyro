//! Context compaction: the activity rows both kinds report through, and the
//! setting that lets Gyro compact a tool loop by itself.
//!
//! The compaction itself runs beside this module -- a manual `/compact` through
//! the provider session, an automatic one inside a tool loop (see
//! `provider_context` and the two runners). What lives here is the desktop half
//! a person touches: the stored share the Settings surface shows, and the rows
//! that say a compaction happened without anyone pressing anything.

use super::*;

/// The activity row for one automatic compaction inside a tool loop.
///
/// Its id deliberately does not start with `context-compaction-`: that prefix
/// marks the manual `/compact`, and the composer meter starts its estimate over
/// on one, which an in-flight rewrite must not do -- the chat's stored history
/// is untouched, so every earlier reading still measures it.
pub(super) fn activity(
    index: usize,
    compaction: &crate::provider_context::ContextCompaction,
) -> ProviderActivity {
    ProviderActivity {
        id: format!("context-auto-compaction-{index}"),
        kind: "context".into(),
        label: "Auto-compacted context".into(),
        detail: Some(format!(
            "The last request filled {}% of the window, so {} older tool exchanges, about {} tokens, were replaced for the rest of this turn.",
            compaction.percent,
            compaction.exchanges,
            crate::provider_context::estimated_tokens(compaction.characters)
        )),
        file_counts: None,
        note: None,
        status: "done".into(),
    }
}

pub(super) fn codex_context_compaction_activity(
    params: &serde_json::Value,
    status: &str,
) -> ProviderActivity {
    let identity = params
        .get("turnId")
        .or_else(|| params.pointer("/item/id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("turn");
    ProviderActivity {
        id: format!("context-compaction-{identity}"),
        kind: "context".into(),
        label: if status == "running" {
            "Compacting context".into()
        } else {
            "Compacted context".into()
        },
        detail: Some(
            "Summarized earlier conversation to keep the thread within the model context window."
                .into(),
        ),
        file_counts: None,
        note: None,
        status: status.into(),
    }
}

/// What a manual `/compact` on a provider without a resumable compacted
/// session actually did to the transcript.
///
/// Two shapes reach here. A model summary is what a provider wrote from the
/// transcript; the local rewrite either kept the history whole or replaced
/// turns with a digest and never paraphrased anything. Each row says only what
/// happened, so neither path borrows the other's wording.
pub(super) fn manual_compaction_detail(
    compaction: &super::conversation_history::LocalCompaction,
    summary: Option<&CompactionSummary<'_>>,
) -> String {
    if compaction.summarized {
        let label = summary.map_or("the model", |report| report.label);
        let elapsed = summary.map_or(0, |report| report.elapsed_ms);
        let tokens = summary
            .and_then(|report| report.input_tokens)
            .map(|tokens| format!(", {tokens} input tokens"))
            .unwrap_or_default();
        return format!(
            "Summarized the earlier conversation with {label} in {elapsed}{tokens}; those turns are no longer sent in full.",
            elapsed = elapsed_label(elapsed)
        );
    }
    if compaction.condensed_turns == 0 {
        "This chat already fit the model window, so no earlier message was dropped.".into()
    } else {
        format!(
            "Condensed {} earlier messages into a short digest; their full text is no longer sent.",
            compaction.condensed_turns
        )
    }
}

/// What the model call behind a summary cost, for the row that reports it.
pub(super) struct CompactionSummary<'a> {
    /// The model that wrote the checkpoint, or its provider when unnamed.
    pub(super) label: &'a str,
    pub(super) elapsed_ms: u64,
    /// Measured input tokens, when the provider reported them.
    pub(super) input_tokens: Option<u64>,
}

fn elapsed_label(elapsed_ms: u64) -> String {
    if elapsed_ms < 1_000 {
        format!("{elapsed_ms}ms")
    } else {
        format!("{:.1}s", elapsed_ms as f64 / 1_000.0)
    }
}

/// Set how full a model's window may get before a tool loop compacts itself.
///
/// Its own command for the same reason budgets have one: the guard block is
/// preserved natively on a renderer save, so a setting stored inside it needs a
/// door through the native writer. Returns the stored share, which is what the
/// UI shows back -- clamped to the range the setting means.
#[tauri::command]
pub async fn set_auto_compact_percent(percent: u32) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = GyroPaths::for_current_user().map_err(to_string)?;
        GyroConfig::update(&paths, |persisted| {
            gyro_core::set_auto_compact_percent(&mut persisted.usage_guard, percent);
            Ok(())
        })
        .map_err(to_string)?;
        Ok(percent.min(100))
    })
    .await
    .map_err(|error| format!("auto-compaction worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation_history::LocalCompaction;

    #[test]
    fn a_summarized_row_names_the_model_the_time_and_the_tokens() {
        let detail = manual_compaction_detail(
            &LocalCompaction::summarized("checkpoint".into()),
            Some(&CompactionSummary {
                label: "Grok 4.7",
                elapsed_ms: 12_400,
                input_tokens: Some(9_300),
            }),
        );
        assert_eq!(
            detail,
            "Summarized the earlier conversation with Grok 4.7 in 12.4s, 9300 input tokens; those turns are no longer sent in full."
        );
    }

    #[test]
    fn a_local_rewrite_is_never_worded_as_a_summary() {
        let kept = LocalCompaction {
            text: "history".into(),
            condensed_turns: 0,
            summarized: false,
        };
        assert!(!manual_compaction_detail(&kept, None)
            .to_lowercase()
            .contains("summar"));
        let condensed = LocalCompaction {
            text: "digest".into(),
            condensed_turns: 7,
            summarized: false,
        };
        assert_eq!(
            manual_compaction_detail(&condensed, None),
            "Condensed 7 earlier messages into a short digest; their full text is no longer sent."
        );
    }
}
