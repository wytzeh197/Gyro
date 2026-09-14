use super::{
    assert_workspace_path, bounded_command_error, git_command, git_main_comparison_base,
    git_repo_root, run_bounded_command, workspace_root,
};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, time::Duration};

const MAX_REVIEW_BYTES: usize = 2 * 1024 * 1024;
const PLAIN_DIFF_BYTE_LIMIT: usize = 512 * 1024;
const PLAIN_DIFF_LINE_LIMIT: usize = 8000;
const MAX_UNIFIED_BYTES: usize = 512 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub workspace_path: String,
    pub path: String,
    pub original_path: Option<String>,
    pub staged: bool,
    #[serde(default)]
    pub comparison: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewContent {
    original: String,
    modified: String,
    notice: Option<String>,
    unified: Option<String>,
}

#[tauri::command]
pub async fn git_review_content(request: ReviewRequest) -> Result<ReviewContent, String> {
    tauri::async_runtime::spawn_blocking(move || review_content(&request))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

fn git(root: &Path, args: &[&str], limit: usize) -> anyhow::Result<String> {
    let mut command = git_command();
    command
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(root)
        .args(args);
    let output = run_bounded_command(
        &command,
        Duration::from_secs(15),
        Some(Duration::from_secs(10)),
        limit,
        64 * 1024,
    )?;
    if !output.succeeded() || output.stdout_truncated {
        return Err(bounded_command_error("Could not load Git review", &output));
    }
    Ok(output.stdout)
}

// Resolve a blob first: a missing side is normal for added/deleted files, but
// a Git failure must never masquerade as an empty file.
fn blob(root: &Path, path: &str, head: bool) -> anyhow::Result<Option<String>> {
    let listing = if head {
        if git(root, &["rev-parse", "--verify", "--quiet", "HEAD"], 1024).is_err() {
            // An unborn repository has no HEAD, while a broken existing ref is an error.
            let branch = git(root, &["symbolic-ref", "HEAD"], 1024)?;
            let refs = git(
                root,
                &["for-each-ref", "--format=%(refname)", branch.trim()],
                4096,
            )?;
            anyhow::ensure!(refs.trim().is_empty(), "Could not read HEAD");
            return Ok(None);
        }
        git(root, &["ls-tree", "-z", "HEAD", "--", path], 16 * 1024)?
    } else {
        git(root, &["ls-files", "--stage", "-z", "--", path], 16 * 1024)?
    };
    let Some(entry) = listing.split('\0').find(|entry| !entry.is_empty()) else {
        return Ok(None);
    };
    let fields: Vec<_> = entry
        .split('\t')
        .next()
        .unwrap_or("")
        .split_whitespace()
        .collect();
    anyhow::ensure!(fields.len() == 3, "Invalid Git object entry");
    anyhow::ensure!(
        fields[0] != "160000",
        "Submodule changes cannot be displayed as a text diff."
    );
    anyhow::ensure!(
        fields[0] != "120000",
        "Symbolic links cannot be displayed as a text diff."
    );
    if !head {
        anyhow::ensure!(
            fields[2] == "0",
            "Resolve this file's merge conflict before reviewing its staged diff."
        );
    }
    let oid = if head { fields[2] } else { fields[1] };
    let size: usize = git(root, &["cat-file", "-s", oid], 1024)?.trim().parse()?;
    anyhow::ensure!(
        size <= MAX_REVIEW_BYTES,
        "This file exceeds the 2 MB text review limit."
    );
    let content = git(root, &["cat-file", "blob", oid], MAX_REVIEW_BYTES + 1)?;
    anyhow::ensure!(
        !content.contains('\0') && !content.contains('\u{fffd}'),
        "Binary files cannot be displayed as a text diff."
    );
    Ok(Some(content))
}

fn blob_from_commit(root: &Path, commit: &str, path: &str) -> anyhow::Result<Option<String>> {
    let listing = git(root, &["ls-tree", "-z", commit, "--", path], 16 * 1024)?;
    let Some(entry) = listing.split('\0').find(|entry| !entry.is_empty()) else {
        return Ok(None);
    };
    let fields: Vec<_> = entry
        .split('\t')
        .next()
        .unwrap_or("")
        .split_whitespace()
        .collect();
    anyhow::ensure!(fields.len() == 3, "Invalid Git object entry");
    anyhow::ensure!(
        fields[0] != "160000",
        "Submodule changes cannot be displayed as a text diff."
    );
    anyhow::ensure!(
        fields[0] != "120000",
        "Symbolic links cannot be displayed as a text diff."
    );
    let oid = fields[2];
    let size: usize = git(root, &["cat-file", "-s", oid], 1024)?.trim().parse()?;
    anyhow::ensure!(
        size <= MAX_REVIEW_BYTES,
        "This file exceeds the 2 MB text review limit."
    );
    let content = git(root, &["cat-file", "blob", oid], MAX_REVIEW_BYTES + 1)?;
    anyhow::ensure!(
        !content.contains('\0') && !content.contains('\u{fffd}'),
        "Binary files cannot be displayed as a text diff."
    );
    Ok(Some(content))
}

fn comparison_kind(request: &ReviewRequest) -> &str {
    match request.comparison.as_deref() {
        Some("branch") => "branch",
        Some("index") => "index",
        Some("working-tree") => "working-tree",
        _ if request.staged => "index",
        _ => "working-tree",
    }
}

fn too_large_for_editor(original: &str, modified: &str) -> bool {
    original.len() > PLAIN_DIFF_BYTE_LIMIT
        || modified.len() > PLAIN_DIFF_BYTE_LIMIT
        || original.lines().count() > PLAIN_DIFF_LINE_LIMIT
        || modified.lines().count() > PLAIN_DIFF_LINE_LIMIT
        || original.lines().any(|line| line.len() > 20_000)
        || modified.lines().any(|line| line.len() > 20_000)
}

fn read_worktree_file(file: &Path) -> anyhow::Result<String> {
    match fs::symlink_metadata(file) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.into()),
        Ok(metadata) => {
            anyhow::ensure!(
                metadata.is_file(),
                "This entry cannot be displayed as a text file."
            );
            anyhow::ensure!(
                metadata.len() <= MAX_REVIEW_BYTES as u64,
                "This file exceeds the 2 MB text review limit."
            );
            use std::io::Read;
            let mut bytes = Vec::new();
            fs::File::open(file)?
                .take((MAX_REVIEW_BYTES + 1) as u64)
                .read_to_end(&mut bytes)?;
            anyhow::ensure!(
                bytes.len() <= MAX_REVIEW_BYTES,
                "This file exceeds the 2 MB text review limit."
            );
            anyhow::ensure!(
                !bytes.contains(&0),
                "Binary files cannot be displayed as a text diff."
            );
            String::from_utf8(bytes)
                .map_err(|_| anyhow::anyhow!("Binary files cannot be displayed as a text diff."))
        }
    }
}

fn git_unified_diff(
    repo: &Path,
    path: &str,
    original_path: &str,
    kind: &str,
) -> anyhow::Result<Option<String>> {
    let mut args: Vec<String> = vec![
        "diff".into(),
        "--no-color".into(),
        "--no-ext-diff".into(),
        "--unified=3".into(),
        "--no-renames".into(),
    ];
    match kind {
        "index" => args.push("--cached".into()),
        "branch" => {
            let Some(base) = git_main_comparison_base(repo) else {
                return Ok(None);
            };
            args.push(base);
        }
        _ => {}
    }
    args.push("--".into());
    args.push(path.into());
    if original_path != path {
        args.push(original_path.into());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    match git(repo, &arg_refs, MAX_UNIFIED_BYTES + 1) {
        Ok(output) => {
            let unified = truncate_unified_diff(output);
            Ok((!unified.trim().is_empty()).then_some(unified))
        }
        Err(_) => Ok(None),
    }
}

fn truncate_unified_diff(output: String) -> String {
    if output.len() <= MAX_UNIFIED_BYTES {
        return output;
    }
    let mut end = MAX_UNIFIED_BYTES;
    while !output.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n[Diff truncated after 512 KB. Open the file to read the rest.]\n",
        &output[..end]
    )
}

fn synthetic_unified(path: &str, original: &str, modified: &str) -> String {
    let original_lines: Vec<&str> = original.split('\n').collect();
    let modified_lines: Vec<&str> = modified.split('\n').collect();
    let mut out = format!(
        "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,{} +1,{} @@\n",
        original_lines.len().max(1),
        modified_lines.len().max(1)
    );
    for line in original_lines {
        out.push('-');
        out.push_str(line);
        out.push('\n');
        if out.len() > MAX_UNIFIED_BYTES {
            out.push_str("[Diff truncated after 512 KB. Open the file to read the rest.]\n");
            return out;
        }
    }
    for line in modified_lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
        if out.len() > MAX_UNIFIED_BYTES {
            out.push_str("[Diff truncated after 512 KB. Open the file to read the rest.]\n");
            return out;
        }
    }
    out
}

fn review_content(request: &ReviewRequest) -> anyhow::Result<ReviewContent> {
    let workspace = workspace_root(&request.workspace_path)?;
    let repo = git_repo_root(&workspace).ok_or_else(|| anyhow::anyhow!("Not a Git repository"))?;
    let file = assert_workspace_path(&workspace, &request.path)?;
    let original_file = assert_workspace_path(
        &workspace,
        request.original_path.as_deref().unwrap_or(&request.path),
    )?;
    let path = file
        .strip_prefix(&repo)?
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Invalid file path"))?;
    let original_path = original_file
        .strip_prefix(&repo)?
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Invalid original path"))?;
    let kind = comparison_kind(request);
    let result = (|| -> anyhow::Result<(String, String)> {
        if fs::symlink_metadata(workspace.join(&request.path))
            .is_ok_and(|metadata| metadata.is_symlink())
        {
            anyhow::bail!("Symbolic links cannot be displayed as a text diff.");
        }
        if kind == "branch" {
            let base = git_main_comparison_base(&repo)
                .ok_or_else(|| anyhow::anyhow!("Could not resolve main for this comparison."))?;
            let original = blob_from_commit(&repo, &base, original_path)?.unwrap_or_default();
            let modified = read_worktree_file(&file)?;
            return Ok((original, modified));
        }
        let original = if kind == "index" {
            blob(&repo, original_path, true)?
        } else {
            // A staged rename can also have unstaged edits: the index already
            // uses the destination name in that case.
            match blob(&repo, path, false)? {
                Some(content) => Some(content),
                None if original_path != path => blob(&repo, original_path, false)?,
                None => None,
            }
        }
        .unwrap_or_default();
        let modified = if kind == "index" {
            blob(&repo, path, false)?.unwrap_or_default()
        } else {
            read_worktree_file(&file)?
        };
        Ok((original, modified))
    })();
    match result {
        Ok((original, modified)) => {
            let unified = git_unified_diff(&repo, path, original_path, kind)?.or_else(|| {
                (original != modified).then(|| synthetic_unified(path, &original, &modified))
            });
            if too_large_for_editor(&original, &modified) {
                return Ok(ReviewContent {
                    original: String::new(),
                    modified: String::new(),
                    notice: None,
                    unified,
                });
            }
            Ok(ReviewContent {
                original,
                modified,
                notice: None,
                unified,
            })
        }
        Err(error) => {
            let message = error.to_string();
            let unified = git_unified_diff(&repo, path, original_path, kind)
                .ok()
                .flatten();
            if unified.as_ref().is_some_and(|diff| !diff.trim().is_empty()) {
                return Ok(ReviewContent {
                    original: String::new(),
                    modified: String::new(),
                    notice: None,
                    unified,
                });
            }
            Ok(ReviewContent {
                original: String::new(),
                modified: String::new(),
                notice: Some(message),
                unified: None,
            })
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    hash: String,
    short_hash: String,
    subject: String,
    author: String,
    relative_date: String,
    refs: String,
    /// Parent hashes, newest first. Two or more means a merge, which the
    /// history graph draws differently — guessing from a "Merge ..." subject
    /// would mislabel any commit that merely talks about merging.
    parents: Vec<String>,
}

pub fn history(root: &Path) -> anyhow::Result<Vec<HistoryEntry>> {
    let output = git(
        root,
        &[
            "log",
            "-30",
            "-z",
            "--format=%H%x00%h%x00%s%x00%an%x00%ar%x00%D%x00%P",
        ],
        128 * 1024,
    )?;
    let fields: Vec<_> = output.split('\0').collect();
    Ok(fields
        .chunks_exact(7)
        .map(|row| HistoryEntry {
            hash: row[0].trim().into(),
            short_hash: row[1].into(),
            subject: row[2].into(),
            author: row[3].into(),
            relative_date: row[4].into(),
            refs: row[5].into(),
            parents: row[6]
                .split_whitespace()
                .map(|parent| parent.to_owned())
                .collect(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-b", "main"], 4096).unwrap();
        git(dir.path(), &["config", "user.name", "Review Test"], 4096).unwrap();
        git(
            dir.path(),
            &["config", "user.email", "review@example.test"],
            4096,
        )
        .unwrap();
        dir
    }

    fn request(root: &Path, path: &str, staged: bool) -> ReviewRequest {
        ReviewRequest {
            workspace_path: root.display().to_string(),
            path: path.into(),
            original_path: None,
            staged,
            comparison: None,
        }
    }

    #[test]
    fn review_distinguishes_head_index_and_worktree() {
        let dir = repo();
        let root = dir.path();
        fs::write(root.join("file.txt"), "head\n").unwrap();
        git(root, &["add", "file.txt"], 4096).unwrap();
        git(root, &["commit", "-m", "Original"], 4096).unwrap();
        fs::write(root.join("file.txt"), "index\n").unwrap();
        git(root, &["add", "file.txt"], 4096).unwrap();
        fs::write(root.join("file.txt"), "worktree\n").unwrap();
        let staged = review_content(&request(root, "file.txt", true)).unwrap();
        assert_eq!(
            (
                staged.original.as_str(),
                staged.modified.as_str(),
                staged.notice
            ),
            ("head\n", "index\n", None)
        );
        let unstaged = review_content(&request(root, "file.txt", false)).unwrap();
        assert_eq!(
            (
                unstaged.original.as_str(),
                unstaged.modified.as_str(),
                unstaged.notice
            ),
            ("index\n", "worktree\n", None)
        );
        let log = history(root).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "Original");
        assert_eq!(log[0].author, "Review Test");
        assert!(log[0].refs.contains("main"));
        assert!(log[0].parents.is_empty());
    }

    #[test]
    fn review_handles_unborn_added_deleted_and_renamed_files() {
        let dir = repo();
        let root = dir.path();
        let name = "new [1].txt";
        fs::write(root.join(name), "new\n").unwrap();
        let untracked = review_content(&request(root, name, false)).unwrap();
        assert_eq!(
            (
                untracked.original.as_str(),
                untracked.modified.as_str(),
                untracked.notice
            ),
            ("", "new\n", None)
        );
        git(root, &["add", name], 4096).unwrap();
        let added = review_content(&request(root, name, true)).unwrap();
        assert_eq!(
            (
                added.original.as_str(),
                added.modified.as_str(),
                added.notice
            ),
            ("", "new\n", None)
        );
        git(root, &["commit", "-m", "Add file"], 4096).unwrap();
        git(root, &["mv", name, "renamed.txt"], 4096).unwrap();
        let mut renamed_request = request(root, "renamed.txt", true);
        renamed_request.original_path = Some(name.into());
        let renamed = review_content(&renamed_request).unwrap();
        assert_eq!(
            (
                renamed.original.as_str(),
                renamed.modified.as_str(),
                renamed.notice
            ),
            ("new\n", "new\n", None)
        );
        fs::write(root.join("renamed.txt"), "edited after rename\n").unwrap();
        renamed_request.staged = false;
        let edited_rename = review_content(&renamed_request).unwrap();
        assert_eq!(
            (
                edited_rename.original.as_str(),
                edited_rename.modified.as_str(),
                edited_rename.notice
            ),
            ("new\n", "edited after rename\n", None)
        );
        fs::remove_file(root.join("renamed.txt")).unwrap();
        let deleted = review_content(&request(root, "renamed.txt", false)).unwrap();
        assert_eq!(
            (
                deleted.original.as_str(),
                deleted.modified.as_str(),
                deleted.notice
            ),
            ("new\n", "", None)
        );
        git(root, &["add", "-A"], 4096).unwrap();
        let deleted = review_content(&request(root, name, true)).unwrap();
        assert_eq!(
            (
                deleted.original.as_str(),
                deleted.modified.as_str(),
                deleted.notice
            ),
            ("new\n", "", None)
        );
    }

    #[test]
    fn review_reports_binary_size_and_workspace_boundaries() {
        let dir = repo();
        let root = dir.path();
        fs::write(root.join("image.bin"), [0, 1, 2]).unwrap();
        let binary = review_content(&request(root, "image.bin", false)).unwrap();
        assert!(binary.notice.unwrap().contains("Binary"));
        fs::write(root.join("large.txt"), vec![b'a'; MAX_REVIEW_BYTES + 1]).unwrap();
        let large = review_content(&request(root, "large.txt", false)).unwrap();
        assert!(large.notice.unwrap().contains("2 MB"));
        assert!(review_content(&request(root, "../outside.txt", false)).is_err());
        let mut bad_original = request(root, "image.bin", true);
        bad_original.original_path = Some("../outside.txt".into());
        assert!(review_content(&bad_original).is_err());
    }

    #[test]
    fn review_falls_back_to_unified_hunks_for_large_text() {
        let dir = repo();
        let root = dir.path();
        let mut body = String::from("base\n");
        for index in 0..9000 {
            body.push_str(&format!("line {index}\n"));
        }
        fs::write(root.join("big.txt"), &body).unwrap();
        git(root, &["add", "big.txt"], 4096).unwrap();
        git(root, &["commit", "-m", "Big file"], 4096).unwrap();
        body.push_str("changed\n");
        fs::write(root.join("big.txt"), &body).unwrap();
        let review = review_content(&request(root, "big.txt", false)).unwrap();
        assert!(review.original.is_empty());
        assert!(review.modified.is_empty());
        assert!(review.notice.is_none());
        let unified = review.unified.expect("large files keep a unified diff");
        assert!(unified.contains("+changed"));
    }

    #[test]
    fn review_compares_a_file_against_main() {
        let dir = repo();
        let root = dir.path();
        fs::write(root.join("file.txt"), "base\n").unwrap();
        git(root, &["add", "file.txt"], 4096).unwrap();
        git(root, &["commit", "-m", "Base"], 4096).unwrap();
        git(root, &["checkout", "-b", "feature"], 4096).unwrap();
        fs::write(root.join("file.txt"), "base\nfeature\n").unwrap();
        git(root, &["commit", "-am", "Feature"], 4096).unwrap();
        let mut branch = request(root, "file.txt", false);
        branch.comparison = Some("branch".into());
        let review = review_content(&branch).unwrap();
        assert_eq!(review.original.as_str(), "base\n");
        assert_eq!(review.modified.as_str(), "base\nfeature\n");
        assert!(review.notice.is_none());
        assert!(review.unified.as_deref().unwrap_or("").contains("+feature"));
    }

    #[test]
    fn truncated_unified_diff_preserves_utf8_boundaries() {
        let mut diff = "x".repeat(MAX_UNIFIED_BYTES - 1);
        diff.push('é');
        diff.push_str("tail");
        let truncated = truncate_unified_diff(diff);
        assert!(truncated.is_char_boundary(truncated.len()));
        assert!(truncated.contains("[Diff truncated after 512 KB."));
    }
}
