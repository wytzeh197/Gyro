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

static REDACTION_PATTERNS: OnceLock<[Regex; 10]> = OnceLock::new();

fn redaction_patterns() -> &'static [Regex; 10] {
    REDACTION_PATTERNS.get_or_init(|| {
        [
            Regex::new(r"sk-[A-Za-z0-9_-]{20,}").expect("valid redaction regex"),
            Regex::new(r#"(?i)(\"(?:api[_-]?key|token|secret|password)\"\s*:\s*\")[^\"]+"#)
                .expect("valid redaction regex"),
            Regex::new(r#"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^'"\s]+"#)
                .expect("valid redaction regex"),
            Regex::new(r"(?i)(authorization:\s*bearer\s+)[A-Za-z0-9._~+/=-]+")
                .expect("valid redaction regex"),
            // Token families that carry no `key=value` or JSON shape, so the
            // generic patterns above never see them. They reach the model
            // through tool output, previews, and error text.
            Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b")
                .expect("valid redaction regex"),
            Regex::new(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b").expect("valid redaction regex"),
            Regex::new(r"\bAIza[0-9A-Za-z_-]{35}\b").expect("valid redaction regex"),
            Regex::new(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b").expect("valid redaction regex"),
            Regex::new(r"\bxai-[A-Za-z0-9]{20,}\b").expect("valid redaction regex"),
            Regex::new(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")
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

/// Resolve a workspace entry for lifecycle operations (delete, rename, stage,
/// discard) without following the entry itself. Only the parent is
/// canonicalized, so a symlink named `CLAUDE.md -> AGENTS.md` resolves to the
/// link and never to its target. The workspace root itself is never an entry.
pub fn assert_entry_inside_workspace(workspace: &Path, candidate: &Path) -> Result<PathBuf> {
    let workspace = workspace
        .canonicalize()
        .with_context(|| format!("resolve workspace {}", workspace.display()))?;
    reject_parent_components(candidate)?;

    let candidate = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        workspace.join(candidate)
    };
    let file_name = candidate
        .components()
        .next_back()
        .and_then(|component| match component {
            Component::Normal(name) => Some(name.to_os_string()),
            _ => None,
        })
        .ok_or_else(|| anyhow::anyhow!("path {} has no entry name", candidate.display()))?;
    let parent = candidate
        .parent()
        .ok_or_else(|| anyhow::anyhow!("path {} has no parent", candidate.display()))?;
    let entry = resolve_from_nearest_existing_ancestor(parent)?.join(file_name);

    if !entry.starts_with(&workspace) || entry == workspace {
        bail!(
            "path {} is outside workspace {}",
            entry.display(),
            workspace.display()
        );
    }

    Ok(entry)
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
    redact_matches(input, |caps| {
        if caps.len() > 1 {
            format!(
                "{}[REDACTED]",
                caps.get(1).map(|m| m.as_str()).unwrap_or("")
            )
        } else {
            "[REDACTED]".to_string()
        }
    })
}

/// Mask secrets without moving the editor positions of the surrounding text.
/// Workspace read continuations use UTF-16 columns, so a replacement must keep
/// both line breaks and UTF-16 width even when the secret contains Unicode.
pub fn redact_secrets_preserving_positions(input: &str) -> String {
    redact_matches(input, |caps| {
        let matched = caps.get(0).expect("redaction match").as_str();
        let prefix = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let mut masked = prefix.to_owned();
        for character in matched[prefix.len()..].chars() {
            if matches!(character, '\n' | '\r') {
                masked.push(character);
            } else if character.len_utf16() == 2 {
                // Keep surrogate pairs atomic: two ASCII masks
                // would permit a chunk to split within the source
                // character's two-column width.
                masked.push('🔒');
            } else {
                masked.push('*');
            }
        }
        masked
    })
}

/// Run the pattern table, or copy `input` when it cannot match.
///
/// Command output and workspace reads call this with multi-megabyte text that
/// usually matches nothing. Each pattern is a full scan. [`might_need_redaction`]
/// is a necessary condition for those patterns, so a miss skips them. A hit
/// still runs every pattern and masks the same way as before.
fn redact_matches(input: &str, mut mask: impl FnMut(&regex::Captures<'_>) -> String) -> String {
    if !might_need_redaction(input) {
        return input.to_owned();
    }
    let mut current = Cow::Borrowed(input);
    for regex in redaction_patterns() {
        if !regex.is_match(current.as_ref()) {
            continue;
        }
        current = Cow::Owned(regex.replace_all(current.as_ref(), &mut mask).into_owned());
    }
    current.into_owned()
}

/// True when `input` might match [`redaction_patterns`].
///
/// ASCII text can match only by containing a literal the pattern requires.
/// A non-ASCII byte keeps the full scan: `(?i)` and `\s` follow Unicode case
/// folding, which a byte compare would miss. This is not a matcher. Adding a
/// pattern means adding its literal here and a sample in
/// `prefilter_sees_every_current_pattern`.
fn might_need_redaction(input: &str) -> bool {
    let bytes = input.as_bytes();
    for (index, &byte) in bytes.iter().enumerate() {
        if !byte.is_ascii() {
            return true;
        }
        if marker_at(bytes, index, byte) {
            return true;
        }
    }
    false
}

fn marker_at(bytes: &[u8], index: usize, byte: u8) -> bool {
    match byte {
        b's' => {
            starts_with_at(bytes, index, b"sk-") || starts_with_ignore_at(bytes, index, b"secret")
        }
        b'S' => starts_with_ignore_at(bytes, index, b"secret"),
        b'g' => gh_token_prefix(bytes, index) || starts_with_at(bytes, index, b"github_pat_"),
        b't' | b'T' => starts_with_ignore_at(bytes, index, b"token"),
        b'p' | b'P' => starts_with_ignore_at(bytes, index, b"password"),
        b'a' | b'A' => {
            starts_with_ignore_at(bytes, index, b"apikey")
                || starts_with_ignore_at(bytes, index, b"api_key")
                || starts_with_ignore_at(bytes, index, b"api-key")
                || starts_with_ignore_at(bytes, index, b"authorization")
                || (byte == b'A'
                    && (starts_with_at(bytes, index, b"AKIA")
                        || starts_with_at(bytes, index, b"ASIA")
                        || starts_with_at(bytes, index, b"AIza")))
        }
        b'x' => {
            starts_with_at(bytes, index, b"xai-")
                || (bytes.get(index + 1) == Some(&b'o')
                    && bytes.get(index + 2) == Some(&b'x')
                    && matches!(bytes.get(index + 3), Some(b'a' | b'b' | b'p' | b'r' | b's'))
                    && bytes.get(index + 4) == Some(&b'-'))
        }
        b'e' => starts_with_at(bytes, index, b"eyJ"),
        _ => false,
    }
}

fn gh_token_prefix(bytes: &[u8], index: usize) -> bool {
    bytes.get(index + 1) == Some(&b'h')
        && matches!(bytes.get(index + 2), Some(b'p' | b'o' | b'u' | b's' | b'r'))
        && bytes.get(index + 3) == Some(&b'_')
}

fn starts_with_at(bytes: &[u8], index: usize, literal: &[u8]) -> bool {
    bytes
        .get(index..index + literal.len())
        .is_some_and(|window| window == literal)
}

fn starts_with_ignore_at(bytes: &[u8], index: usize, literal: &[u8]) -> bool {
    bytes
        .get(index..index + literal.len())
        .is_some_and(|window| window.eq_ignore_ascii_case(literal))
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
    fn redacts_provider_and_cloud_token_shapes() {
        // Built at runtime so no literal credential-shaped string lives in the
        // source tree.
        let tokens = [
            format!("ghp_{}", "a".repeat(36)),
            format!("github_pat_{}", "b".repeat(22)),
            format!("AKIA{}", "C".repeat(16)),
            format!("AIza{}", "d".repeat(35)),
            format!("xoxb-{}-{}", "1234567890", "abcdefghij"),
            format!("xai-{}", "e".repeat(32)),
            format!(
                "eyJ{}.{}.{}",
                "f".repeat(20),
                "g".repeat(20),
                "h".repeat(20)
            ),
        ];
        for token in tokens {
            let source = format!("value={token} end");
            let redacted = redact_secrets(&source);
            assert!(redacted.contains("[REDACTED]"), "{redacted}");
            assert!(!redacted.contains(&token[..12]), "{redacted}");
            assert!(redacted.ends_with(" end"), "{redacted}");
            // The position-preserving mask keeps lines and UTF-16 length.
            let masked = redact_secrets_preserving_positions(&source);
            assert!(!masked.contains(&token[..12]), "{masked}");
            assert_eq!(source.encode_utf16().count(), masked.encode_utf16().count());
        }
    }

    #[test]
    fn redaction_leaves_ordinary_identifiers_alone() {
        for text in [
            "AKIAsomething short",
            "he said eyJ hi",
            "xoxo hugs",
            "prefix ghpx_1234567890",
            "AIza short",
        ] {
            assert_eq!(redact_secrets(text), text, "{text}");
        }
    }

    #[test]
    fn prefilter_sees_every_current_pattern() {
        let mut samples = vec![
            "sk-abcdefghijklmnopqrstuvwxyz123456".to_string(),
            r#"{"token":"hidden-value"}"#.to_string(),
            r#"{"API_KEY":"hidden-value"}"#.to_string(),
            r#"{"api-key":"hidden-value"}"#.to_string(),
            r#"{"apikey":"hidden-value"}"#.to_string(),
            r#"{"secret":"hidden-value"}"#.to_string(),
            r#"{"password":"hidden-value"}"#.to_string(),
            "mytoken=hidden-value".to_string(),
            "TOKEN=hidden-value".to_string(),
            "SECRET=hidden-value".to_string(),
            "API-KEY=hidden-value".to_string(),
            "password: hidden-value".to_string(),
            "Password: hidden-value".to_string(),
            "authorization: bearer hidden-value".to_string(),
            "Authorization: Bearer hidden-value".to_string(),
        ];
        for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"] {
            samples.push(format!("{prefix}{}", "a".repeat(20)));
        }
        for prefix in ["AKIA", "ASIA"] {
            samples.push(format!("{prefix}{}", "A".repeat(16)));
        }
        samples.push(format!("AIza{}", "d".repeat(35)));
        for prefix in ["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"] {
            samples.push(format!("{prefix}{}", "a".repeat(10)));
        }
        samples.push(format!("xai-{}", "e".repeat(20)));
        samples.push(format!(
            "eyJ{}.{}.{}",
            "f".repeat(8),
            "g".repeat(8),
            "h".repeat(8)
        ));

        let patterns = redaction_patterns();
        for sample in &samples {
            assert!(
                patterns.iter().any(|pattern| pattern.is_match(sample)),
                "pattern missed {sample}"
            );
            assert!(might_need_redaction(sample), "prefilter missed {sample}");
            let redacted = redact_secrets(sample);
            assert!(redacted.contains("[REDACTED]"), "{sample} -> {redacted}");
            assert_ne!(redacted, *sample);
            let masked = redact_secrets_preserving_positions(sample);
            assert_ne!(masked, *sample);
            assert_eq!(
                sample.encode_utf16().count(),
                masked.encode_utf16().count(),
                "{sample}"
            );
        }
    }

    #[test]
    fn clean_ascii_skips_the_pattern_table() {
        let text = "src/workspace.rs: compiled successfully; 42 checks passed.\n".repeat(40);
        assert!(!might_need_redaction(&text));
        assert_eq!(redact_secrets(&text), text);
        assert_eq!(redact_secrets_preserving_positions(&text), text);

        // These look like markers and must not be treated as ones. The pattern
        // table agrees, so skipping it leaves the same bytes.
        let near_miss = "SK-abcdefghijklmnopqrstuvwxyz123456 xoxo ghp ey xoxb xai model";
        assert!(!redaction_patterns()
            .iter()
            .any(|pattern| pattern.is_match(near_miss)));
        assert!(!might_need_redaction(near_miss));
        assert_eq!(redact_secrets(near_miss), near_miss);
        assert_eq!(redact_secrets_preserving_positions(near_miss), near_miss);
    }

    #[test]
    fn a_marker_after_clean_ascii_still_redacts() {
        let mut text = "compiled successfully\n".repeat(2_000);
        text.push_str("token=hidden-value\n");
        assert!(might_need_redaction(&text));
        let redacted = redact_secrets(&text);
        assert!(redacted.starts_with("compiled successfully\n"));
        assert!(redacted.contains("[REDACTED]"));
        assert!(!redacted.contains("hidden-value"));
    }

    #[test]
    fn non_ascii_text_still_runs_the_patterns() {
        let clean = "café compiled successfully";
        assert!(might_need_redaction(clean));
        assert_eq!(redact_secrets(clean), clean);
        assert_eq!(redact_secrets_preserving_positions(clean), clean);

        let secret = "café token=hidden-value";
        assert!(might_need_redaction(secret));
        let redacted = redact_secrets(secret);
        assert!(redacted.contains("café"));
        assert!(redacted.contains("[REDACTED]"));
        assert!(!redacted.contains("hidden-value"));
        let masked = redact_secrets_preserving_positions(secret);
        assert_eq!(secret.encode_utf16().count(), masked.encode_utf16().count());
        assert!(!masked.contains("hidden-value"));
    }

    #[test]
    fn workspace_redaction_preserves_utf16_columns_and_lines() {
        let source = "before\n{\"token\":\"🦀hidden\nvalue\"} after\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456";
        let masked = redact_secrets_preserving_positions(source);
        assert!(!masked.contains("hidden"));
        assert!(!masked.contains("abcdefghijklmnopqrstuvwxyz"));
        assert_eq!(source.encode_utf16().count(), masked.encode_utf16().count());
        for (source, masked) in source.split('\n').zip(masked.split('\n')) {
            assert_eq!(source.encode_utf16().count(), masked.encode_utf16().count());
        }
        assert_eq!(source.lines().count(), masked.lines().count());
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

    #[cfg(unix)]
    #[test]
    fn entry_resolution_keeps_symlinks_as_links() {
        use std::os::unix::fs::symlink;

        let (_temp, workspace, outside) = test_workspace();
        fs::write(workspace.join("AGENTS.md"), "keep").unwrap();
        symlink("AGENTS.md", workspace.join("CLAUDE.md")).unwrap();
        symlink(&outside, workspace.join("escape")).unwrap();
        let root = workspace.canonicalize().unwrap();

        let link = assert_entry_inside_workspace(&workspace, Path::new("CLAUDE.md")).unwrap();
        assert_eq!(link, root.join("CLAUDE.md"));
        // A link to a directory outside the workspace is itself an entry of it.
        let escape = assert_entry_inside_workspace(&workspace, Path::new("escape")).unwrap();
        assert_eq!(escape, root.join("escape"));
        // Entries beneath that link still resolve outside and are refused.
        let error =
            assert_entry_inside_workspace(&workspace, Path::new("escape/file.txt")).unwrap_err();
        assert!(error.to_string().contains("outside workspace"));
    }

    #[test]
    fn entry_resolution_refuses_the_workspace_root() {
        let (_temp, workspace, _outside) = test_workspace();
        assert!(assert_entry_inside_workspace(&workspace, Path::new("")).is_err());
        assert!(assert_entry_inside_workspace(&workspace, Path::new(".")).is_err());
        assert!(assert_entry_inside_workspace(&workspace, &workspace).is_err());
    }
}
