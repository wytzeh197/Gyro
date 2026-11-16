//! Serialize conflicting remote mutations without stalling unrelated projects.
use super::{err, Runtime};
use gyro_remote::{protocol::ApprovalKind, Operation};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard, Weak},
};
use tauri::Manager;

#[derive(Default)]
pub(super) struct MutationLocks {
    entries: Mutex<HashMap<PathBuf, Weak<RwLock<()>>>>,
}

pub(super) struct MutationLock {
    gate: Arc<RwLock<()>>,
    exclusive: bool,
}
pub(super) struct MutationGuard<'a> {
    _read: Option<RwLockReadGuard<'a, ()>>,
    _write: Option<RwLockWriteGuard<'a, ()>>,
}
impl MutationLock {
    pub(super) fn lock(&self) -> Result<MutationGuard<'_>, String> {
        Ok(if self.exclusive {
            MutationGuard {
                _read: None,
                _write: Some(self.gate.write().map_err(err)?),
            }
        } else {
            MutationGuard {
                _read: Some(self.gate.read().map_err(err)?),
                _write: None,
            }
        })
    }
}

fn resources(workspace: &Path) -> Result<Vec<PathBuf>, String> {
    let workspace = workspace.canonicalize().map_err(err)?;
    let mut resources = vec![workspace.clone()];
    // Common metadata/refs also serialize different linked worktrees.
    if let Some(root) = crate::git::status_cache::git_repo_root(&workspace) {
        let common = crate::git::status_cache::git_dirs(&root)
            .map(|(_, common)| common)
            .unwrap_or(root);
        resources.push(common.canonicalize().map_err(err)?);
    }
    Ok(resources)
}

impl MutationLocks {
    pub(super) fn for_paths(&self, paths: &[PathBuf]) -> Result<Vec<MutationLock>, String> {
        // A workspace is exclusive; ancestors are shared. Sibling projects proceed
        // together, but a parent workspace conflicts with every descendant, even
        // when there is no Git repository or the descendant is a nested repository.
        // Canonical sorted order is the same for every caller, preventing deadlocks.
        let mut keys = BTreeMap::new();
        for workspace in paths {
            for resource in resources(workspace)? {
                for ancestor in resource.ancestors().skip(1) {
                    keys.entry(ancestor.to_path_buf()).or_insert(false);
                }
                keys.insert(resource, true);
            }
        }
        let mut entries = self.entries.lock().map_err(err)?;
        entries.retain(|_, gate| gate.strong_count() > 0);
        Ok(keys
            .into_iter()
            .map(|(key, exclusive)| {
                let gate = if let Some(gate) = entries.get(&key).and_then(Weak::upgrade) {
                    gate
                } else {
                    let gate = Arc::new(RwLock::new(()));
                    entries.insert(key, Arc::downgrade(&gate));
                    gate
                };
                MutationLock { gate, exclusive }
            })
            .collect())
    }
}

impl Runtime {
    pub(super) fn mutation_paths(&self, operation: &Operation) -> Result<Vec<PathBuf>, String> {
        if !operation.mutates() {
            return Ok(Vec::new());
        }
        let path = match operation {
            Operation::CreateSession { project_id, .. } => {
                self.store.project(project_id).map_err(err)?.path
            }
            Operation::WriteFile { session_id, .. }
            | Operation::Path { session_id, .. }
            | Operation::Git { session_id, .. } => self.session(session_id)?.workspace_path,
            Operation::Approval {
                session_id,
                approval_id,
                kind,
                decision,
                ..
            } if decision == "approve" => {
                let session = crate::stores::parse_uuid(session_id)?;
                match kind {
                    ApprovalKind::Capability => return Ok(Vec::new()),
                    ApprovalKind::Provider => {
                        let manager = self
                            .app
                            .state::<crate::state::managers::ProviderApprovalManager>();
                        let pending = manager.pending.lock().map_err(err)?;
                        let approval = pending
                            .get(approval_id)
                            .ok_or("Approval is no longer pending")?;
                        if approval.session_id != session {
                            return Err("Approval belongs to another session or turn".into());
                        }
                        let Some(transaction) = &approval.file_transaction else {
                            return Ok(Vec::new());
                        };
                        transaction.workspace_path().to_path_buf()
                    }
                    ApprovalKind::Mutation => {
                        let proposal = crate::stores::open_store()?
                            .get_mutation_proposal(crate::stores::parse_uuid(approval_id)?)
                            .map_err(err)?
                            .ok_or("Mutation is no longer pending")?;
                        if proposal.session_id != session {
                            return Err("Mutation belongs to another session".into());
                        }
                        proposal.workspace_path
                    }
                }
            }
            // Provider decisions without file writes, terminal I/O and run admission
            // have their own ownership/receipt guards and need no repository lock.
            _ => return Ok(Vec::new()),
        };
        // Approval payloads can refer to a secondary root that has since been
        // removed from the session. Authorize the actual write target as well.
        if let Some(session) = operation.session_id() {
            if !self.store.authorizes(session, &path) {
                return Err("The mutation's project is no longer shared".into());
            }
        }
        Ok(vec![path])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn git(root: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn try_locks(locks: &[MutationLock]) -> Option<Vec<MutationGuard<'_>>> {
        locks
            .iter()
            .map(|lock| {
                if lock.exclusive {
                    Some(MutationGuard {
                        _read: None,
                        _write: Some(lock.gate.try_write().ok()?),
                    })
                } else {
                    Some(MutationGuard {
                        _read: Some(lock.gate.try_read().ok()?),
                        _write: None,
                    })
                }
            })
            .collect()
    }

    #[test]
    fn overlapping_non_git_workspaces_and_nested_repositories_conflict_in_both_directions() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("parent");
        let child = parent.join("child");
        let sibling = temp.path().join("sibling");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        let locks = MutationLocks::default();
        for nested_repository in [false, true] {
            if nested_repository {
                git(&child, &["init"]);
            }
            let parent = locks.for_paths(&[parent.clone()]).unwrap();
            let child = locks.for_paths(&[child.clone()]).unwrap();
            let sibling = locks.for_paths(&[sibling.clone()]).unwrap();
            let held = try_locks(&parent).unwrap();
            assert!(try_locks(&child).is_none());
            assert!(try_locks(&sibling).is_some());
            drop(held);
            let held = try_locks(&child).unwrap();
            assert!(try_locks(&parent).is_none());
            assert!(try_locks(&sibling).is_some());
            drop(held);
        }
    }

    #[test]
    fn repository_subfolders_aliases_and_worktrees_share_a_lock() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        git(&root, &["init", "-b", "main"]);
        git(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "Fixture",
            ],
        );
        let tree = temp.path().join("worktree");
        git(
            &root,
            &["worktree", "add", "-b", "linked", tree.to_str().unwrap()],
        );
        let locks = MutationLocks::default();
        let first = locks.for_paths(&[root.clone()]).unwrap();
        let nested = locks.for_paths(&[root.join("sub")]).unwrap();
        let linked = locks.for_paths(&[tree]).unwrap();
        #[cfg(unix)]
        {
            let alias = temp.path().join("alias");
            std::os::unix::fs::symlink(&root, &alias).unwrap();
            let alias = locks.for_paths(&[alias]).unwrap();
            assert_eq!(first.len(), alias.len());
            assert!(first
                .iter()
                .zip(&alias)
                .all(|(a, b)| a.exclusive == b.exclusive && Arc::ptr_eq(&a.gate, &b.gate)));
        }
        let held = try_locks(&first).unwrap();
        assert!(try_locks(&nested).is_none());
        assert!(try_locks(&linked).is_none());
        let other = temp.path().join("other");
        std::fs::create_dir(&other).unwrap();
        git(&other, &["init"]);
        let unrelated = locks.for_paths(&[other]).unwrap();
        assert!(try_locks(&unrelated).is_some());
        drop(held);
    }
}
