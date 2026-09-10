//! Observe changes to explicit file operands of a command. Never attribute the
//! whole shared working tree to one chat, and never infer an edit from prose.
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const MAX_FILES: usize = 128;
const MAX_FILE_BYTES: u64 = 1_048_576;
const MAX_TOTAL_BYTES: usize = 4_194_304;

#[derive(Default)]
pub struct CommandFileSnapshot(BTreeMap<PathBuf, Option<Vec<u8>>>);

fn read(path: &Path) -> Option<Option<Vec<u8>>> {
    match fs::File::open(path) {
        Ok(file) => {
            let metadata = file.metadata().ok()?;
            if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
                return None;
            }
            let mut bytes = Vec::new();
            file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
            (bytes.len() <= MAX_FILE_BYTES as usize).then_some(Some(bytes))
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
            total += bytes.as_ref().map_or(0, Vec::len);
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

#[cfg(test)]
mod tests {
    use super::*;
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
