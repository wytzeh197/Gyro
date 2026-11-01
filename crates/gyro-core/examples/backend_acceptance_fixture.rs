//! Local, clearly labelled history for native acceptance. Never calls a provider.
use anyhow::{ensure, Context, Result};
use gyro_core::{CreateSessionContext, GyroPaths, SessionEventKind, SessionOrigin, SessionStore};
use serde_json::json;
use std::{fs, path::PathBuf};
use uuid::Uuid;

fn main() -> Result<()> {
    let root = PathBuf::from(std::env::args().nth(1).context(
        "usage: cargo run -p gyro-core --example backend_acceptance_fixture -- /private/tmp/gyro-...",
    )?);
    ensure!(root.is_absolute(), "fixture root must be absolute");
    let parent = root
        .parent()
        .context("fixture root needs a parent")?
        .canonicalize()?;
    let temporary = std::env::temp_dir().canonicalize()?;
    ensure!(
        parent.starts_with("/private/tmp") || parent.starts_with(temporary),
        "fixture must be in temporary storage"
    );
    ensure!(!root.exists(), "existing fixture must be preserved");
    fs::create_dir(&root)?;
    let workspace = root.join("history-project");
    fs::create_dir(&workspace)?;
    fs::write(workspace.join("README.md"), "# Generated backend acceptance fixture\n\nNo model request, tool, approval or imported account was executed.\n")?;
    let paths = GyroPaths::from_base_dir(root.join("store"));
    let store = SessionStore::open(paths.clone())?;
    let mut manifest = Vec::new();
    for (title, turns) in [
        ("Fixture: long history (1200 turns)", 1200),
        ("Fixture: alternate history (300 turns)", 300),
        ("Fixture: small history (10 turns)", 10),
        ("Fixture: empty history", 0),
    ] {
        let session = store.create_session_with_context(
            "",
            SessionOrigin::Desktop,
            title,
            CreateSessionContext {
                provider_id: Some("openai".into()),
                provider_label: Some("Codex".into()),
                model_id: Some("gpt-5.6-sol".into()),
                model_label: Some("GPT-5.6 Sol".into()),
                ..Default::default()
            },
        )?;
        for index in 1..=turns {
            let turn = Uuid::new_v4();
            store.append_user_turn_message_with_turn_id(
                session.id,
                format!("Generated fixture prompt {index:04}. This is historical acceptance data, not a request to execute."),
                json!({"fixture": true}),
                turn,
            )?;
            store.append_event_with_turn_id(
                session.id,
                SessionEventKind::AssistantMessage,
                format!("Generated fixture reply {index:04}. No model or tool ran.\n\nThis paragraph makes pagination and preserved scroll position visible. The durable marker for this turn is HISTORY_{index:04}."),
                json!({"kind": "provider-response", "fixture": true, "providerId": "openai", "modelId": "gpt-5.6-sol", "providerAttempts": 0}),
                Some(turn),
            )?;
            store.append_event_with_turn_id(
                session.id,
                SessionEventKind::SystemEvent,
                "Generated fixture turn completed",
                json!({"kind": "provider-status", "status": "done", "fixture": true}),
                Some(turn),
            )?;
        }
        // read_events intentionally returns a 1,000-event tail. This small,
        // generated fixture explicitly requests its known durable event count.
        let events = store.read_recent_events(session.id, 1 + turns * 3)?;
        ensure!(events.len() == 1 + turns * 3, "fixture lost durable events");
        let recent = store.read_recent_events(session.id, 400)?;
        let older = if turns * 3 > 400 {
            let cursor = recent
                .iter()
                .find(|event| event.kind != SessionEventKind::SessionCreated)
                .context("missing recent cursor")?;
            let page = store.read_events_before(session.id, cursor.id, 400)?;
            ensure!(!page.events.is_empty(), "older history page is missing");
            page.events.len()
        } else {
            0
        };
        manifest.push(json!({"id": session.id, "title": title, "turns": turns, "events": events.len(), "recentEvents": recent.len(), "olderPageEvents": older, "eventsPath": session.events_path, "workspacePath": session.workspace_path}));
    }
    let value = json!({"fixture": true, "providerRequests": 0, "toolsExecuted": 0, "workspace": workspace, "store": paths.base_dir, "sessions": manifest});
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec_pretty(&value)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}
