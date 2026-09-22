//! Counts measured from a provider's complete per-file unified patch.
//! Never substitute the shared working tree for a turn's changes.

pub(crate) fn from_unified_diff(diff: &str) -> Option<(usize, usize)> {
    let mut counts = (0, 0);
    let mut remaining = (0usize, 0usize);
    let mut saw_hunk = false;
    for line in diff.lines() {
        if line.starts_with("@@ ") {
            if remaining != (0, 0) {
                return None;
            }
            let mut parts = line.split_whitespace();
            parts.next()?;
            remaining = (
                range_len(parts.next()?, '-')?,
                range_len(parts.next()?, '+')?,
            );
            if parts.next()? != "@@" {
                return None;
            }
            saw_hunk = true;
        } else if line == "\\ No newline at end of file" {
            continue;
        } else if remaining != (0, 0) {
            match line.as_bytes().first()? {
                b'+' => {
                    remaining.1 = remaining.1.checked_sub(1)?;
                    counts.0 += 1;
                }
                b'-' => {
                    remaining.0 = remaining.0.checked_sub(1)?;
                    counts.1 += 1;
                }
                b' ' => {
                    remaining.0 = remaining.0.checked_sub(1)?;
                    remaining.1 = remaining.1.checked_sub(1)?;
                }
                _ => return None,
            }
        } else if saw_hunk {
            // Unexpected trailing content could be a truncated or invalid patch.
            return None;
        }
    }
    (saw_hunk && remaining == (0, 0)).then_some(counts)
}

/// Counts from a Claude Code tool result (`tool_use_result`): the hunks it
/// applied, whatever permission mode let the write through. A created file
/// reports no hunks, so its content is the addition.
pub(crate) fn from_claude_tool_result(result: &serde_json::Value) -> Option<(usize, usize)> {
    let hunks = result.get("structuredPatch")?.as_array()?;
    if hunks.is_empty() && result.get("type").and_then(serde_json::Value::as_str) == Some("create")
    {
        let content = result.get("content")?.as_str()?;
        return Some((content.lines().count(), 0));
    }
    let mut counts = (0, 0);
    for hunk in hunks {
        for line in hunk.get("lines")?.as_array()? {
            match line.as_str()?.as_bytes().first() {
                Some(b'+') => counts.0 += 1,
                Some(b'-') => counts.1 += 1,
                _ => {}
            }
        }
    }
    Some(counts)
}

/// Counts implied by an Edit or MultiEdit call before its result arrives.
///
/// Exact for a single replacement: diffing the replaced text against its
/// replacement marks the same lines a whole-file diff would. `replace_all`
/// touches an unknown number of sites, so it stays unmeasured until the
/// result reports them.
pub(crate) fn from_claude_edit_input(
    name: &str,
    input: &serde_json::Value,
) -> Option<(usize, usize)> {
    let replacement = |edit: &serde_json::Value| {
        if edit.get("replace_all").and_then(serde_json::Value::as_bool) == Some(true) {
            return None;
        }
        let old = edit.get("old_string")?.as_str()?;
        let new = edit.get("new_string")?.as_str()?;
        Some(gyro_core::diff::changed_line_counts(
            old.as_bytes(),
            new.as_bytes(),
        ))
    };
    match name {
        "Edit" => replacement(input),
        "MultiEdit" => input
            .get("edits")?
            .as_array()?
            .iter()
            .try_fold((0, 0), |total, edit| {
                let counts = replacement(edit)?;
                Some((total.0 + counts.0, total.1 + counts.1))
            }),
        _ => None,
    }
}

fn range_len(value: &str, prefix: char) -> Option<usize> {
    let range = value.strip_prefix(prefix)?;
    let (start, count) = range.split_once(',').unwrap_or((range, "1"));
    start.parse::<usize>().ok()?;
    count.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_tool_results_count_their_hunks() {
        let edit = serde_json::json!({
            "filePath": "/repo/a.css",
            "structuredPatch": [
                { "lines": [" keep", "-  padding-top: 12px;", "+  padding-top: 10px;", " keep"] },
                { "lines": ["+added", "+++not a header"] }
            ]
        });
        assert_eq!(from_claude_tool_result(&edit), Some((3, 1)));
        let created = serde_json::json!({
            "type": "create", "filePath": "/repo/new.md",
            "content": "one\ntwo\nthree\n", "structuredPatch": []
        });
        assert_eq!(from_claude_tool_result(&created), Some((3, 0)));
        let unchanged = serde_json::json!({ "type": "update", "structuredPatch": [] });
        assert_eq!(from_claude_tool_result(&unchanged), Some((0, 0)));
        assert_eq!(
            from_claude_tool_result(&serde_json::json!({ "stdout": "" })),
            None
        );
    }

    #[test]
    fn claude_edit_inputs_count_single_replacements() {
        let edit = serde_json::json!({
            "old_string": "a\nb\n", "new_string": "a\nB\nc\n"
        });
        assert_eq!(from_claude_edit_input("Edit", &edit), Some((2, 1)));
        // A fragment inside one line is still one changed line.
        let fragment = serde_json::json!({ "old_string": "12px", "new_string": "10px" });
        assert_eq!(from_claude_edit_input("Edit", &fragment), Some((1, 1)));
        let everywhere = serde_json::json!({
            "old_string": "x", "new_string": "y", "replace_all": true
        });
        assert_eq!(from_claude_edit_input("Edit", &everywhere), None);
        let multi = serde_json::json!({ "edits": [fragment, edit] });
        assert_eq!(from_claude_edit_input("MultiEdit", &multi), Some((3, 2)));
        assert_eq!(
            from_claude_edit_input("Write", &serde_json::json!({})),
            None
        );
    }

    #[test]
    fn counts_hunks_without_counting_headers_or_context() {
        assert_eq!(from_unified_diff("--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n same\n-old\n+new\n+++content\n@@ -5 +6 @@\n-x\n+y\n\\ No newline at end of file\n"), Some((3, 2)));
    }

    #[test]
    fn counts_created_deleted_and_empty_hunks() {
        assert_eq!(from_unified_diff("@@ -0,0 +1,2 @@\n+a\n+b\n"), Some((2, 0)));
        assert_eq!(from_unified_diff("@@ -1 +0,0 @@\n-a\n"), Some((0, 1)));
        assert_eq!(from_unified_diff("@@ -0,0 +0,0 @@\n"), Some((0, 0)));
    }

    #[test]
    fn missing_binary_and_incomplete_patches_are_unknown() {
        for patch in [
            "",
            "Binary files differ",
            "--- a/f\n+++ b/f\n",
            "@@ -1 +1 @@\n-old\n",
            "@@ -1 +1 @@\n-old\n+new\n+extra\n",
            "@@ -1 +1 @@\n-old\n@@ -2 +2 @@\n-x\n+y\n",
        ] {
            assert_eq!(from_unified_diff(patch), None, "{patch}");
        }
    }
}
