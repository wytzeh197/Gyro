use super::{dispatch::value, err, Runtime};
use crate::{
    git::{commands as git, types::*},
    terminal::{
        panes,
        types::{TerminalPaneRequest, TerminalProcessManager},
    },
    workspace::{files, paths, types::*},
};
use gyro_remote::{
    protocol::{GitAction, PathAction, TerminalAction},
    Operation,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Component, Path};
use tauri::Manager;

pub(super) fn relative(path: &str) -> Result<(), String> {
    if path.is_empty()
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Use a relative project path without parent traversal".into());
    }
    if Path::new(path)
        .components()
        .any(|c| c.as_os_str() == ".git")
    {
        return Err("Git internals are not editable through remote files".into());
    }
    Ok(())
}
pub(super) fn execute(
    runtime: &Runtime,
    peer: &str,
    operation: &Operation,
) -> Result<Value, String> {
    let session_id = operation
        .session_id()
        .ok_or("Unsupported remote operation")?;
    let session = runtime.session(session_id)?;
    let root = session.workspace_path.to_string_lossy().to_string();
    match operation {
        Operation::Files { .. } => value(crate::workspace::tree::list_workspace_tree_blocking(
            root,
            Some(8),
        )?),
        Operation::Search { query, .. } => {
            if query.len() > 1000 {
                return Err("Search query is too long".into());
            }
            value(
                paths::search_workspace_impl(&WorkspaceSearchRequest {
                    workspace_path: root,
                    query: query.clone(),
                    globs: None,
                    max_results: Some(200),
                    regex: Some(false),
                    case_sensitive: Some(false),
                    whole_word: Some(false),
                })
                .map_err(err)?,
            )
        }
        Operation::ReadFile { path, .. } => {
            relative(path)?;
            value(
                files::read_workspace_file_with_limit(
                    &root,
                    path,
                    crate::app::limits::MAX_WORKSPACE_FILE_EDIT_BYTES,
                )
                .map_err(err)?,
            )
        }
        Operation::WriteFile {
            path,
            content,
            expected_hash,
            ..
        } => {
            relative(path)?;
            if expected_hash.is_none() {
                return Err("Read the current file before saving it".into());
            }
            value(
                files::write_workspace_file_impl(&WorkspaceFileWriteRequest {
                    workspace_path: root,
                    path: path.clone(),
                    content: content.clone(),
                    expected_hash: expected_hash.clone(),
                })
                .map_err(err)?,
            )
        }
        Operation::Path {
            action,
            path,
            name,
            expected_hash,
            ..
        } => {
            relative(path)?;
            match action {
                PathAction::CreateFile | PathAction::CreateDirectory => value(
                    paths::create_workspace_path_impl(&WorkspacePathCreateRequest {
                        workspace_path: root,
                        path: path.clone(),
                        kind: if matches!(action, PathAction::CreateFile) {
                            "file"
                        } else {
                            "directory"
                        }
                        .into(),
                    })
                    .map_err(err)?,
                ),
                PathAction::Rename => {
                    let target = name.as_deref().ok_or("Choose a destination name")?;
                    relative(target)?;
                    let stat = files::stat_workspace_file_impl(&root, path).map_err(err)?;
                    if stat.kind == "file" && stat.content_hash != *expected_hash {
                        return Err(
                            "File changed since it was read. Refresh before renaming.".into()
                        );
                    }
                    value(
                        paths::rename_workspace_path_impl(&WorkspacePathRenameRequest {
                            workspace_path: root,
                            from_path: path.clone(),
                            to_path: target.into(),
                        })
                        .map_err(err)?,
                    )
                }
                PathAction::Delete => {
                    let stat = files::stat_workspace_file_impl(&root, path).map_err(err)?;
                    if stat.kind == "file"
                        && (expected_hash.is_none() || stat.content_hash != *expected_hash)
                    {
                        return Err(
                            "File changed since it was read. Refresh before deleting.".into()
                        );
                    }
                    paths::delete_workspace_path_impl(&WorkspacePathDeleteRequest {
                        workspace_path: root,
                        path: path.clone(),
                        expected_hash: expected_hash.clone(),
                    })
                    .map_err(err)?;
                    Ok(Value::Null)
                }
            }
        }
        Operation::Git {
            action,
            path,
            message,
            expected_revision,
            ..
        } => git_operation(
            &root,
            action,
            path.as_deref(),
            message.as_deref(),
            expected_revision.as_deref(),
        ),
        Operation::Terminal {
            action,
            pane_id,
            input,
            cols,
            rows,
            revision,
            ..
        } => {
            let manager = runtime.app.state::<TerminalProcessManager>();
            if *action == TerminalAction::List {
                let bindings = runtime.terminals.lock().map_err(err)?;
                return value(
                    bindings
                        .iter()
                        .filter(|(_, t)| t.session == session_id && t.peer == peer)
                        .filter_map(|(id, _)| manager.observe(id, false).ok())
                        .collect::<Vec<_>>(),
                );
            }
            if *action == TerminalAction::Create {
                if runtime
                    .terminals
                    .lock()
                    .map_err(err)?
                    .values()
                    .filter(|t| t.peer == peer)
                    .count()
                    >= super::TERMINALS_PER_DEVICE
                {
                    return Err(format!(
                        "Close a remote terminal first; {} can be open per device",
                        super::TERMINALS_PER_DEVICE
                    ));
                }
                let id = format!("remote-{}", uuid::Uuid::new_v4());
                let snapshot = panes::create_terminal_pane_blocking(
                    &runtime.app,
                    &manager,
                    TerminalPaneRequest {
                        pane_id: id.clone(),
                        title: "Remote terminal".into(),
                        command: "/bin/zsh".into(),
                        args: {
                            #[cfg(debug_assertions)]
                            if runtime.fixture {
                                vec!["-f".into()]
                            } else {
                                vec!["-l".into()]
                            }
                            #[cfg(not(debug_assertions))]
                            vec!["-l".into()]
                        },
                        workspace_path: Some(root.clone()),
                        working_directory: Some(root),
                        cols: Some(cols.unwrap_or(100).clamp(20, 500)),
                        rows: Some(rows.unwrap_or(30).clamp(5, 200)),
                        ..Default::default()
                    },
                )?;
                runtime
                    .terminals
                    .lock()
                    .map_err(err)?
                    .insert(
                        id,
                        super::RemoteTerminal {
                            session: session_id.into(),
                            peer: peer.into(),
                        },
                    );
                // Unshare/revoke can race shell creation after initial admission.
                // Cleanup handles panes registered before revocation; this check
                // handles panes registered after that cleanup already ran.
                let authorization = (|| {
                    if !runtime.store.settings().map_err(err)?.enabled
                        || !runtime.store.trusts(peer, "client")
                    {
                        return Err("Remote access was disabled or this device was revoked".into());
                    }
                    runtime.session(session_id).map(|_| ())
                })();
                if let Err(error) = authorization {
                    runtime.close_terminals(|t| t.session == session_id && t.peer == peer);
                    return Err(error);
                }
                return value(snapshot);
            }
            let pane = pane_id.as_deref().ok_or("Select a remote terminal")?;
            if runtime
                .terminals
                .lock()
                .map_err(err)?
                .get(pane)
                .is_none_or(|t| t.session != session_id || t.peer != peer)
            {
                return Err("This terminal belongs to another session or device".into());
            }
            match action {
                TerminalAction::Read => value(manager.read(pane, *revision).map_err(err)?),
                TerminalAction::Input => {
                    let input = input.as_deref().ok_or("Terminal input is missing")?;
                    if input.len() > 64 * 1024 {
                        return Err("Terminal input exceeds limit".into());
                    }
                    let mut snapshot = manager.write(pane, input).map_err(err)?;
                    snapshot.output = None;
                    value(snapshot)
                }
                TerminalAction::Resize => {
                    let mut snapshot = manager
                        .resize(
                            pane,
                            cols.unwrap_or(100).clamp(20, 500),
                            rows.unwrap_or(30).clamp(5, 200),
                        )
                        .map_err(err)?;
                    snapshot.output = None;
                    value(snapshot)
                }
                TerminalAction::Close => {
                    manager.close(pane).map_err(err)?;
                    runtime.terminals.lock().map_err(err)?.remove(pane);
                    Ok(Value::Null)
                }
                _ => Err("Unsupported terminal action".into()),
            }
        }
        _ => Err("This feature is unavailable in remote workspaces".into()),
    }
}
fn git_snapshot(root: &str) -> Result<(SourceControlStatus, String), String> {
    let status = crate::git::status_cache::git_status_impl(root).map_err(err)?;
    let mut hash = Sha256::new();
    let head = serde_json::to_value(status.history.first()).map_err(err)?;
    hash.update(serde_json::to_vec(&json!({"branch":status.branch,"operation":status.operation,"files":status.files,"head":head.get("hash")})).map_err(err)?);
    for file in &status.files {
        let target = files::assert_workspace_entry(Path::new(root), &file.path).map_err(err)?;
        if let Ok(metadata) = std::fs::symlink_metadata(&target) {
            hash.update(metadata.len().to_be_bytes());
            hash.update(format!("{:?}", metadata.modified().ok()));
            if metadata.is_file() && !metadata.is_symlink() && metadata.len() <= 4 * 1024 * 1024 {
                hash.update(std::fs::read(target).map_err(err)?);
            }
        }
    }
    Ok((status, format!("{:x}", hash.finalize())))
}
fn git_operation(
    root: &str,
    action: &GitAction,
    path: Option<&str>,
    message: Option<&str>,
    expected: Option<&str>,
) -> Result<Value, String> {
    if *action == GitAction::Status {
        let (status, revision) = git_snapshot(root)?;
        return Ok(json!({"status":status,"revision":revision}));
    }
    if *action == GitAction::Branches {
        return value(crate::git::branches::git_branch_catalog_impl(root).map_err(err)?);
    }
    if let Some(path) = path {
        relative(path)?
    }
    if *action == GitAction::Diff {
        return value(git::git_diff_blocking(GitPathRequest {
            workspace_path: root.into(),
            path: path.map(str::to_string),
            staged: Some(message == Some("staged")),
        })?);
    }
    // The remote admission gate serializes repository mutations; a fresh revision
    // also fences stale views, including file changes made by the running model.
    let (_, revision) = git_snapshot(root)?;
    if expected != Some(revision.as_str()) {
        return Err("Repository changed. Refresh Source Control before acting.".into());
    }
    let path = path.unwrap_or("");
    match action {
        GitAction::Stage => value(git::git_stage_blocking(GitStageRequest {
            workspace_path: root.into(),
            path: path.into(),
        })?),
        GitAction::Unstage => value(git::git_unstage_blocking(GitStageRequest {
            workspace_path: root.into(),
            path: path.into(),
        })?),
        GitAction::Discard => {
            if path.is_empty() {
                return Err("Choose one file to discard".into());
            }
            value(git::git_discard_blocking(GitStageRequest {
                workspace_path: root.into(),
                path: path.into(),
            })?)
        }
        GitAction::Commit => value(git::git_commit_blocking(GitCommitRequest {
            workspace_path: root.into(),
            message: message.ok_or("Enter a commit message")?.into(),
        })?),
        GitAction::CreateBranch => value(
            git::git_create_branch_impl(&GitCreateBranchRequest {
                workspace_path: root.into(),
                branch: message.ok_or("Enter a branch name")?.into(),
                start_point: None,
            })
            .map_err(err)?,
        ),
        GitAction::Checkout => value(
            git::git_checkout_branch_impl(&GitCheckoutBranchRequest {
                workspace_path: root.into(),
                branch: message.ok_or("Select a branch")?.into(),
            })
            .map_err(err)?,
        ),
        GitAction::Fetch | GitAction::Pull | GitAction::Push => {
            let request = GitSyncRequest {
                workspace_path: root.into(),
                set_upstream: false,
                remote: None,
            };
            match action {
                GitAction::Fetch => value(git::git_fetch_blocking(request)?),
                GitAction::Pull => value(git::git_pull_blocking(request)?),
                _ => value(git::git_push_blocking(request)?),
            }
        }
        _ => Err("Unsupported Git action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_cannot_escape_or_edit_git_internals() {
        for path in [
            "/etc/passwd",
            "../secret",
            "a/../../secret",
            ".git/config",
            "a/.git/index",
            "",
        ] {
            assert!(relative(path).is_err(), "{path}")
        }
        assert!(relative("src/main.rs").is_ok());
    }
}
