use super::{WorkspaceSearchRange, WorkspaceSearchResult};
use serde::Deserialize;

#[derive(Deserialize)]
struct RgText {
    text: String,
}

#[derive(Deserialize)]
struct RgMatch {
    path: RgText,
    lines: RgText,
    line_number: usize,
    submatches: Vec<RgRange>,
}

#[derive(Deserialize)]
struct RgRange {
    start: usize,
    end: usize,
}

// Ripgrep reports byte offsets; the editor and JavaScript use UTF-16 columns.
fn search_range(line: &str, start: usize, end: usize) -> Option<WorkspaceSearchRange> {
    if start > end {
        return None;
    }
    Some(WorkspaceSearchRange {
        start_column: line.get(..start)?.encode_utf16().count() + 1,
        end_column: line.get(..end)?.encode_utf16().count() + 1,
    })
}

pub(super) fn literal_search_ranges(line: &str, query: &str) -> Vec<WorkspaceSearchRange> {
    if query.is_empty() {
        return Vec::new();
    }
    line.match_indices(query)
        .filter_map(|(offset, matched)| search_range(line, offset, offset + matched.len()))
        .collect()
}

pub(super) fn parse_rg_output(output: &str, max_results: usize) -> Vec<WorkspaceSearchResult> {
    output
        .lines()
        .filter_map(|record| {
            let record: serde_json::Value = serde_json::from_str(record).ok()?;
            if record.get("type")?.as_str()? != "match" {
                return None;
            }
            let data: RgMatch = serde_json::from_value(record.get("data")?.clone()).ok()?;
            let line = data
                .lines
                .text
                .strip_suffix('\n')
                .unwrap_or(&data.lines.text);
            let line = line.strip_suffix('\r').unwrap_or(line);
            let ranges = data
                .submatches
                .iter()
                .filter_map(|range| search_range(line, range.start, range.end))
                .collect();
            Some(WorkspaceSearchResult {
                path: data
                    .path
                    .text
                    .strip_prefix("./")
                    .unwrap_or(&data.path.text)
                    .to_owned(),
                line_number: data.line_number,
                line: line.to_owned(),
                ranges,
            })
        })
        .take(max_results)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_search_preserves_paths_and_exact_unicode_ranges() {
        let record = serde_json::json!({
            "type": "match", "data": {
                "path": {"text": "./.config/a:b\nc.txt"},
                "lines": {"text": "é 🦀 hit hit\r\n"}, "line_number": 7,
                "submatches": [{"start": 8, "end": 11}, {"start": 12, "end": 15}]
            }
        })
        .to_string();
        let results = parse_rg_output(&format!("{{\"type\":\"begin\"}}\n{record}\n{record}\n"), 1);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, ".config/a:b\nc.txt");
        assert_eq!(results[0].line, "é 🦀 hit hit");
        assert_eq!(results[0].line_number, 7);
        assert_eq!(results[0].ranges.len(), 2);
        assert_eq!(results[0].ranges[0].start_column, 6);
        assert_eq!(results[0].ranges[0].end_column, 9);
        assert_eq!(results[0].ranges[1].start_column, 10);
        assert_eq!(results[0].ranges[1].end_column, 13);
    }

    #[test]
    fn workspace_search_fallback_uses_editor_columns_for_every_match() {
        let ranges = literal_search_ranges("é 🦀 hit hit", "hit");
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].start_column, 6);
        assert_eq!(ranges[0].end_column, 9);
        assert_eq!(ranges[1].start_column, 10);
        assert!(literal_search_ranges("text", "").is_empty());
        assert!(search_range("🦀", 1, 2).is_none());
    }

    #[test]
    fn workspace_search_rg_returns_full_regex_matches() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("a:b.txt"), "é 🦀 needle needles\n").unwrap();
        let results =
            super::super::run_workspace_rg_search(workspace.path(), "need\\w+", None, 10, true)
                .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "a:b.txt");
        assert_eq!(results[0].ranges[0].start_column, 6);
        assert_eq!(results[0].ranges[0].end_column, 12);
        assert_eq!(results[0].ranges[1].end_column, 20);
    }
}
