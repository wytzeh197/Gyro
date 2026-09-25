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
