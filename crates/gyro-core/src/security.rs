use anyhow::{bail, Context, Result};
use regex::Regex;
use std::path::{Path, PathBuf};

pub fn assert_path_inside_workspace(workspace: &Path, candidate: &Path) -> Result<PathBuf> {
    let workspace = workspace
        .canonicalize()
        .with_context(|| format!("resolve workspace {}", workspace.display()))?;
    let candidate = if candidate.exists() {
        candidate
            .canonicalize()
            .with_context(|| format!("resolve path {}", candidate.display()))?
    } else if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        workspace.join(candidate)
    };

    if !candidate.starts_with(&workspace) {
        bail!(
            "path {} is outside workspace {}",
            candidate.display(),
            workspace.display()
        );
    }

    Ok(candidate)
}

pub fn redact_secrets(input: &str) -> String {
    let patterns = [
        r"sk-[A-Za-z0-9_-]{20,}",
        r#"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^'"\s]+"#,
        r"(?i)(authorization:\s*bearer\s+)[A-Za-z0-9._~+/=-]+",
    ];

    patterns.iter().fold(input.to_string(), |current, pattern| {
        let regex = Regex::new(pattern).expect("valid redaction regex");
        regex
            .replace_all(&current, |caps: &regex::Captures<'_>| {
                if caps.len() > 1 {
                    format!(
                        "{}[REDACTED]",
                        caps.get(1).map(|m| m.as_str()).unwrap_or("")
                    )
                } else {
                    "[REDACTED]".to_string()
                }
            })
            .to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_common_secret_shapes() {
        let redacted = redact_secrets("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456");
        assert!(redacted.contains("[REDACTED]"));
        assert!(!redacted.contains("abcdefghijklmnopqrstuvwxyz"));
    }

    #[test]
    fn rejects_paths_outside_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().parent().unwrap().join("outside.txt");
        let error = assert_path_inside_workspace(temp.path(), &outside).unwrap_err();
        assert!(error.to_string().contains("outside workspace"));
    }
}
