//! Read-only adapters for local Claude Code and Codex conversation history.
//!
//! Provider transcripts are not a stable public format. Keep interpretation here,
//! apart from storage and execution, and never turn historical tools into actions.

mod claude;
mod codex;
mod transcript;

use crate::sessions::SessionEvent;
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_SCAN_FILES: usize = 10_000;
const MAX_SCAN_DIRECTORIES: usize = 20_000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    ClaudeCode,
    Codex,
}

impl SourceKind {
    pub fn provider_id(self) -> &'static str {
        match self {
            Self::ClaudeCode => "anthropic",
            Self::Codex => "openai",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
        }
    }

    pub fn cursor_kind(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-session",
            Self::Codex => "codex-session",
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImportScanRequest {
    pub claude_data_home: Option<String>,
    pub codex_data_home: Option<String>,
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImportSource {
    pub kind: SourceKind,
    pub label: String,
    pub data_home: String,
    pub available: bool,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImportCandidate {
    pub id: String,
    pub source_kind: SourceKind,
    pub source_session_id: String,
    pub data_home: String,
    pub transcript_path: String,
    pub workspace_path: String,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub model_id: Option<String>,
    pub archived: bool,
    pub workspace_available: bool,
    pub event_count: usize,
    pub diagnostics: Vec<String>,
    pub existing_session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImportScan {
    pub scan_id: String,
    pub sources: Vec<ProjectImportSource>,
    pub candidates: Vec<ProjectImportCandidate>,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct NormalizedProjectImport {
    pub candidate: ProjectImportCandidate,
    pub events: Vec<SessionEvent>,
    pub diagnostics: Vec<String>,
}

/// Resolve source homes without enumerating transcripts or reading credentials.
pub fn get_project_import_sources(
    request: &ProjectImportScanRequest,
) -> Result<Vec<ProjectImportSource>> {
    let user_home = dirs::home_dir().ok_or_else(|| anyhow!("Cannot find your home folder"))?;
    let resolve = |chosen: &Option<String>, env_name: &str, default: &str| {
        let override_path = chosen.as_deref().filter(|value| !value.trim().is_empty());
        let environment_path = std::env::var_os(env_name).filter(|value| !value.is_empty());
        let path = override_path
            .map(PathBuf::from)
            .or_else(|| environment_path.map(PathBuf::from))
            .unwrap_or_else(|| user_home.join(default));
        if !path.is_absolute() {
            return Err(anyhow!("The provider data folder must be an absolute path"));
        }
        Ok(path)
    };
    [
        (
            SourceKind::ClaudeCode,
            resolve(&request.claude_data_home, "CLAUDE_CONFIG_DIR", ".claude")?,
        ),
        (
            SourceKind::Codex,
            resolve(&request.codex_data_home, "CODEX_HOME", ".codex")?,
        ),
    ]
    .into_iter()
    .map(|(kind, path)| {
        let available = match kind {
            SourceKind::ClaudeCode => path.join("projects").is_dir(),
            SourceKind::Codex => {
                path.join("sessions").is_dir()
                    || (request.include_archived && path.join("archived_sessions").is_dir())
            }
        };
        Ok(ProjectImportSource {
            kind,
            label: kind.label().into(),
            data_home: path.to_string_lossy().into_owned(),
            available,
            detail: (!available).then(|| "No local conversation folder found".into()),
        })
    })
    .collect()
}

pub fn discover_project_imports(request: ProjectImportScanRequest) -> Result<ProjectImportScan> {
    let sources = get_project_import_sources(&request)?;
    let mut candidates = Vec::new();
    let mut diagnostics = Vec::new();
    let mut seen = HashSet::new();
    for source in &sources {
        if !source.available {
            continue;
        }
        let home = Path::new(&source.data_home);
        let roots = match source.kind {
            SourceKind::ClaudeCode => vec![(home.join("projects"), false, 2)],
            SourceKind::Codex => {
                let mut roots = vec![(home.join("sessions"), false, 5)];
                if request.include_archived {
                    roots.push((home.join("archived_sessions"), true, 5));
                }
                roots
            }
        };
        for (root, archived, depth) in roots {
            if !root.is_dir() {
                continue;
            }
            let files = transcript_files(&root, depth, &mut diagnostics)?;
            for path in files {
                match read_candidate(source.kind, home, &path, archived) {
                    Ok(Some(import)) => {
                        let key = (source.kind, import.candidate.source_session_id.clone());
                        // Active copies are preferred to archived copies of the same chat.
                        if seen.insert(key) {
                            candidates.push(import.candidate);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => diagnostics.push(format!(
                        "{}: {} ({})",
                        source.label,
                        error,
                        path.file_name().unwrap_or_default().to_string_lossy()
                    )),
                }
            }
        }
    }
    candidates.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(ProjectImportScan {
        scan_id: Uuid::new_v4().to_string(),
        sources,
        candidates,
        diagnostics,
    })
}

/// Re-read a backend-issued candidate at import time, so an evolving source is
/// snapshotted then. Identity and workspace changes require a new scan.
pub fn normalize_project_import(
    candidate: &ProjectImportCandidate,
) -> Result<NormalizedProjectImport> {
    let mut import = read_candidate(
        candidate.source_kind,
        Path::new(&candidate.data_home),
        Path::new(&candidate.transcript_path),
        candidate.archived,
    )?
    .ok_or_else(|| anyhow!("This file no longer contains a supported conversation"))?;
    if import.candidate.source_session_id != candidate.source_session_id
        || import.candidate.workspace_path != candidate.workspace_path
    {
        return Err(anyhow!(
            "The conversation changed since scanning. Scan projects again"
        ));
    }
    import.candidate.id = candidate.id.clone();
    import.candidate.existing_session_id = candidate.existing_session_id.clone();
    Ok(import)
}

fn read_candidate(
    kind: SourceKind,
    home: &Path,
    path: &Path,
    archived: bool,
) -> Result<Option<NormalizedProjectImport>> {
    let home = home
        .canonicalize()
        .context("Provider data folder is unavailable")?;
    let path = path
        .canonicalize()
        .context("Conversation file is unavailable")?;
    let allowed_root = home.join(match (kind, archived) {
        (SourceKind::ClaudeCode, _) => "projects",
        (SourceKind::Codex, true) => "archived_sessions",
        (SourceKind::Codex, false) => "sessions",
    });
    // No credentials or files outside the provider's known transcript roots.
    if !path.starts_with(&allowed_root) || path.extension().map_or(true, |value| value != "jsonl") {
        return Err(anyhow!(
            "Conversation file is outside the provider history folder"
        ));
    }
    let transcript = transcript::read_transcript(&path)?;
    let parsed = match kind {
        SourceKind::ClaudeCode => claude::normalize(&transcript),
        SourceKind::Codex => codex::normalize(&transcript),
    }?;
    let Some(parsed) = parsed else {
        return Ok(None);
    };
    let mut diagnostics = transcript.diagnostics;
    diagnostics.extend(parsed.diagnostics);
    let candidate = ProjectImportCandidate {
        id: Uuid::new_v4().to_string(),
        source_kind: kind,
        source_session_id: parsed.session_id,
        data_home: home.to_string_lossy().into_owned(),
        transcript_path: path.to_string_lossy().into_owned(),
        workspace_available: Path::new(&parsed.workspace_path).is_dir(),
        workspace_path: parsed.workspace_path,
        title: parsed.title,
        created_at: parsed.created_at,
        updated_at: parsed.updated_at,
        model_id: parsed.model_id,
        archived,
        event_count: parsed.events.len(),
        diagnostics: diagnostics.clone(),
        existing_session_id: None,
    };
    Ok(Some(NormalizedProjectImport {
        candidate,
        events: parsed.events,
        diagnostics,
    }))
}

fn transcript_files(
    root: &Path,
    max_depth: usize,
    diagnostics: &mut Vec<String>,
) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut directories = 0;
    while let Some((directory, depth)) = pending.pop() {
        directories += 1;
        if directories > MAX_SCAN_DIRECTORIES {
            diagnostics.push(
                "Scan reached the folder limit; choose a more specific provider data folder".into(),
            );
            break;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                diagnostics.push(format!("Unable to read a conversation folder: {error}"));
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let file_type = entry.file_type()?;
            let path = entry.path();
            if file_type.is_dir() && depth < max_depth {
                // Claude subagent transcripts live in nested /subagents directories.
                if entry.file_name() != "subagents" {
                    pending.push((path, depth + 1));
                }
            } else if file_type.is_file() && path.extension().is_some_and(|value| value == "jsonl")
            {
                files.push(path);
                if files.len() >= MAX_SCAN_FILES {
                    diagnostics.push(
                        "Scan reached the conversation limit; import this batch before rescanning"
                            .into(),
                    );
                    return Ok(files);
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests;
