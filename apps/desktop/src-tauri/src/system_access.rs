use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Privacy scopes macOS gates behind TCC that Gyro touches while working in a
/// workspace. Folder scopes prompt the first time the app reads them; Full Disk
/// Access can never be prompted for and has to be granted in System Settings.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemAccessScopeId {
    Desktop,
    Documents,
    Downloads,
    RemovableVolumes,
    FullDisk,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemAccessStatus {
    /// Gyro read the location successfully.
    Granted,
    /// macOS refused the read, so the user has denied or not yet allowed it.
    Denied,
    /// The location does not exist on this machine.
    Unavailable,
    /// Not a macOS build.
    Unsupported,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAccessScope {
    pub id: SystemAccessScopeId,
    pub label: &'static str,
    pub reason: &'static str,
    pub status: SystemAccessStatus,
    pub path: Option<String>,
    /// Whether reading the location makes macOS show its own permission sheet.
    pub can_prompt: bool,
    pub settings_url: &'static str,
}

const FILES_AND_FOLDERS_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_FilesAndFolders";
const FULL_DISK_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles";

impl SystemAccessScopeId {
    fn label(self) -> &'static str {
        match self {
            Self::Desktop => "Desktop folder",
            Self::Documents => "Documents folder",
            Self::Downloads => "Downloads folder",
            Self::RemovableVolumes => "External volumes",
            Self::FullDisk => "Full Disk Access",
        }
    }

    fn reason(self) -> &'static str {
        match self {
            Self::Desktop => "Open projects and attach files kept on the Desktop.",
            Self::Documents => "Open projects stored under Documents.",
            Self::Downloads => "Open cloned repositories and downloaded archives.",
            Self::RemovableVolumes => "Work on repositories kept on external or network drives.",
            Self::FullDisk => {
                "Optional. Only needed for workspaces outside your home folder, such as /Library."
            }
        }
    }

    fn can_prompt(self) -> bool {
        !matches!(self, Self::FullDisk)
    }

    pub fn settings_url(self) -> &'static str {
        match self {
            Self::FullDisk => FULL_DISK_SETTINGS_URL,
            _ => FILES_AND_FOLDERS_SETTINGS_URL,
        }
    }
}

pub fn scope_order() -> [SystemAccessScopeId; 5] {
    [
        SystemAccessScopeId::Desktop,
        SystemAccessScopeId::Documents,
        SystemAccessScopeId::Downloads,
        SystemAccessScopeId::RemovableVolumes,
        SystemAccessScopeId::FullDisk,
    ]
}

#[cfg(target_os = "macos")]
fn scope_path(scope: SystemAccessScopeId) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    match scope {
        SystemAccessScopeId::Desktop => home.map(|home| home.join("Desktop")),
        SystemAccessScopeId::Documents => home.map(|home| home.join("Documents")),
        SystemAccessScopeId::Downloads => home.map(|home| home.join("Downloads")),
        SystemAccessScopeId::RemovableVolumes => Some(PathBuf::from("/Volumes")),
        SystemAccessScopeId::FullDisk => {
            home.map(|home| home.join("Library/Application Support/com.apple.TCC/TCC.db"))
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn scope_path(_scope: SystemAccessScopeId) -> Option<PathBuf> {
    None
}

/// Touches the location so macOS resolves the TCC decision. When the decision is
/// still undetermined this is what makes the system permission sheet appear, so
/// it always runs off the main thread.
#[cfg(target_os = "macos")]
fn probe_scope(scope: SystemAccessScopeId) -> SystemAccessStatus {
    let Some(path) = scope_path(scope) else {
        return SystemAccessStatus::Unavailable;
    };
    let outcome = if matches!(scope, SystemAccessScopeId::FullDisk) {
        std::fs::File::open(&path).map(|_| ())
    } else {
        std::fs::read_dir(&path).map(|mut entries| {
            // Reading one entry is enough for macOS to evaluate the grant.
            let _ = entries.next();
        })
    };
    match outcome {
        Ok(()) => SystemAccessStatus::Granted,
        Err(error) => match error.kind() {
            std::io::ErrorKind::NotFound => SystemAccessStatus::Unavailable,
            _ => SystemAccessStatus::Denied,
        },
    }
}

#[cfg(not(target_os = "macos"))]
fn probe_scope(_scope: SystemAccessScopeId) -> SystemAccessStatus {
    SystemAccessStatus::Unsupported
}

fn describe_scope(scope: SystemAccessScopeId, status: SystemAccessStatus) -> SystemAccessScope {
    SystemAccessScope {
        id: scope,
        label: scope.label(),
        reason: scope.reason(),
        status,
        path: scope_path(scope).map(|path| path.to_string_lossy().to_string()),
        can_prompt: scope.can_prompt(),
        settings_url: scope.settings_url(),
    }
}

fn evaluate(scopes: Vec<SystemAccessScopeId>) -> Vec<SystemAccessScope> {
    scopes
        .into_iter()
        .map(|scope| describe_scope(scope, probe_scope(scope)))
        .collect()
}

/// Resolves every macOS privacy grant Gyro depends on. On the first launch the
/// folder scopes are still undetermined, so this is the call that asks the user.
#[tauri::command]
pub async fn check_system_access(
    scopes: Option<Vec<SystemAccessScopeId>>,
) -> Result<Vec<SystemAccessScope>, String> {
    let requested = scopes.unwrap_or_else(|| scope_order().to_vec());
    tauri::async_runtime::spawn_blocking(move || evaluate(requested))
        .await
        .map_err(|error| error.to_string())
}

/// Opens the System Settings pane that owns a scope, for grants macOS will not
/// re-prompt for once they have been denied.
#[tauri::command]
pub async fn open_system_access_settings(scope: SystemAccessScopeId) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(scope.settings_url())
            .status()
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = scope;
        Err("system access settings are only available on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_scope_is_described() {
        for scope in scope_order() {
            let described = describe_scope(scope, SystemAccessStatus::Denied);
            assert!(!described.label.is_empty());
            assert!(!described.reason.is_empty());
            assert!(described
                .settings_url
                .starts_with("x-apple.systempreferences:"));
        }
    }

    #[test]
    fn full_disk_access_cannot_be_prompted() {
        assert!(!SystemAccessScopeId::FullDisk.can_prompt());
        assert_eq!(
            SystemAccessScopeId::FullDisk.settings_url(),
            FULL_DISK_SETTINGS_URL
        );
        assert!(SystemAccessScopeId::Documents.can_prompt());
        assert_eq!(
            SystemAccessScopeId::Documents.settings_url(),
            FILES_AND_FOLDERS_SETTINGS_URL
        );
    }
}
