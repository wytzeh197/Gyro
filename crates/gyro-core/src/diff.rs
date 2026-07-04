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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_changed_text() {
        let diff = summarize_text_diff("a\nb\n", "a\nc\n");
        assert_eq!(diff.old_lines, 2);
        assert_eq!(diff.new_lines, 2);
        assert!(diff.preview.contains("-b"));
        assert!(diff.preview.contains("+c"));
    }
}
