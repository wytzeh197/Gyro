//! Observe changes to explicit file operands of a command. Never attribute the
//! whole shared working tree to one chat, and never infer an edit from prose.
use crate::{provider_chat_cwd, ProviderActivity, StreamingCommandState};
use std::{
    collections::BTreeMap,
    fs,
    hash::{Hash, Hasher},
    io::Read,
    path::{Component, Path, PathBuf},
};

const MAX_FILES: usize = 128;
const MAX_FILE_BYTES: u64 = 1_048_576;
const MAX_TOTAL_BYTES: usize = 4_194_304;

/// File length and content hash. A streaming turn can hold dozens of pending
/// snapshots, so keeping the bytes themselves cost megabytes per command.
type FileDigest = (usize, u64);

#[derive(Default)]
pub struct CommandFileSnapshot(BTreeMap<PathBuf, Option<FileDigest>>);

fn read(path: &Path) -> Option<Option<FileDigest>> {
    match fs::File::open(path) {
        Ok(file) => {
            let metadata = file.metadata().ok()?;
            if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
                return None;
            }
            let mut bytes = Vec::new();
            file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
            if bytes.len() > MAX_FILE_BYTES as usize {
                return None;
            }
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            bytes.hash(&mut hasher);
            Some(Some((bytes.len(), hasher.finish())))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(None),
        Err(_) => None,
    }
}

impl CommandFileSnapshot {
    pub fn capture(cwd: &Path, command: &str) -> Self {
        let Ok(root) = cwd.canonicalize() else {
            return Self::default();
        };
        let mut files = BTreeMap::new();
        let mut total = 0;
        // Includes literal paths in shell arguments and scripts (Python, Node,
        // heredocs). Dynamic/generated paths remain unclaimed.
        for token in command.split(|c: char| c.is_whitespace() || "\"'`=;(){}[],<>\\".contains(c)) {
            if files.len() >= MAX_FILES {
                break;
            }
            if token.is_empty() || token.starts_with('-') || !token.contains('.') {
                continue;
            }
            let candidate = Path::new(token);
            if candidate
                .components()
                .any(|c| matches!(c, Component::ParentDir))
            {
                continue;
            }
            let path = if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                root.join(candidate)
            };
            // Canonicalize existing paths/parents so symlinks cannot escape the
            // command's directory. Missing new files are valid candidates.
            let resolved = path
                .canonicalize()
                .ok()
                .or_else(|| Some(path.parent()?.canonicalize().ok()?.join(path.file_name()?)));
            let Some(path) = resolved.filter(|path| path.starts_with(&root)) else {
                continue;
            };
            if files.contains_key(&path) {
                continue;
            }
            let Some(bytes) = read(&path) else {
                continue;
            };
            total += bytes.as_ref().map_or(0, |(len, _)| *len);
            if total > MAX_TOTAL_BYTES {
                break;
            }
            files.insert(path, bytes);
        }
        Self(files)
    }

    pub fn changed_paths(self) -> Vec<PathBuf> {
        self.0
            .into_iter()
            .filter_map(|(path, before)| {
                let after = read(&path)?;
                (before != after).then_some(path)
            })
            .collect()
    }
}

/// Pending snapshots live on the streaming command, keyed by tool-use id.
/// Claude Code runs shell edits itself, so this is the only way those edits
/// reach the turn's changed files.
impl StreamingCommandState {
    /// Snapshot a command's file operands when it is announced, and report the
    /// ones it changed once its result arrives.
    pub(crate) fn observe_command_file_changes(
        &mut self,
        value: &serde_json::Value,
        activities: &[ProviderActivity],
        workspace_path: Option<&str>,
    ) -> Vec<ProviderActivity> {
        for activity in activities {
            if activity.kind != "command"
                || self.command_file_snapshots.contains_key(&activity.id)
                || self.command_file_snapshots.len() >= 32
            {
                continue;
            }
            // Without a project there is no boundary to observe inside.
            let (Some(command), Some(cwd)) = (
                activity.detail.as_deref(),
                workspace_path.and_then(|path| provider_chat_cwd(Some(path)).ok()),
            ) else {
                continue;
            };
            self.command_file_snapshots.insert(
                activity.id.clone(),
                CommandFileSnapshot::capture(&cwd, command),
            );
        }
        provider_tool_result_ids(value)
            .into_iter()
            .filter_map(|id| {
                let snapshot = self.command_file_snapshots.remove(&id)?;
                Some(observed_command_file_activities(&id, snapshot))
            })
            .flatten()
            .collect()
    }

    /// Commands whose result never arrived still ran; compare them at exit.
    pub(crate) fn finish_command_file_changes(&mut self) -> Vec<ProviderActivity> {
        std::mem::take(&mut self.command_file_snapshots)
            .into_iter()
            .flat_map(|(id, snapshot)| observed_command_file_activities(&id, snapshot))
            .collect()
    }
}

pub(crate) fn observed_command_file_activities(
    id: &str,
    snapshot: CommandFileSnapshot,
) -> Vec<ProviderActivity> {
    snapshot
        .changed_paths()
        .into_iter()
        .enumerate()
        .map(|(index, path)| {
            let path = path.to_string_lossy().into_owned();
            ProviderActivity {
                id: format!("{id}-observed-file-{index}"),
                kind: "file".into(),
                label: format!("Updated {path}"),
                detail: Some(path),
                note: None,
                status: "done".into(),
            }
        })
        .collect()
}

/// Tool-use ids whose results arrived in this frame. Claude Code reports them as
/// `tool_result` blocks inside a user message.
fn provider_tool_result_ids(value: &serde_json::Value) -> Vec<String> {
    value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| {
            block.get("type").and_then(serde_json::Value::as_str) == Some("tool_result")
        })
        .filter_map(|block| block.get("tool_use_id").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract_provider_activities;

    #[test]
    fn streaming_state_reports_files_changed_by_claude_shell_commands() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("style.css");
        std::fs::write(&path, "before").unwrap();
        let workspace = temp.path().to_string_lossy().into_owned();
        let mut state = StreamingCommandState::new();
        let tool_use = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{
                "type": "tool_use",
                "id": "toolu_1",
                "name": "Bash",
                "input": { "command": "sed -i '' 's/before/after/' style.css" }
            }]}
        });
        let activities = extract_provider_activities(&tool_use);
        assert!(state
            .observe_command_file_changes(&tool_use, &activities, Some(&workspace))
            .is_empty());
        std::fs::write(&path, "after").unwrap();
        let result = serde_json::json!({
            "type": "user",
            "message": { "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_1",
                "content": ""
            }]}
        });
        let observed = state.observe_command_file_changes(&result, &[], Some(&workspace));
        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].kind, "file");
        assert_eq!(
            observed[0].detail.as_deref(),
            Some(path.canonicalize().unwrap().to_string_lossy().as_ref())
        );
        assert!(state.finish_command_file_changes().is_empty());
    }

    #[test]
    fn reports_only_changed_command_operands_including_new_and_deleted_files() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["edit.ts", "read.ts", "other.ts", "delete.ts"] {
            fs::write(dir.path().join(name), "before").unwrap();
        }
        let snapshot = CommandFileSnapshot::capture(dir.path(), "python3 - <<'PY'\np='edit.ts';open(p,'w').write('after')\n# read.ts new.ts delete.ts\nPY");
        fs::write(dir.path().join("edit.ts"), "after").unwrap();
        fs::write(dir.path().join("other.ts"), "another chat").unwrap();
        fs::write(dir.path().join("new.ts"), "new").unwrap();
        fs::remove_file(dir.path().join("delete.ts")).unwrap();
        let names: Vec<_> = snapshot
            .changed_paths()
            .into_iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["delete.ts", "edit.ts", "new.ts"]);
    }
    #[test]
    fn each_command_gets_a_fresh_baseline_even_for_already_dirty_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.css");
        fs::write(&path, "dirty").unwrap();
        let first = CommandFileSnapshot::capture(dir.path(), "file.css");
        assert!(first.changed_paths().is_empty());
        let second = CommandFileSnapshot::capture(dir.path(), "file.css");
        fs::write(&path, "queued turn change").unwrap();
        assert_eq!(second.changed_paths(), [path.canonicalize().unwrap()]);
    }
}
