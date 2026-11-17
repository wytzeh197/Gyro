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
    patch_line_counts(&patch)
}

fn patch_line_counts<T: ToOwned + ?Sized>(patch: &diffy::Patch<'_, T>) -> (usize, usize) {
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

pub(crate) fn changed_line_counts_and_patch(
    old: &[u8],
    new: &[u8],
    max_patch_bytes: usize,
) -> ((usize, usize), Option<String>) {
    // A wholesale replacement with no shared line has an exact, trivial
    // count. If its raw text already exceeds retention, no patch can fit.
    // Avoid Myers' quadratic search for this common generated-file case.
    if old.len().saturating_add(new.len()) > max_patch_bytes && old != new {
        let old_lines: Vec<_> = old.split_inclusive(|byte| *byte == b'\n').collect();
        let old_set: std::collections::HashSet<_> = old_lines.iter().copied().collect();
        let mut new_lines = 0;
        let disjoint = new.split_inclusive(|byte| *byte == b'\n').all(|line| {
            new_lines += 1;
            !old_set.contains(line)
        });
        if disjoint {
            return ((new_lines, old_lines.len()), None);
        }
    }
    let patch = diffy::create_patch_bytes(old, new);
    let counts = patch_line_counts(&patch);
    if std::str::from_utf8(old).is_err() || std::str::from_utf8(new).is_err() {
        return (counts, None);
    }
    // Stop formatting at the retention limit instead of allocating a complete
    // multi-megabyte patch only to discard it. Counts still cover every hunk.
    let mut output = BoundedPatch {
        bytes: Vec::new(),
        limit: max_patch_bytes,
    };
    let text = diffy::PatchFormatter::new()
        .write_patch_into(&patch, &mut output)
        .ok()
        .and_then(|()| String::from_utf8(output.bytes).ok());
    (counts, text)
}

struct BoundedPatch {
    bytes: Vec<u8>,
    limit: usize,
}

impl std::io::Write for BoundedPatch {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other("patch exceeds preview limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combined_summary_preserves_exact_patch_and_bounds() {
        let texts = [
            "",
            "same\n",
            "old",
            "new\nlast",
            "\n\n",
            "café\n😀\n",
            "a\r\nb\r\n",
        ];
        for old in texts {
            for new in texts {
                let expected = diffy::create_patch(old, new).to_string();
                let (counts, patch) =
                    changed_line_counts_and_patch(old.as_bytes(), new.as_bytes(), expected.len());
                assert_eq!(counts, changed_line_counts(old.as_bytes(), new.as_bytes()));
                assert_eq!(patch.as_deref(), Some(expected.as_str()));
                if !expected.is_empty() {
                    let (bounded_counts, bounded) = changed_line_counts_and_patch(
                        old.as_bytes(),
                        new.as_bytes(),
                        expected.len() - 1,
                    );
                    assert_eq!(bounded_counts, counts);
                    assert!(bounded.is_none());
                }
            }
        }
        let (counts, patch) = changed_line_counts_and_patch(b"old\n", b"\xff\n", 1024);
        assert_eq!(counts, (1, 1));
        assert!(patch.is_none());
    }

    #[test]
    fn oversized_patch_does_not_truncate_line_counts() {
        let old = "old\n".repeat(200);
        let new = "new\n".repeat(200);
        assert_eq!(
            changed_line_counts_and_patch(old.as_bytes(), new.as_bytes(), 64),
            ((200, 200), None)
        );
        let mut output = BoundedPatch {
            bytes: Vec::new(),
            limit: 3,
        };
        assert!(std::io::Write::write_all(&mut output, b"four").is_err());
        assert!(output.bytes.is_empty());
    }

    #[test]
    #[ignore = "explicit local performance measurement"]
    fn benchmark_review_patch_summary() {
        use std::{hint::black_box, time::Instant};
        for lines in [200, 2_000] {
            let old: String = (0..lines)
                .map(|line| format!("before {line:06} value\n"))
                .collect();
            let new: String = (0..lines)
                .map(|line| format!("after {line:06} value\n"))
                .collect();
            let mut durations = Vec::new();
            let mut bytes = 0;
            for _ in 0..5 {
                let start = Instant::now();
                let summary = black_box(changed_line_counts_and_patch(
                    black_box(old.as_bytes()),
                    black_box(new.as_bytes()),
                    256 * 1024,
                ));
                durations.push(start.elapsed().as_micros());
                bytes = summary.1.as_ref().map_or(0, String::len);
                assert_eq!(summary.0, (lines, lines));
            }
            durations.sort_unstable();
            println!("review-summary lines={lines} input_bytes={} median_us={} retained_patch_bytes={bytes}", old.len() + new.len(), durations[2]);
        }
    }

    #[test]
    #[ignore = "explicit local performance measurement"]
    fn benchmark_large_disjoint_review_summary() {
        use std::{hint::black_box, time::Instant};
        let lines = 50_000;
        let old: String = (0..lines)
            .map(|line| format!("before {line:06} value\n"))
            .collect();
        let new: String = (0..lines)
            .map(|line| format!("after {line:06} value\n"))
            .collect();
        let start = Instant::now();
        assert_eq!(
            black_box(changed_line_counts_and_patch(
                old.as_bytes(),
                new.as_bytes(),
                256 * 1024
            )),
            ((lines, lines), None)
        );
        println!(
            "large-disjoint lines={lines} input_bytes={} elapsed_us={}",
            old.len() + new.len(),
            start.elapsed().as_micros()
        );
    }

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
