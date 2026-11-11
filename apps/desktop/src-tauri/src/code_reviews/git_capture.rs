use crate::git::{commands::git_command, read as git_read};
use anyhow::{ensure, Result};
use gyro_core::{
    code_reviews::{
        CapturedReviewFile, ReviewExclusion, ReviewScope, MAX_REVIEW_FILES, MAX_REVIEW_SIDE_BYTES,
    },
    mutations::content_hash,
    project_memory::confined_bytes,
};
use std::{collections::HashSet, path::Path, time::Instant};
pub(super) fn git(root: &Path, args: &[&str], deadline: Instant, limit: usize) -> Result<String> {
    let mut command = git_command();
    command
        .args(["--no-lazy-fetch", "--literal-pathspecs", "-C"])
        .arg(root)
        .args(args);
    let output = git_read::run(&command, deadline, limit)?;
    ensure!(
        output.succeeded() && !output.stdout_truncated,
        "Could not capture complete Git review input; refresh and retry"
    );
    Ok(output.stdout)
}
pub(super) fn oid(root: &Path, reference: &str, deadline: Instant) -> Result<String> {
    let result = git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ],
        deadline,
        1024,
    )?
    .trim()
    .to_string();
    ensure!(
        [40, 64].contains(&result.len()) && result.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid resolved commit"
    );
    Ok(result)
}
pub(super) fn head_oid(root: &Path, deadline: Instant) -> Result<Option<String>> {
    let mut command = git_command();
    command.args(["--no-lazy-fetch", "-C"]).arg(root).args([
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "HEAD^{commit}",
    ]);
    let output = git_read::run(&command, deadline, 1024)?;
    if output.exit_code() == Some(1)
        && output.stdout.trim().is_empty()
        && output.stderr.trim().is_empty()
    {
        return Ok(None);
    }
    ensure!(
        output.succeeded() && !output.stdout_truncated,
        "Could not resolve the complete review base"
    );
    let head = output.stdout.trim().to_string();
    ensure!(
        [40, 64].contains(&head.len()) && head.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "invalid review head"
    );
    Ok(Some(head))
}
pub(super) fn path_allowed(path: &str) -> bool {
    path.len() <= 1024
        && !path.contains(['\\', ':', '\u{fffd}'])
        && !path.chars().any(char::is_control)
        && gyro_core::normalize_capability_relative_path(path)
            .is_ok_and(|normalized| normalized == path)
        && !gyro_core::capability_path_is_sensitive(path)
}

#[derive(Clone)]
pub(super) struct Change {
    pub(super) path: String,
    pub(super) original_path: Option<String>,
    pub(super) status: String,
    pub(super) staged: bool,
}
pub(super) fn manifest(
    root: &Path,
    scope: &ReviewScope,
    base: Option<&str>,
    head: Option<&str>,
    deadline: Instant,
) -> Result<Vec<Change>> {
    let mut changes = Vec::new();
    if matches!(scope, ReviewScope::Uncommitted) {
        let raw = git(
            root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            deadline,
            256 * 1024,
        )?;
        let mut records = raw.split('\0').filter(|record| !record.is_empty());
        while let Some(record) = records.next() {
            ensure!(
                record.len() >= 4 && record.is_char_boundary(3),
                "invalid Git status record"
            );
            let status = &record[..2];
            let path = record[3..].to_string();
            let original_path = if status.contains('R') || status.contains('C') {
                Some(
                    records
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("incomplete Git rename record"))?
                        .to_string(),
                )
            } else {
                None
            };
            changes.push(Change {
                path,
                original_path,
                status: status.into(),
                staged: status.as_bytes()[0] != b' ' && status != "??",
            });
        }
    } else {
        let raw = git(
            root,
            &[
                "diff",
                "--name-status",
                "-z",
                "--find-renames",
                base.unwrap(),
                head.unwrap(),
                "--",
            ],
            deadline,
            256 * 1024,
        )?;
        let mut records = raw.split('\0').filter(|record| !record.is_empty());
        while let Some(status) = records.next() {
            let first = records
                .next()
                .ok_or_else(|| anyhow::anyhow!("incomplete Git change record"))?;
            let (path, original_path) = if status.starts_with(['R', 'C']) {
                (
                    records
                        .next()
                        .ok_or_else(|| anyhow::anyhow!("incomplete Git rename record"))?
                        .to_string(),
                    Some(first.to_string()),
                )
            } else {
                (first.to_string(), None)
            };
            changes.push(Change {
                path,
                original_path,
                status: status.into(),
                staged: false,
            });
        }
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(changes)
}
fn blob(
    root: &Path,
    commit: Option<&str>,
    path: &str,
    deadline: Instant,
) -> Result<Option<(String, String)>> {
    let Some(commit) = commit else {
        return Ok(None);
    };
    let listing = git(root, &["ls-tree", "-z", commit, "--", path], deadline, 4096)?;
    let Some(entry) = listing.split('\0').find(|entry| !entry.is_empty()) else {
        return Ok(None);
    };
    let (metadata, observed) = entry
        .split_once('\t')
        .ok_or_else(|| anyhow::anyhow!("invalid Git tree record"))?;
    ensure!(
        observed == path,
        "Git tree path does not match captured file"
    );
    let parts: Vec<_> = metadata.split_whitespace().collect();
    ensure!(
        parts.len() == 3 && ["100644", "100755"].contains(&parts[0]),
        "symbolic links and submodules are excluded"
    );
    let size: usize = git(root, &["cat-file", "-s", parts[2]], deadline, 1024)?
        .trim()
        .parse()?;
    ensure!(
        size <= MAX_REVIEW_SIDE_BYTES,
        "file exceeds the 1 MiB review side limit"
    );
    let text = git(
        root,
        &["cat-file", "blob", parts[2]],
        deadline,
        MAX_REVIEW_SIDE_BYTES + 1,
    )?;
    ensure!(
        !text.contains(['\0', '\u{fffd}']),
        "binary or undecodable text is excluded"
    );
    Ok(Some((text, parts[0].to_string())))
}
pub(super) fn collect(
    root: &Path,
    scope: &ReviewScope,
    base: Option<&str>,
    head: Option<&str>,
    selected: &HashSet<String>,
    private: &Path,
    deadline: Instant,
) -> Result<(Vec<CapturedReviewFile>, Vec<ReviewExclusion>)> {
    let changes = manifest(root, scope, base, head, deadline)?;
    let changes: Vec<_> = changes
        .into_iter()
        .filter(|change| !root.join(&change.path).starts_with(private))
        .filter(|change| selected.is_empty() || selected.contains(&change.path))
        .collect();
    ensure!(
        changes.len() <= MAX_REVIEW_FILES,
        "More than 64 files changed; select a narrower file scope"
    );
    ensure!(
        selected.is_empty()
            || selected
                .iter()
                .all(|path| changes.iter().any(|change| &change.path == path)),
        "a selected path is no longer in this change scope"
    );
    let mut files = Vec::new();
    let mut exclusions = Vec::new();
    for change in changes {
        let result = (|| -> Result<CapturedReviewFile> {
            ensure!(
                !root.join(&change.path).starts_with(private),
                "Gyro private data is excluded"
            );
            ensure!(
                path_allowed(&change.path)
                    && change.original_path.as_deref().is_none_or(path_allowed),
                "sensitive or unsupported file path"
            );
            ensure!(
                !change.status.contains('U') && change.status != "AA" && change.status != "DD",
                "unresolved merge conflict"
            );
            let original = blob(
                root,
                base,
                change.original_path.as_deref().unwrap_or(&change.path),
                deadline,
            )?;
            let (original, original_mode) = match original {
                Some((text, mode)) => (Some(text), Some(mode)),
                None => (None, None),
            };
            let modified = if matches!(scope, ReviewScope::Branch { .. }) {
                blob(root, head, &change.path, deadline)?
            } else {
                confined_bytes(root, &change.path, MAX_REVIEW_SIDE_BYTES)?
                    .map(String::from_utf8)
                    .transpose()?
                    .map(|text| -> Result<_> {
                        use std::os::unix::fs::PermissionsExt;
                        let metadata = std::fs::symlink_metadata(root.join(&change.path))?;
                        ensure!(metadata.is_file(), "file mode changed during capture");
                        Ok((
                            text,
                            if metadata.permissions().mode() & 0o111 != 0 {
                                "100755"
                            } else {
                                "100644"
                            }
                            .to_string(),
                        ))
                    })
                    .transpose()?
            };
            let (modified, modified_mode) = match modified {
                Some((text, mode)) => (Some(text), Some(mode)),
                None => (None, None),
            };
            ensure!(
                original.is_some() || modified.is_some(),
                "file content is unavailable"
            );
            for side in [&original, &modified].into_iter().flatten() {
                ensure!(
                    !side.contains('\0') && gyro_core::security::redact_secrets(side) == *side,
                    "binary or sensitive content is excluded"
                );
            }
            Ok(CapturedReviewFile {
                original_mode,
                modified_mode,
                path: change.path.clone(),
                original_path: change.original_path.clone(),
                original_hash: original.as_ref().map(|text| content_hash(text.as_bytes())),
                modified_hash: modified.as_ref().map(|text| content_hash(text.as_bytes())),
                original,
                modified,
                status: change.status.clone(),
                staged: change.staged,
            })
        })();
        match result {
            Ok(file) => files.push(file),
            Err(error) => exclusions.push(ReviewExclusion {
                path: change.path,
                reason: gyro_core::sanitize_capability_summary(&error.to_string()),
            }),
        }
    }
    Ok((files, exclusions))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn command(root: &Path, args: &[&str]) {
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
    #[test]
    fn review_capture_combines_staged_and_working_bytes_and_pins_branch_blobs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        command(root, &["init", "--initial-branch=main"]);
        std::fs::write(root.join("source.rs"), "original\n").unwrap();
        command(root, &["add", "source.rs"]);
        command(
            root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-m",
                "fixture",
            ],
        );
        let deadline = Instant::now() + std::time::Duration::from_secs(20);
        let base = oid(root, "HEAD", deadline).unwrap();
        std::fs::write(root.join("source.rs"), "staged\n").unwrap();
        command(root, &["add", "source.rs"]);
        std::fs::write(root.join("source.rs"), "working\n").unwrap();
        std::fs::write(root.join("new.rs"), "new\n").unwrap();
        let (files, excluded) = collect(
            root,
            &ReviewScope::Uncommitted,
            Some(&base),
            Some(&base),
            &HashSet::new(),
            &root.join("private"),
            deadline,
        )
        .unwrap();
        assert!(excluded.is_empty());
        assert_eq!(files.len(), 2);
        let source = files.iter().find(|file| file.path == "source.rs").unwrap();
        assert!(source.staged);
        assert_eq!(source.original.as_deref(), Some("original\n"));
        assert_eq!(source.modified.as_deref(), Some("working\n"));
        assert_eq!(source.modified_mode.as_deref(), Some("100644"));
        command(
            root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-m",
                "staged",
            ],
        );
        let head = oid(root, "HEAD", deadline).unwrap();
        let (branch, _) = collect(
            root,
            &ReviewScope::Branch { base: base.clone() },
            Some(&base),
            Some(&head),
            &HashSet::new(),
            &root.join("private"),
            deadline,
        )
        .unwrap();
        assert_eq!(branch.len(), 1);
        assert_eq!(branch[0].modified.as_deref(), Some("staged\n"));
    }
    #[test]
    fn review_capture_excludes_sensitive_and_symlink_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        command(root, &["init", "--initial-branch=main"]);
        std::fs::write(root.join(".env"), "value=private\n").unwrap();
        std::fs::write(root.join("safe.rs"), "safe\n").unwrap();
        std::os::unix::fs::symlink("safe.rs", root.join("link.rs")).unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        assert!(head_oid(root, deadline).unwrap().is_none());
        let (files, excluded) = collect(
            root,
            &ReviewScope::Uncommitted,
            None,
            None,
            &HashSet::new(),
            &root.join("private"),
            deadline,
        )
        .unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(excluded.len(), 2);
    }
}
