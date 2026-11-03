//! Seed disposable native acceptance data; never use the user's Gyro store.
use anyhow::{ensure, Context, Result};
use gyro_core::{GyroPaths, SessionOrigin, SessionStore};
use std::{fs, path::PathBuf};

fn main() -> Result<()> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .context("Provide a new disposable directory under /private/tmp")?,
    );
    ensure!(
        root.is_absolute()
            && root.starts_with("/private/tmp")
            && root
                .components()
                .all(|c| !matches!(c, std::path::Component::ParentDir)),
        "Use an absolute disposable /private/tmp directory"
    );
    ensure!(
        !root.exists(),
        "Directory already exists; choose a new disposable directory"
    );
    fs::create_dir(&root)?;
    let root = root.canonicalize()?;
    // The normal sidebar hides transient /tmp projects. Keep the disposable
    // project in ignored build output while its app data remains under /tmp.
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/local-check-fixtures")
        .join(uuid::Uuid::new_v4().to_string());
    let fixture = workspace.join("scripts/fixtures/gyro-check");
    fs::create_dir_all(&fixture)?;
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/fixtures/gyro-check");
    for file in ["todo.mjs", "server.mjs", "check.mjs", "index.html"] {
        fs::copy(source.join(file), fixture.join(file))?;
    }
    let data = root.join("data");
    let store = SessionStore::open(GyroPaths::from_base_dir(data.clone()))?;
    let session = store.create_session(
        &workspace,
        SessionOrigin::Desktop,
        "Check the synthetic to-do task",
    )?;
    store.append_user_turn_message(
        session.id,
        "Add a to-do item and reject an empty title.",
        serde_json::json!({"fixture": true}),
    )?;
    println!(
        "{}",
        serde_json::json!({ "workspace":workspace,"data":data,"sessionId":session.id })
    );
    Ok(())
}
