//! Parse each tree path once, rather than on both sides of every comparison.
use crate::workspace::types::WorkspaceFile;
use std::{ffi::OsString, path::Path};

pub(super) fn sort(entries: &mut [WorkspaceFile]) {
    entries.sort_by_cached_key(|entry| {
        let mut path = Path::new(&entry.path).components().peekable();
        let mut key = Vec::<(bool, OsString)>::with_capacity(entry.depth);
        while let Some(component) = path.next() {
            let directory = path.peek().is_some() || entry.kind == "directory";
            key.push((!directory, component.as_os_str().to_os_string()));
        }
        key
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_order_matches_hierarchical_directory_first_order() {
        let mut entries = Vec::new();
        for name in [
            "z",
            "a",
            "Alpha",
            "a.txt",
            "café",
            "日本語",
            "with space",
            ".hidden",
        ] {
            for directory in [false, true] {
                let path = if directory {
                    format!("{name}-dir")
                } else {
                    name.into()
                };
                entries.push(crate::workspace::types::WorkspaceFile {
                    path: path.clone(),
                    kind: if directory { "directory" } else { "file" }.into(),
                    depth: 1,
                });
                if directory {
                    for child in ["file.rs", "deep", "deep/leaf.rs", "a file"] {
                        let path = format!("{path}/{child}");
                        entries.push(crate::workspace::types::WorkspaceFile {
                            depth: Path::new(&path).components().count(),
                            path,
                            kind: if child == "deep" { "directory" } else { "file" }.into(),
                        });
                    }
                }
            }
        }
        // Rotation changes the input order, including the parent/child order.
        for offset in 0..entries.len() {
            let mut actual = entries.clone();
            actual.rotate_left(offset);
            let mut expected = actual.clone();
            expected.sort_by(crate::workspace::tree::compare_workspace_tree_entries);
            sort(&mut actual);
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
        }
    }

    #[test]
    fn scan_keeps_symlinks_as_leaves_and_generated_directories_out() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("private.txt"), "outside").unwrap();
        std::fs::create_dir_all(temp.path().join("src/nested")).unwrap();
        std::fs::create_dir_all(temp.path().join("node_modules/pkg")).unwrap();
        std::fs::write(temp.path().join("src/nested/é.rs"), "fixture").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), temp.path().join("linked")).unwrap();
        let snapshot = crate::workspace::tree::scan_workspace_tree(temp.path(), 8).unwrap();
        assert!(
            !snapshot
                .files
                .iter()
                .any(|entry| entry.path.contains("private.txt")
                    || entry.path.contains("node_modules"))
        );
        assert!(snapshot
            .files
            .iter()
            .any(|entry| entry.path == "src/nested/é.rs"));
        #[cfg(unix)]
        assert!(snapshot
            .files
            .iter()
            .any(|entry| entry.path == "linked" && entry.kind == "file"));
        let mut expected = snapshot.files.clone();
        expected.sort_by(crate::workspace::tree::compare_workspace_tree_entries);
        assert_eq!(
            serde_json::to_value(snapshot.files).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }
}
