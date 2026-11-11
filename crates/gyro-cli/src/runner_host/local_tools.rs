//! Headless workspace tools. The catalog exposes only implemented operations.
#[path = "memory_tools.rs"]
mod memory_tools;
use super::CliRunnerHost;
use anyhow::{anyhow, ensure, Context, Result};
use gyro_core::provider_runtime::catalog::ToolCatalog;
use gyro_core::{CapabilityId, CapabilityResponse, CapabilityResult, CapabilityRunMode};
use serde_json::{json, Value};
#[cfg(unix)]
use std::path::Component;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(super) struct CliToolCatalog;
pub(super) static CATALOG: CliToolCatalog = CliToolCatalog;
const FILE_BYTES: usize = 1024 * 1024;
const RESULT_BYTES: usize = 48 * 1024;
fn supported(id: CapabilityId) -> bool {
    if !cfg!(unix) {
        return false;
    }
    matches!(
        id,
        CapabilityId::WorkspaceList
            | CapabilityId::WorkspaceRead
            | CapabilityId::WorkspaceReadRange
            | CapabilityId::WorkspaceProposeEdit
            | CapabilityId::MemoryRead
            | CapabilityId::MemoryWrite
    )
}
impl ToolCatalog for CliToolCatalog {
    fn descriptors(
        &self,
        mode: CapabilityRunMode,
    ) -> Box<dyn Iterator<Item = &'static gyro_core::CapabilityDescriptor> + '_> {
        Box::new(gyro_core::advertised_capability_descriptors(mode).filter(|d| supported(d.id)))
    }
    fn observation_byte_limit(&self, args: &Value) -> Result<usize> {
        Ok(args
            .get("maxBytes")
            .and_then(Value::as_u64)
            .unwrap_or(RESULT_BYTES as u64)
            .clamp(1024, RESULT_BYTES as u64) as usize)
    }
    fn schema(&self, id: CapabilityId) -> Value {
        if let Some(schema) = memory_tools::schema(id) {
            return schema;
        }
        let (props, required) = match id {
            CapabilityId::WorkspaceList => (
                json!({"path":{"type":"string","description":"Workspace-relative directory, default root. Symlinks are not traversed."},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":200},"maxBytes":{"type":"integer","minimum":1024,"maximum":RESULT_BYTES}}),
                vec![],
            ),
            CapabilityId::WorkspaceRead | CapabilityId::WorkspaceReadRange => (
                json!({"path":{"type":"string","description":"Workspace-relative UTF-8 file, at most 1 MiB, or a spill:// address quoted by a result in this turn."},"line":{"type":"integer","minimum":1},"endLine":{"type":"integer","minimum":1},"offset":{"type":"integer","minimum":0},"maxBytes":{"type":"integer","minimum":1024,"maximum":RESULT_BYTES}}),
                vec!["path"],
            ),
            CapabilityId::WorkspaceProposeEdit => (
                json!({"path":{"type":"string","description":"Workspace-relative file path."},"content":{"type":"string","description":"Complete desired file content."},"expectedHash":{"type":"string","description":"Required for existing files: contentHash from a prior read."}}),
                vec!["path", "content"],
            ),
            _ => (json!({}), vec![]),
        };
        json!({"type":"object","properties":props,"required":required,"additionalProperties":false})
    }
}

fn relative_path(args: &Value, allow_root: bool) -> Result<PathBuf> {
    let raw = args["path"]
        .as_str()
        .unwrap_or(if allow_root { "." } else { "" });
    if allow_root && (raw == "." || raw.is_empty()) {
        return Ok(PathBuf::new());
    }
    let normalized = gyro_core::normalize_capability_relative_path(raw)?;
    ensure!(
        !gyro_core::capability_path_is_sensitive(&normalized),
        "sensitive workspace paths are not exposed by the headless file tools"
    );
    Ok(normalized.into())
}

/// Open from an owned workspace directory descriptor. Every path component is
/// checked by openat with O_NOFOLLOW so an intermediate symlink cannot redirect
/// a read after path validation. The file descriptor remains the read authority.
#[cfg(unix)]
fn confined_open(workspace: &Path, relative: &Path, directory: bool) -> Result<fs::File> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        },
    };
    let mut current = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(workspace)?;
    let components = relative.components().collect::<Vec<_>>();
    for (index, part) in components.iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err(anyhow!("invalid workspace path component"));
        };
        let name = CString::new(name.as_bytes())?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | if directory || index + 1 < components.len() {
                libc::O_DIRECTORY
            } else {
                0
            };
        let fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error()).context("open confined workspace path");
        }
        current = unsafe { fs::File::from_raw_fd(fd) };
    }
    Ok(current)
}
#[cfg(not(unix))]
fn confined_open(_workspace: &Path, _relative: &Path, _directory: bool) -> Result<fs::File> {
    Err(anyhow!(
        "headless workspace tools require descriptor-confined file access on this platform"
    ))
}

fn file_text(workspace: &Path, relative: &Path) -> Result<String> {
    let file = confined_open(workspace, relative, false)?;
    ensure!(
        file.metadata()?.is_file(),
        "workspace path is not a regular file"
    );
    let mut bytes = Vec::new();
    file.take((FILE_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= FILE_BYTES && !bytes.contains(&0),
        "workspace text file exceeds the 1 MiB limit or contains binary data"
    );
    String::from_utf8(bytes).context("workspace file is not UTF-8")
}
fn hash(text: &str) -> String {
    gyro_core::mutations::content_hash(text.as_bytes())
}

pub(super) fn invoke(
    host: &CliRunnerHost,
    id: CapabilityId,
    args: Value,
) -> Result<CapabilityResponse> {
    let call = Uuid::new_v4();
    let result = (|| -> Result<Value> {
        ensure!(supported(id), "tool is unavailable in this terminal host");
        ensure!(
            CATALOG.descriptors(host.request_mode).any(|d| d.id == id),
            "tool is unavailable in this run mode"
        );
        gyro_core::provider_runtime::catalog::validate_compatibility_schema_value(
            &args,
            &CATALOG.schema(id),
            "arguments",
        )?;
        host.ensure_active()?;
        let descriptor = gyro_core::capability_descriptor(id);
        let store = host.store()?;
        let policy = store
            .get_project_capability_policy(&host.session.workspace_path.to_string_lossy())?
            .with_missing_classes_defaulted();
        ensure!(
            policy.access_for(descriptor.class) != gyro_core::CapabilityAccess::Deny,
            "project policy denies this capability"
        );
        if id != CapabilityId::WorkspaceProposeEdit
            && policy.access_for(descriptor.class) == gyro_core::CapabilityAccess::Ask
        {
            ensure!(
                host.confirm(
                    "command",
                    &json!({"capabilityId":id,"arguments":args}),
                    true
                )?,
                "capability approval was declined"
            );
        }
        if matches!(
            id,
            CapabilityId::WorkspaceRead | CapabilityId::WorkspaceReadRange
        ) {
            if let Some(address) = args["path"]
                .as_str()
                .filter(|p| gyro_core::efficiency::spill::is_address(p))
            {
                let text = host
                    .spill_copies
                    .lock()
                    .map_err(|_| anyhow!("spill ownership unavailable"))?
                    .get(address)
                    .cloned()
                    .ok_or_else(|| anyhow!("spill address was not returned in this turn"))?;
                let mut start =
                    usize::try_from(args["offset"].as_u64().unwrap_or(0))?.min(text.len());
                while !text.is_char_boundary(start) {
                    start -= 1;
                }
                let mut end = start.saturating_add(2000).min(text.len());
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                return Ok(
                    json!({"source":"spill","path":address,"content":text[start..end],"offset":start,"nextOffset":(end<text.len()).then_some(end),"totalBytes":text.len(),"truncated":end<text.len()}),
                );
            }
        }
        if matches!(id, CapabilityId::MemoryRead | CapabilityId::MemoryWrite) {
            return memory_tools::invoke(host, id, &args);
        }
        let relative = relative_path(&args, id == CapabilityId::WorkspaceList)?;
        let budget = CATALOG.observation_byte_limit(&args)?;
        if host
            .paths
            .base_dir
            .starts_with(&host.session.workspace_path)
        {
            ensure!(
                !host
                    .session
                    .workspace_path
                    .join(&relative)
                    .starts_with(&host.paths.base_dir),
                "Gyro private data is outside the workspace tool authority"
            );
        }
        match id {
            CapabilityId::WorkspaceList => {
                let directory = confined_open(&host.session.workspace_path, &relative, true)?;
                let mut entries = Vec::new();
                for (name, kind) in directory_entries(&directory, 5001)? {
                    let path = relative.join(&name).to_string_lossy().replace('\\', "/");
                    if host
                        .session
                        .workspace_path
                        .join(&path)
                        .starts_with(&host.paths.base_dir)
                        || gyro_core::capability_path_is_sensitive(&path)
                    {
                        continue;
                    }
                    entries.push(json!({"path":path,"kind":kind}));
                }
                entries.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
                let offset = args["offset"].as_u64().unwrap_or(0) as usize;
                let limit = args["limit"].as_u64().unwrap_or(100) as usize;
                let total = entries.len();
                let mut selected = Vec::new();
                for entry in entries.into_iter().skip(offset).take(limit) {
                    selected.push(entry);
                    if serde_json::to_vec(&selected)?.len() > budget / 2 {
                        selected.pop();
                        break;
                    }
                }
                let next = offset.saturating_add(selected.len());
                Ok(
                    json!({"entries":selected,"totalObserved":total,"incomplete":total>=5000,"nextOffset":(next<total).then_some(next)}),
                )
            }
            CapabilityId::WorkspaceRead | CapabilityId::WorkspaceReadRange => {
                let text = file_text(&host.session.workspace_path, &relative)?;
                let lines = text.split_inclusive('\n').collect::<Vec<_>>();
                let line = args["line"].as_u64().unwrap_or(1) as usize;
                let end = args["endLine"]
                    .as_u64()
                    .unwrap_or(line.saturating_add(199) as u64) as usize;
                ensure!(
                    end >= line && end - line < 2000,
                    "read range must contain at most 2000 lines"
                );
                let mut content = String::new();
                let mut count = 0;
                for value in lines.iter().skip(line - 1).take(end - line + 1) {
                    if content.len() + value.len() > budget / 2 {
                        ensure!(
                            !content.is_empty(),
                            "requested line exceeds the observation budget"
                        );
                        break;
                    }
                    content.push_str(value);
                    count += 1;
                }
                let next = line.saturating_add(count);
                Ok(
                    json!({"path":relative,"content":gyro_core::security::redact_secrets(&content),"contentHash":hash(&text),"line":line,"endLine":next.saturating_sub(1),"totalLines":lines.len(),"truncated":next<=lines.len(),"nextLine":(next<=lines.len()).then_some(next)}),
                )
            }
            CapabilityId::WorkspaceProposeEdit => {
                ensure!(
                    host.request_mode == CapabilityRunMode::Normal,
                    "file changes are disabled in this mode"
                );
                let target = host.session.workspace_path.join(&relative);
                let base = match file_text(&host.session.workspace_path, &relative) {
                    Ok(text) => Some(text),
                    Err(error) if !target.exists() => {
                        let _ = error;
                        None
                    }
                    Err(error) => return Err(error),
                };
                let expected = args["expectedHash"].as_str().map(str::to_owned);
                if let Some(current) = base.as_ref() {
                    ensure!(expected.as_deref()==Some(hash(current).as_str()),"existing file requires its current contentHash; read it again before proposing an edit");
                }
                let proposal = store.create_mutation_proposal(
                    host.session.id,
                    Some(host.turn),
                    relative.to_string_lossy(),
                    args["content"]
                        .as_str()
                        .ok_or_else(|| anyhow!("content is required"))?,
                    expected,
                    base.is_some(),
                )?;
                store.append_event_with_turn_id(
                    host.session.id,
                    gyro_core::SessionEventKind::FileEditProposed,
                    "CLI workspace edit proposed.",
                    json!({"proposalId":proposal.id,"path":proposal.path}),
                    Some(host.turn),
                )?;
                let approved = host.confirm_file_proposal(&proposal)?;
                let result = gyro_core::decide_mutation_proposal_with_cancellation(
                    &store,
                    proposal.id,
                    if approved {
                        gyro_core::MutationDecision::Approve
                    } else {
                        gyro_core::MutationDecision::Reject
                    },
                    || host.cancellation.is_cancelled(),
                )?;
                Ok(
                    json!({"proposalId":proposal.id,"path":proposal.path,"status":result.proposal.status,"applied":result.proposal.status==gyro_core::MutationProposalStatus::Applied}),
                )
            }
            _ => unreachable!(),
        }
    })();
    if let Ok(data) = &result {
        let mut allowed = host
            .spill_copies
            .lock()
            .map_err(|_| anyhow!("spill ownership unavailable"))?;
        for field in ["content", "stdout", "stderr", "output", "text"] {
            if let Some(text) = data[field].as_str() {
                if text.len() >= gyro_core::efficiency::spill::SPILL_MIN_BYTES
                    && allowed.len() < 512
                    && text.len() <= RESULT_BYTES
                {
                    allowed.insert(
                        gyro_core::efficiency::spill::address(
                            id.as_str(),
                            id.provider_tool_name(),
                            text,
                        ),
                        text.to_owned(),
                    );
                }
            }
        }
    }
    let response = match result {
        Ok(data) => CapabilityResponse::completed(
            env!("CARGO_PKG_VERSION"),
            CapabilityResult {
                call_id: call,
                capability_id: id,
                summary: "Terminal workspace tool completed.".into(),
                data,
                resource: None,
            },
        ),
        Err(error) => CapabilityResponse::failed(
            env!("CARGO_PKG_VERSION"),
            call,
            "cli-tool-rejected",
            gyro_core::security::redact_secrets(&error.to_string()),
        ),
    };
    host.store()?.append_event_with_turn_id(host.session.id,gyro_core::SessionEventKind::SystemEvent,"CLI capability result.",json!({"schema":gyro_core::CAPABILITY_SCHEMA_V1,"kind":"capability-result","capabilityId":id,"callId":call,"status":response.status}),Some(host.turn))?;
    Ok(response)
}

#[cfg(unix)]
fn directory_entries(directory: &fs::File, limit: usize) -> Result<Vec<(String, &'static str)>> {
    use std::{ffi::CStr, os::fd::AsRawFd};
    struct Directory(*mut libc::DIR);
    impl Drop for Directory {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let duplicate = unsafe { libc::dup(directory.as_raw_fd()) };
    if duplicate < 0 {
        return Err(std::io::Error::last_os_error()).context("duplicate workspace directory");
    }
    let raw = unsafe { libc::fdopendir(duplicate) };
    if raw.is_null() {
        let error = std::io::Error::last_os_error();
        unsafe {
            libc::close(duplicate);
        }
        return Err(error).context("open workspace directory entries");
    }
    let directory = Directory(raw);
    let mut entries = Vec::new();
    while entries.len() < limit {
        let next = unsafe { libc::readdir(directory.0) };
        if next.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*next).d_name.as_ptr()) };
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::fstatat(
                libc::dirfd(directory.0),
                name.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error()).context("inspect workspace entry");
        }
        let kind = match stat.st_mode & libc::S_IFMT {
            libc::S_IFLNK => "symlink",
            libc::S_IFDIR => "directory",
            libc::S_IFREG => "file",
            _ => "special",
        };
        entries.push((name.to_string_lossy().into_owned(), kind));
    }
    Ok(entries)
}
#[cfg(not(unix))]
fn directory_entries(_directory: &fs::File, _limit: usize) -> Result<Vec<(String, &'static str)>> {
    Err(anyhow!(
        "headless directory access is unavailable on this platform"
    ))
}
