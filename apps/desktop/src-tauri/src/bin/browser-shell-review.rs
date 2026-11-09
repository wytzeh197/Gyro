//! Normal app startup with an immutable temporary-store boundary for UI review.
fn main() {
    let Some(data) = option_env!("GYRO_NATIVE_BROWSER_SHELL_DATA_DIR") else {
        eprintln!("Build the native shell review with an explicit temporary store.");
        std::process::exit(2);
    };
    let data = std::path::Path::new(data);
    let isolated = cfg!(debug_assertions)
        && data.starts_with("/private/tmp")
        && data
            .parent()
            .and_then(|p| p.file_name())
            .is_some_and(|name| name.to_string_lossy().starts_with("gyro-shell-"))
        && data.canonicalize().ok().as_deref() == Some(data)
        && std::fs::read_to_string(data.join(".native-shell-review"))
            .ok()
            .as_deref()
            == Some("isolated-native-shell-review\n");
    if !isolated {
        eprintln!("The native shell review refuses to use an unverified store.");
        std::process::exit(2);
    }
    // Launch Services and native automation can relaunch without the runner's
    // environment. Set this before any helper or normal application startup.
    for (key, _) in std::env::vars_os() {
        if key.to_str().is_some_and(|key| key.starts_with("GYRO_")) {
            std::env::remove_var(key);
        }
    }
    std::env::set_var("GYRO_TEST_DATA_DIR", data);
    if std::env::args().any(|argument| argument == "--seed-review-chats") {
        match seed_review_chats(data) {
            Ok(sessions) => println!("{sessions}"),
            Err(error) => {
                eprintln!("Could not seed native review chats: {error}");
                std::process::exit(2);
            }
        }
        return;
    }
    if let Some(code) = gyro_core::process_guard::run_crash_helper() {
        std::process::exit(code);
    }
    if let Some(code) = gyro_core::keychain::run_read_helper() {
        std::process::exit(code);
    }
    gyro_core::process_guard::enable_crash_cleanup();
    gyro_desktop_lib::run_entrypoint();
}

fn seed_review_chats(
    data: &std::path::Path,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    use gyro_core::{GyroPaths, SessionEventKind, SessionOrigin, SessionStore};
    use serde_json::json;
    let workspace = option_env!("GYRO_NATIVE_BROWSER_SHELL_WORKSPACE")
        .map(std::path::PathBuf::from)
        .unwrap_or(
            data.parent()
                .ok_or("review root is missing")?
                .join("workspace"),
        );
    if workspace.canonicalize()? != workspace
        || std::fs::read_to_string(workspace.join(".native-shell-review-workspace"))?
            != format!("{}\n", data.display())
    {
        return Err("review workspace must be its own marker-guarded directory".into());
    }
    let store = SessionStore::open(GyroPaths::from_base_dir(data.to_path_buf()))?;
    let manifest = data.join("native-shell-chats.json");
    if manifest.exists() {
        let sessions: Vec<gyro_core::Session> = serde_json::from_slice(&std::fs::read(&manifest)?)?;
        if sessions.len() != 2
            || sessions.iter().any(|session| {
                session.workspace_path != workspace
                    || store
                        .get_session(session.id)
                        .ok()
                        .flatten()
                        .is_none_or(|stored| stored.workspace_path != workspace)
            })
        {
            return Err("saved review chats do not belong to this review workspace".into());
        }
        return Ok(json!(sessions));
    }
    let mut sessions = Vec::new();
    for name in ["Alpha", "Beta"] {
        let session = store.create_session(
            &workspace,
            SessionOrigin::Desktop,
            format!("Browser review {name}"),
        )?;
        store.append_event(
            session.id,
            SessionEventKind::UserMessage,
            format!("Synthetic {name} conversation for native browser acceptance."),
            json!({"fixture":"native-browser-shell-review"}),
        )?;
        store.append_event(session.id, SessionEventKind::AssistantMessage,
            format!("Synthetic fixture {name}. No provider turn ran; use the browser controls for this review."),
            json!({"fixture":"native-browser-shell-review"}))?;
        sessions.push(session);
    }
    std::fs::write(&manifest, serde_json::to_vec_pretty(&sessions)?)?;
    Ok(json!(sessions))
}
