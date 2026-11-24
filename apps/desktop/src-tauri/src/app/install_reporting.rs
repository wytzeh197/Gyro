use gyro_core::GyroPaths;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Error, ErrorKind, Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use uuid::Uuid;

const ENDPOINT: &str = "https://usegyro.io/api/reported-installs";
const STATE_FILE: &str = "install-report.json";
const INTERNAL_MARKER: &str = "internal-install";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Decision {
    Eligible,
    Skipped,
    Pending(Uuid),
    Sent,
}

fn enabled_build() -> bool {
    cfg!(all(target_os = "macos", not(debug_assertions)))
        && option_env!("GYRO_PUBLIC_INSTALL_REPORTING") == Some("1")
}

fn internal(paths: &GyroPaths) -> bool {
    std::env::var_os("GYRO_INTERNAL_INSTALL").is_some()
        || !matches!(
            paths.base_dir.join(INTERNAL_MARKER).symlink_metadata(),
            Err(error) if error.kind() == ErrorKind::NotFound
        )
}

/// Reserve eligibility before desktop startup creates its local data. An existing
/// data directory marks an older installation, including manual DMG upgrades.
pub(crate) fn prepare() {
    if !enabled_build() {
        return;
    }
    let Ok(paths) = GyroPaths::for_current_user() else {
        return;
    };
    if !internal(&paths) {
        let _ = initialize(&paths);
    }
}

fn initialize(paths: &GyroPaths) -> std::io::Result<()> {
    if let Some(parent) = paths.base_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(&paths.base_dir) {
        Ok(()) => save(&paths.base_dir, Decision::Eligible),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

fn load(dir: &Path) -> std::io::Result<Decision> {
    let path = dir.join(STATE_FILE);
    if !dir.symlink_metadata()?.is_dir() || !path.symlink_metadata()?.is_file() {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "invalid install report path",
        ));
    }
    let mut raw = Vec::new();
    File::open(path)?.take(256).read_to_end(&mut raw)?;
    Ok(serde_json::from_slice(&raw)?)
}

fn save(dir: &Path, decision: Decision) -> std::io::Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(dir)?;
    serde_json::to_writer(&mut temporary, &decision)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary.persist(dir.join(STATE_FILE))?;
    Ok(())
}

pub(crate) fn after_launch(window: tauri::WebviewWindow) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if !enabled_build() || STARTED.swap(true, Ordering::Relaxed) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(Some((paths, _lock, id))) =
            tauri::async_runtime::spawn_blocking(move || prepare_report(window)).await
        else {
            return;
        };
        for delay in [0, 30, 270] {
            if delay > 0 {
                tokio::time::sleep(Duration::from_secs(delay)).await;
            }
            if internal(&paths) {
                return;
            }
            if let Ok(true) =
                tauri::async_runtime::spawn_blocking(move || submit(ENDPOINT, id)).await
            {
                let _ = save(&paths.base_dir, Decision::Sent);
                return;
            }
        }
    });
}

fn prepare_report(window: tauri::WebviewWindow) -> Option<(GyroPaths, File, Uuid)> {
    let paths = GyroPaths::for_current_user().ok()?;
    if internal(&paths)
        || matches!(
            load(&paths.base_dir).ok()?,
            Decision::Skipped | Decision::Sent
        )
    {
        return None;
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.base_dir.join("install-report.lock"))
        .ok()?;
    lock.try_lock().ok()?;
    let id = match load(&paths.base_dir).ok()? {
        Decision::Pending(id) => id,
        Decision::Eligible => {
            // Record the default before prompting so interruption cannot imply consent.
            save(&paths.base_dir, Decision::Skipped).ok()?;
            let allowed = window
                .dialog()
                .message("Share one report that this new installation opened successfully? Gyro sends a random installation ID to usegyro.io. The report contains no account, hardware, or project details.")
                .title("Help count new Gyro installations")
                .parent(&window)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Share once".into(),
                    "No thanks".into(),
                ))
                .blocking_show();
            if !allowed {
                return None;
            }
            let id = Uuid::new_v4();
            save(&paths.base_dir, Decision::Pending(id)).ok()?;
            id
        }
        Decision::Skipped | Decision::Sent => return None,
    };
    Some((paths, lock, id))
}

fn submit(endpoint: &str, id: Uuid) -> bool {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(8))
        .redirects(0)
        .build()
        .post(endpoint)
        .send_json(serde_json::json!({ "installationId": id }))
        .is_ok_and(|response| response.status() == 204)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_new_data_directories_are_eligible() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = GyroPaths::from_base_dir(temp.path().join("legacy"));
        legacy.ensure().unwrap();
        initialize(&legacy).unwrap();
        assert_eq!(
            load(&legacy.base_dir).unwrap_err().kind(),
            ErrorKind::NotFound
        );

        let new = GyroPaths::from_base_dir(temp.path().join("new"));
        initialize(&new).unwrap();
        assert_eq!(load(&new.base_dir).unwrap(), Decision::Eligible);
        let pending = Decision::Pending(Uuid::new_v4());
        save(&new.base_dir, pending).unwrap();
        initialize(&new).unwrap();
        assert_eq!(load(&new.base_dir).unwrap(), pending);
        save(&new.base_dir, Decision::Sent).unwrap();
        assert_eq!(load(&new.base_dir).unwrap(), Decision::Sent);
    }

    #[test]
    fn maintainer_marker_excludes_an_installation() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("qa"));
        paths.ensure().unwrap();
        File::create(paths.base_dir.join(INTERNAL_MARKER)).unwrap();
        assert!(internal(&paths));
    }

    #[test]
    fn report_sends_only_the_installation_id() {
        use std::io::{BufRead, BufReader};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/api/reported-installs",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let body = {
                let mut reader = BufReader::new(&mut socket);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                assert_eq!(line, "POST /api/reported-installs HTTP/1.1\r\n");
                let mut length = None;
                loop {
                    line.clear();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = Some(value.trim().parse::<usize>().unwrap());
                    }
                }
                let mut body = vec![0; length.unwrap()];
                reader.read_exact(&mut body).unwrap();
                serde_json::from_slice::<serde_json::Value>(&body).unwrap()
            };
            socket
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .unwrap();
            body
        });
        let id = Uuid::new_v4();
        assert!(submit(&endpoint, id));
        assert_eq!(
            server.join().unwrap(),
            serde_json::json!({ "installationId": id })
        );
    }
}
