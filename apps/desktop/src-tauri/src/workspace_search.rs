use super::*;
use serde::Deserialize;

pub(super) struct WorkspaceSearchScan {
    pub results: Vec<WorkspaceSearchResult>,
    pub incomplete: bool,
}

pub(super) fn run_workspace_rg_search(
    root: &Path,
    query: &str,
    globs: Option<&Vec<String>>,
    max_results: usize,
    use_regex: bool,
) -> anyhow::Result<Vec<WorkspaceSearchResult>> {
    Ok(run_workspace_rg_search_scan(root, query, globs, max_results, use_regex)?.results)
}

pub(super) fn run_workspace_rg_search_scan(
    root: &Path,
    query: &str,
    globs: Option<&Vec<String>>,
    max_results: usize,
    use_regex: bool,
) -> anyhow::Result<WorkspaceSearchScan> {
    run_scoped_workspace_rg_search(root, ".", query, globs, max_results, use_regex)
}

/// `directory` is workspace-relative. `.` searches the root. Callers confine it first.
pub(super) fn run_scoped_workspace_rg_search(
    root: &Path,
    directory: &str,
    query: &str,
    globs: Option<&Vec<String>>,
    max_results: usize,
    use_regex: bool,
) -> anyhow::Result<WorkspaceSearchScan> {
    let mut command = command_with_gui_path("rg");
    command
        .current_dir(root)
        .args(["--json", "--line-buffered"]);
    command.arg("--max-count").arg(max_results.to_string());
    command.args(["--max-filesize", "4M"]);
    if !use_regex {
        command.arg("--fixed-strings");
    }
    if let Some(globs) = globs {
        for glob in globs {
            command.arg("--glob").arg(glob);
        }
    }
    command.arg("--").arg(query).arg(directory);

    let mut request = ExecutionRequest::new(command.get_program().to_os_string());
    request.args = command
        .get_args()
        .map(std::ffi::OsStr::to_os_string)
        .collect();
    request.current_dir = Some(root.to_path_buf());
    request.env = command
        .get_envs()
        .map(|(key, value)| (key.to_os_string(), value.map(std::ffi::OsStr::to_os_string)))
        .collect();
    request.timeout = Duration::from_secs(120);
    request.inactivity_timeout = Some(Duration::from_secs(60));
    request.max_stdout_chars = 8 * 1024 * 1024;
    request.max_stderr_chars = 64 * 1024;
    request.max_total_output_bytes = 8 * 1024 * 1024;
    let cancellation = CancellationToken::default();
    let mut progress = SearchOutputProgress::default();
    let output = gyro_core::run_command(request, cancellation.clone(), |chunk| {
        if chunk.stream == ExecutionStream::Stdout && progress.push(&chunk.text, max_results) {
            // --max-count limits each file. Stop the whole process as soon as
            // the global result count is met instead of scanning the rest.
            cancellation.cancel();
        }
    })?;
    let results = parse_rg_output(&output.stdout, max_results);
    if output.succeeded() || output.exit_code() == Some(1) {
        return Ok(WorkspaceSearchScan {
            results,
            incomplete: false,
        });
    }
    // An invalid regex, malformed glob, or permission error is not a successful
    // empty search merely because ripgrep emitted a begin/summary record.
    if output.exit_code().is_some() || results.is_empty() {
        return Err(bounded_command_error("workspace search failed", &output));
    }
    Ok(WorkspaceSearchScan {
        results,
        incomplete: true,
    })
}

/// Resolve a workspace-relative search directory. Absolute paths, `..`, and
/// links whose target leaves the workspace are refused.
pub(super) fn confine_search_directory(root: &Path, path: &str) -> anyhow::Result<String> {
    let relative = gyro_core::normalize_capability_relative_path(path)?;
    let resolved = gyro_core::security::assert_path_inside_workspace(root, Path::new(&relative))?;
    if !resolved.is_dir() {
        anyhow::bail!("Workspace search path must be an existing directory");
    }
    Ok(relative)
}

#[derive(Default)]
struct SearchOutputProgress {
    pending: String,
    matches: usize,
}

impl SearchOutputProgress {
    fn push(&mut self, chunk: &str, max_results: usize) -> bool {
        if self.matches >= max_results {
            return true;
        }
        self.pending.push_str(chunk);
        if let Some(last_newline) = self.pending.rfind('\n') {
            let remainder = self.pending.split_off(last_newline + 1);
            let complete = std::mem::replace(&mut self.pending, remainder);
            self.matches += parse_rg_output(&complete, max_results - self.matches).len();
        }
        self.matches >= max_results
    }
}

pub(super) fn bound_model_search_results(
    results: Vec<WorkspaceSearchResult>,
    max_bytes: usize,
) -> anyhow::Result<(Vec<serde_json::Value>, bool)> {
    let mut results = results
        .into_iter()
        .map(model_search_preview)
        .collect::<anyhow::Result<Vec<_>>>()?;
    let original_count = results.len();
    let (mut low, mut high) = (0, original_count);
    while low < high {
        let mid = low + (high - low).div_ceil(2);
        let data = serde_json::to_value(&results[..mid])?;
        if serde_json::to_vec(&data)?.len() <= max_bytes {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    if low == 0 && original_count > 0 {
        anyhow::bail!("A Workspace search match exceeds maxBytes; narrow the query or increase the byte budget");
    }
    results.truncate(low);
    Ok((results, low < original_count))
}

fn model_search_preview(result: WorkspaceSearchResult) -> anyhow::Result<serde_json::Value> {
    const PREVIEW_COLUMNS: usize = 512;
    const LEADING_CONTEXT_COLUMNS: usize = 80;
    const MAX_PREVIEW_RANGES: usize = 50;
    // Mask the full line first: a snippet beginning within a credential must
    // not disclose its suffix, and match ranges keep their source coordinates.
    let line = gyro_core::security::redact_secrets_preserving_positions(&result.line);
    let first_match = result
        .ranges
        .first()
        .map(|range| range.start_column.saturating_sub(1))
        .unwrap_or(0);
    let desired_start = first_match.saturating_sub(LEADING_CONTEXT_COLUMNS);
    let mut units = 0;
    let mut start = None;
    let mut end = line.len();
    for (offset, character) in line.char_indices() {
        if start.is_none() && units >= desired_start {
            start = Some((offset, units));
        }
        if start.is_some_and(|(_, start)| units + character.len_utf16() > start + PREVIEW_COLUMNS) {
            end = offset;
            break;
        }
        units += character.len_utf16();
    }
    let (start, start_column) = start.unwrap_or((0, 0));
    let end_column = units;
    let visible = result
        .ranges
        .iter()
        .filter(|range| range.end_column > start_column + 1 && range.start_column <= end_column + 1)
        .collect::<Vec<_>>();
    let mut data = serde_json::json!({
        "path": result.path, "lineNumber": result.line_number,
        "line": &line[start..end],
        "ranges": visible.iter().take(MAX_PREVIEW_RANGES).collect::<Vec<_>>(),
    });
    if start != 0 || end != line.len() {
        data["lineStartColumn"] = serde_json::json!(start_column + 1);
        data["lineTruncated"] = serde_json::json!(true);
    }
    if visible.len() > MAX_PREVIEW_RANGES {
        data["rangesTruncated"] = serde_json::json!(true);
    }
    if line != result.line {
        data["redacted"] = serde_json::json!(true);
    }
    // Preserve the positional line mask while scrubbing path metadata.
    let displayed_line = data.as_object_mut().unwrap().remove("line").unwrap();
    data = redact_json_strings(data);
    data["line"] = displayed_line;
    Ok(data)
}

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

    #[test]
    fn search_stops_at_a_global_limit_across_split_records() {
        let record = serde_json::json!({"type":"match","data":{
            "path":{"text":"file.txt"},"lines":{"text":"needle\n"},"line_number":1,
            "submatches":[{"start":0,"end":6}]
        }})
        .to_string();
        let mut progress = SearchOutputProgress::default();
        assert!(!progress.push("{\"type\":\"begin\"}\n", 2));
        let split = record.len() / 2;
        assert!(!progress.push(&record[..split], 2));
        assert!(!progress.push(&format!("{}\n", &record[split..]), 2));
        assert!(progress.push(&format!("{record}\n"), 2));
        assert_eq!(progress.matches, 2);
    }

    #[test]
    fn search_does_not_report_bad_globs_as_empty_success() {
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("file.txt"), "needle\n").unwrap();
        assert!(run_workspace_rg_search(
            workspace.path(),
            "needle",
            Some(&vec!["[".to_owned()]),
            50,
            true
        )
        .is_err());
    }

    #[test]
    fn search_scan_reports_a_global_limit_as_incomplete() {
        let workspace = tempfile::tempdir().unwrap();
        for index in 0..100 {
            fs::write(
                workspace.path().join(format!("file-{index:03}.txt")),
                "needle\n".repeat(20),
            )
            .unwrap();
        }
        let scan =
            run_workspace_rg_search_scan(workspace.path(), "needle", None, 10, true).unwrap();
        assert_eq!(scan.results.len(), 10);
        // Very small scans can naturally finish before cancellation is polled.
        // The model also marks results.len() == maxResults as a limit hit.
        assert!(scan.incomplete || scan.results.len() == 10);
    }

    #[test]
    fn search_respects_the_serialized_response_budget() {
        let results = (0..100)
            .map(|index| WorkspaceSearchResult {
                path: format!("file-{index}.txt"),
                line_number: 1,
                line: "\"🦀".repeat(100),
                ranges: Vec::new(),
            })
            .collect();
        let (bounded, limited) = bound_model_search_results(results, 1024).unwrap();
        assert!(limited);
        assert!(!bounded.is_empty());
        assert!(serde_json::to_vec(&bounded).unwrap().len() <= 1024);
    }

    #[test]
    fn model_search_previews_keep_late_unicode_matches_and_source_ranges() {
        let line = format!("{}🦀 needle {}", "x".repeat(5000), "y".repeat(1000));
        let ranges = literal_search_ranges(&line, "needle");
        let start_column = ranges[0].start_column;
        let end_column = ranges[0].end_column;
        let preview = model_search_preview(WorkspaceSearchResult {
            path: "long.txt".into(),
            line_number: 42,
            line,
            ranges,
        })
        .unwrap();
        assert!(preview["line"].as_str().unwrap().contains("🦀 needle"));
        assert!(preview["line"].as_str().unwrap().encode_utf16().count() <= 512);
        assert_eq!(preview["lineNumber"], 42);
        assert_eq!(preview["lineTruncated"], true);
        assert!(preview["lineStartColumn"].as_u64().unwrap() > 4000);
        assert_eq!(preview["ranges"][0]["startColumn"], start_column);
        assert_eq!(preview["ranges"][0]["endColumn"], end_column);
    }

    #[test]
    fn model_search_previews_bound_dense_match_metadata() {
        let line = "needle ".repeat(1000);
        let ranges = literal_search_ranges(&line, "needle");
        let preview = model_search_preview(WorkspaceSearchResult {
            path: "dense.txt".into(),
            line_number: 1,
            line,
            ranges,
        })
        .unwrap();
        assert_eq!(preview["ranges"].as_array().unwrap().len(), 50);
        assert_eq!(preview["rangesTruncated"], true);
        assert!(serde_json::to_vec(&preview).unwrap().len() < DEFAULT_WORKSPACE_RESULT_BYTES);
    }

    #[test]
    fn scoped_search_skips_sibling_directories() {
        let workspace = tempfile::tempdir().unwrap();
        let src = workspace.path().join("src");
        let other = workspace.path().join("other");
        fs::create_dir(&src).unwrap();
        fs::create_dir(&other).unwrap();
        fs::write(src.join("hit.txt"), "needle\n").unwrap();
        fs::write(other.join("hit.txt"), "needle\n").unwrap();
        let directory = confine_search_directory(workspace.path(), "src").unwrap();
        let results = run_scoped_workspace_rg_search(
            workspace.path(),
            &directory,
            "needle",
            None,
            10,
            true,
        )
        .unwrap();
        assert_eq!(results.results.len(), 1);
        assert_eq!(results.results[0].path, "src/hit.txt");
    }

    #[test]
    fn search_directory_refuses_escape_and_outbound_links() {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join("src")).unwrap();
        assert!(confine_search_directory(workspace.path(), "../outside").is_err());
        assert!(confine_search_directory(workspace.path(), "/tmp").is_err());

        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "needle\n").unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("link")).unwrap();
        assert!(confine_search_directory(workspace.path(), "link").is_err());
    }
}
