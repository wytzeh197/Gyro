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
