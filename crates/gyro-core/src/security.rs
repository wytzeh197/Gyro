use anyhow::{bail, Context, Result};
use regex::Regex;
use std::{
    borrow::Cow,
    ffi::OsString,
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

static REDACTION_PATTERNS: OnceLock<[Regex; 4]> = OnceLock::new();

fn redaction_patterns() -> &'static [Regex; 4] {
    REDACTION_PATTERNS.get_or_init(|| {
        [
            Regex::new(r"sk-[A-Za-z0-9_-]{20,}").expect("valid redaction regex"),
            Regex::new(r#"(?i)(\"(?:api[_-]?key|token|secret|password)\"\s*:\s*\")[^\"]+"#)
                .expect("valid redaction regex"),
            Regex::new(r#"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^'"\s]+"#)
                .expect("valid redaction regex"),
            Regex::new(r"(?i)(authorization:\s*bearer\s+)[A-Za-z0-9._~+/=-]+")
                .expect("valid redaction regex"),
        ]
    })
}

pub fn assert_path_inside_workspace(workspace: &Path, candidate: &Path) -> Result<PathBuf> {
    let workspace = workspace
        .canonicalize()
        .with_context(|| format!("resolve workspace {}", workspace.display()))?;
    reject_parent_components(candidate)?;

    let candidate = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        workspace.join(candidate)
    };
    let candidate = resolve_from_nearest_existing_ancestor(&candidate)?;

    if !candidate.starts_with(&workspace) {
        bail!(
            "path {} is outside workspace {}",
            candidate.display(),
            workspace.display()
        );
    }

    Ok(candidate)
}

fn reject_parent_components(path: &Path) -> Result<()> {
    if path
        .components()
        .any(|component| component == Component::ParentDir)
    {
        bail!("path {} contains a parent-directory escape", path.display());
    }
    Ok(())
}

fn resolve_from_nearest_existing_ancestor(path: &Path) -> Result<PathBuf> {
    let mut ancestor = path;
    let mut missing = Vec::<OsString>::new();

    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let mut resolved = ancestor
                    .canonicalize()
                    .with_context(|| format!("resolve path {}", ancestor.display()))?;
                for component in missing.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let file_name = ancestor.file_name().ok_or_else(|| {
                    anyhow::anyhow!("path {} has no existing ancestor", path.display())
                })?;
                missing.push(file_name.to_os_string());
                ancestor = ancestor.parent().ok_or_else(|| {
                    anyhow::anyhow!("path {} has no existing ancestor", path.display())
                })?;
            }
            Err(error) => {
                return Err(error).with_context(|| format!("inspect path {}", ancestor.display()))
            }
        }
    }
}

pub fn redact_secrets(input: &str) -> String {
    let mut current = Cow::Borrowed(input);
    for regex in redaction_patterns() {
        if !regex.is_match(current.as_ref()) {
            continue;
        }
        current = Cow::Owned(
            regex
                .replace_all(current.as_ref(), |caps: &regex::Captures<'_>| {
                    if caps.len() > 1 {
                        format!(
                            "{}[REDACTED]",
                            caps.get(1).map(|m| m.as_str()).unwrap_or("")
                        )
                    } else {
                        "[REDACTED]".to_string()
                    }
                })
                .into_owned(),
        );
    }
    current.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_workspace() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&outside).unwrap();
        (temp, workspace, outside)
    }

    #[test]
    fn redacts_common_secret_shapes() {
        let redacted = redact_secrets("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456");
        assert!(redacted.contains("[REDACTED]"));
        assert!(!redacted.contains("abcdefghijklmnopqrstuvwxyz"));

        let redacted = redact_secrets(
            r#"{"loggedIn":false,"token":"secret-provider-token","password":"hidden"}"#,
        );
        assert_eq!(
            redacted,
            r#"{"loggedIn":false,"token":"[REDACTED]","password":"[REDACTED]"}"#
        );
    }

    #[test]
    fn rejects_paths_outside_workspace() {
        let (_temp, workspace, outside) = test_workspace();
        let error =
            assert_path_inside_workspace(&workspace, &outside.join("outside.txt")).unwrap_err();
        assert!(error.to_string().contains("outside workspace"));
    }

    #[test]
    fn resolves_nonexistent_paths_inside_workspace() {
        let (_temp, workspace, _outside) = test_workspace();
        let resolved =
            assert_path_inside_workspace(&workspace, Path::new("new/nested/file.txt")).unwrap();
        assert_eq!(
            resolved,
            workspace
                .canonicalize()
                .unwrap()
                .join("new/nested/file.txt")
        );
    }

    #[test]
    fn rejects_parent_directory_escapes_for_nonexistent_paths() {
        let (_temp, workspace, _outside) = test_workspace();
        for candidate in ["../outside.txt", "nested/../../outside.txt"] {
            let error = assert_path_inside_workspace(&workspace, Path::new(candidate)).unwrap_err();
            assert!(error.to_string().contains("parent-directory escape"));
        }

        let absolute_escape = workspace.join("..").join("outside").join("file.txt");
        let error = assert_path_inside_workspace(&workspace, &absolute_escape).unwrap_err();
        assert!(error.to_string().contains("parent-directory escape"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_nonexistent_paths_beneath_symlinks_that_escape_workspace() {
        use std::os::unix::fs::symlink;

        let (_temp, workspace, outside) = test_workspace();
        symlink(&outside, workspace.join("escape")).unwrap();

        let error =
            assert_path_inside_workspace(&workspace, Path::new("escape/new.txt")).unwrap_err();
        assert!(error.to_string().contains("outside workspace"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_nonexistent_paths_beneath_dangling_symlinks() {
        use std::os::unix::fs::symlink;

        let (_temp, workspace, outside) = test_workspace();
        symlink(outside.join("missing"), workspace.join("dangling")).unwrap();

        let error =
            assert_path_inside_workspace(&workspace, Path::new("dangling/new.txt")).unwrap_err();
        assert!(error.to_string().contains("resolve path"));
    }
}
