//! What a candidate workspace root is on disk.
//!
//! The desktop UI owns the policy (duplicates, nesting, the 20-root cap) in
//! `packages/ui/src/workspace-roots.ts`. This module only answers the
//! questions the UI cannot: does the path exist, is it a directory Gyro can
//! read, and which canonical path identifies it. `/tmp` and `/private/tmp`
//! are one root, and only the filesystem can say so.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

/// Longest path accepted before touching the filesystem.
pub const MAX_WORKSPACE_ROOT_PATH_LENGTH: usize = 4096;
/// Most paths one inspection request may carry. The UI caps a workspace at
/// 20 roots; a workspace file import can carry a few more before policy runs.
pub const MAX_WORKSPACE_ROOT_INSPECTIONS: usize = 64;

/// Shared with `WorkspaceRootStatus` in `packages/ui/src/workspace-roots.ts`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceRootStatus {
    Ok,
    InvalidPath,
    Missing,
    NotDirectory,
    Unreadable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRootInspection {
    /// The path exactly as requested, so the caller can match results back.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_path: Option<String>,
    pub status: WorkspaceRootStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// What a filesystem probe found, separated from the probe so the mapping is
/// testable without building unreadable or vanished directories.
#[derive(Debug)]
pub enum WorkspaceRootProbe {
    Directory {
        canonical: PathBuf,
        readable: io::Result<()>,
    },
    Other {
        canonical: PathBuf,
    },
    Failed(io::Error),
}

/// Map a probe result onto the shared status contract.
pub fn classify_workspace_root(path: &str, probe: WorkspaceRootProbe) -> WorkspaceRootInspection {
    let inspection =
        |status, canonical: Option<&Path>, detail: Option<String>| WorkspaceRootInspection {
            path: path.to_string(),
            canonical_path: canonical.map(|canonical| canonical.to_string_lossy().into_owned()),
            status,
            detail,
        };
    match probe {
        WorkspaceRootProbe::Directory {
            canonical,
            readable: Ok(()),
        } => inspection(WorkspaceRootStatus::Ok, Some(&canonical), None),
        WorkspaceRootProbe::Directory {
            canonical,
            readable: Err(error),
        } => inspection(
            WorkspaceRootStatus::Unreadable,
            Some(&canonical),
            Some(error.to_string()),
        ),
        WorkspaceRootProbe::Other { canonical } => {
            inspection(WorkspaceRootStatus::NotDirectory, Some(&canonical), None)
        }
        WorkspaceRootProbe::Failed(error) => {
            let status = match error.kind() {
                io::ErrorKind::NotFound => WorkspaceRootStatus::Missing,
                io::ErrorKind::PermissionDenied => WorkspaceRootStatus::Unreadable,
                // ENOTDIR: a file sits where a parent directory should be.
                // `ErrorKind::NotADirectory` needs Rust 1.83; the MSRV is 1.78.
                _ if cfg!(unix) && error.raw_os_error() == Some(libc::ENOTDIR) => {
                    WorkspaceRootStatus::Missing
                }
                _ => WorkspaceRootStatus::Unreadable,
            };
            inspection(status, None, Some(error.to_string()))
        }
    }
}

/// Reject strings that can never name a workspace root, before any I/O.
fn invalid_workspace_root_path(path: &str) -> Option<&'static str> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Some("The folder path is empty.");
    }
    if trimmed.len() > MAX_WORKSPACE_ROOT_PATH_LENGTH {
        return Some("The folder path is too long.");
    }
    if trimmed.contains('\0') {
        return Some("The folder path contains a null byte.");
    }
    if !Path::new(trimmed).is_absolute() {
        return Some("The folder path must be absolute.");
    }
    None
}

pub fn inspect_workspace_root(path: &str) -> WorkspaceRootInspection {
    if let Some(reason) = invalid_workspace_root_path(path) {
        return WorkspaceRootInspection {
            path: path.to_string(),
            canonical_path: None,
            status: WorkspaceRootStatus::InvalidPath,
            detail: Some(reason.into()),
        };
    }
    let probe = match Path::new(path.trim()).canonicalize() {
        Ok(canonical) if canonical.is_dir() => {
            let readable = std::fs::read_dir(&canonical).map(|_| ());
            WorkspaceRootProbe::Directory {
                canonical,
                readable,
            }
        }
        Ok(canonical) => WorkspaceRootProbe::Other { canonical },
        Err(error) => WorkspaceRootProbe::Failed(error),
    };
    classify_workspace_root(path, probe)
}

/// Inspect each path in order. Requests longer than
/// [`MAX_WORKSPACE_ROOT_INSPECTIONS`] are truncated by the caller's contract,
/// never silently: the extra paths come back as `InvalidPath`.
pub fn inspect_workspace_roots(paths: &[String]) -> Vec<WorkspaceRootInspection> {
    paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            if index < MAX_WORKSPACE_ROOT_INSPECTIONS {
                inspect_workspace_root(path)
            } else {
                WorkspaceRootInspection {
                    path: path.clone(),
                    canonical_path: None,
                    status: WorkspaceRootStatus::InvalidPath,
                    detail: Some("Too many folders in one request.".into()),
                }
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directories_files_and_missing_paths_get_distinct_statuses() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("folder");
        let file = root.path().join("file.txt");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(&file, "x").unwrap();
        let missing = root.path().join("gone");
        let under_file = file.join("child");

        let results = inspect_workspace_roots(&[
            folder.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
            under_file.to_string_lossy().into_owned(),
            "relative/path".into(),
            "   ".into(),
        ]);
        let statuses: Vec<_> = results.iter().map(|result| result.status).collect();
        assert_eq!(
            statuses,
            vec![
                WorkspaceRootStatus::Ok,
                WorkspaceRootStatus::NotDirectory,
                WorkspaceRootStatus::Missing,
                WorkspaceRootStatus::Missing,
                WorkspaceRootStatus::InvalidPath,
                WorkspaceRootStatus::InvalidPath,
            ]
        );
        assert_eq!(
            results[0].canonical_path.as_deref(),
            Some(folder.canonicalize().unwrap().to_string_lossy().as_ref())
        );
        assert_eq!(results[2].path, missing.to_string_lossy());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_roots_share_the_target_identity() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        let link = root.path().join("link");
        std::fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let results = inspect_workspace_roots(&[
            target.to_string_lossy().into_owned(),
            format!("{}/", link.to_string_lossy()),
        ]);
        assert_eq!(results[0].status, WorkspaceRootStatus::Ok);
        assert_eq!(results[1].status, WorkspaceRootStatus::Ok);
        assert_eq!(results[0].canonical_path, results[1].canonical_path);
    }

    #[test]
    fn probe_errors_map_onto_the_shared_contract() {
        let denied = classify_workspace_root(
            "/locked",
            WorkspaceRootProbe::Failed(io::Error::from(io::ErrorKind::PermissionDenied)),
        );
        assert_eq!(denied.status, WorkspaceRootStatus::Unreadable);
        let unlistable = classify_workspace_root(
            "/locked",
            WorkspaceRootProbe::Directory {
                canonical: PathBuf::from("/locked"),
                readable: Err(io::Error::from(io::ErrorKind::PermissionDenied)),
            },
        );
        assert_eq!(unlistable.status, WorkspaceRootStatus::Unreadable);
        assert_eq!(unlistable.canonical_path.as_deref(), Some("/locked"));
    }

    #[test]
    fn oversized_requests_report_the_overflow() {
        let paths = vec!["/".to_string(); MAX_WORKSPACE_ROOT_INSPECTIONS + 2];
        let results = inspect_workspace_roots(&paths);
        assert_eq!(results.len(), paths.len());
        assert!(results[MAX_WORKSPACE_ROOT_INSPECTIONS..]
            .iter()
            .all(|result| result.status == WorkspaceRootStatus::InvalidPath));
    }

    #[test]
    fn statuses_serialize_in_kebab_case() {
        let json = serde_json::to_string(&WorkspaceRootStatus::NotDirectory).unwrap();
        assert_eq!(json, "\"not-directory\"");
    }
}
