use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

pub const MAX_METADATA_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryKind {
    Decision,
    Convention,
    Command,
    OpenProblem,
    #[default]
    Note,
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryStatus {
    #[default]
    Active,
    Superseded,
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum MemorySource {
    ProjectFile {
        path: String,
        #[serde(rename = "contentHash")]
        content_hash: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lines: Option<[u32; 2]>,
    },
    Commit {
        oid: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    UserEntered,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemoryMetadata {
    pub v: u8,
    pub id: String,
    #[serde(default)]
    pub kind: MemoryKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<MemorySource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    /// Detect external text changes before reusing portable provenance.
    #[serde(default, rename = "textHash", skip_serializing_if = "Option::is_none")]
    pub text_hash: Option<String>,
}

pub fn valid_memory_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn validate_relative_path(path: &str) -> Result<()> {
    ensure!(
        path.len() <= 1024 && !path.contains(['\\', ':']) && !path.chars().any(char::is_control),
        "invalid memory source path"
    );
    let normalized = crate::normalize_capability_relative_path(path)?;
    ensure!(
        normalized == path && !crate::capability_path_is_sensitive(path),
        "memory paths must be non-sensitive workspace-relative paths"
    );
    Ok(())
}

pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

impl MemoryMetadata {
    pub fn validate(&self) -> Result<()> {
        ensure!(self.v == 2, "unsupported memory metadata version");
        ensure!(valid_memory_id(&self.id), "invalid managed memory ID");
        ensure!(
            self.paths.len() <= 16 && self.sources.len() <= 8,
            "too many memory paths or sources"
        );
        for path in &self.paths {
            validate_relative_path(path)?;
        }
        if let Some(id) = &self.supersedes {
            ensure!(
                valid_memory_id(id) && id != &self.id,
                "invalid memory supersession"
            );
        }
        if let Some(hash) = &self.text_hash {
            ensure!(valid_hash(hash), "invalid memory text hash");
        }
        for source in &self.sources {
            match source {
                MemorySource::ProjectFile {
                    path,
                    content_hash,
                    lines,
                } => {
                    validate_relative_path(path)?;
                    ensure!(valid_hash(content_hash), "invalid source content hash");
                    if let Some([start, end]) = lines {
                        ensure!(*start > 0 && end >= start, "invalid memory source lines");
                    }
                }
                MemorySource::Commit { oid, path } => {
                    ensure!(
                        [40, 64].contains(&oid.len()) && oid.bytes().all(|b| b.is_ascii_hexdigit()),
                        "commit source must use a full object ID"
                    );
                    if let Some(path) = path {
                        validate_relative_path(path)?;
                    }
                }
                MemorySource::UserEntered => {}
            }
        }
        ensure!(
            serde_json::to_vec(self)?.len() <= MAX_METADATA_BYTES,
            "memory metadata exceeds its size limit"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDiagnostic {
    pub entry_id: Option<String>,
    pub line: usize,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryDraft {
    pub text: String,
    #[serde(default)]
    pub kind: MemoryKind,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub sources: Vec<MemorySource>,
    #[serde(default)]
    pub supersedes: Option<String>,
}
