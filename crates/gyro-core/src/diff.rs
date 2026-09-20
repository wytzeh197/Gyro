use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDiff {
    pub old_lines: usize,
    pub new_lines: usize,
    pub preview: String,
}

pub fn summarize_text_diff(old: &str, new: &str) -> TextDiff {
    let old_lines = old.lines().count();
    let new_lines = new.lines().count();
    let mut preview = String::new();

    if old == new {
        preview.push_str("No changes\n");
    } else {
        for line in old.lines().take(20) {
            preview.push('-');
            preview.push_str(line);
            preview.push('\n');
        }
        for line in new.lines().take(20) {
            preview.push('+');
            preview.push_str(line);
            preview.push('\n');
        }
    }

    TextDiff {
        old_lines,
        new_lines,
        preview,
    }
}

/// Exact changed-line counts, independent of the bounded review preview.
pub fn changed_line_counts(old: &[u8], new: &[u8]) -> (usize, usize) {
    let patch = diffy::create_patch_bytes(old, new);
    let mut counts = (0, 0);
    for line in patch.hunks().iter().flat_map(|hunk| hunk.lines()) {
        match line {
            diffy::Line::Insert(_) => counts.0 += 1,
            diffy::Line::Delete(_) => counts.1 += 1,
            diffy::Line::Context(_) => {}
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_only_changed_lines_even_beyond_the_preview() {
        let old = format!("{}old\n", "same\n".repeat(100));
        let new = format!("{}new\nextra\n", "same\n".repeat(100));
        assert_eq!(changed_line_counts(old.as_bytes(), new.as_bytes()), (2, 1));
        assert_eq!(changed_line_counts(b"", b"new\nlast"), (2, 0));
        assert_eq!(changed_line_counts(b"old\n", b""), (0, 1));
        assert_eq!(changed_line_counts(b"same", b"same"), (0, 0));
    }

    #[test]
    fn summarizes_changed_text() {
        let diff = summarize_text_diff("a\nb\n", "a\nc\n");
        assert_eq!(diff.old_lines, 2);
        assert_eq!(diff.new_lines, 2);
        assert!(diff.preview.contains("-b"));
        assert!(diff.preview.contains("+c"));
    }
}
