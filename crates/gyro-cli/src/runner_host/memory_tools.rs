use super::super::CliRunnerHost;
use anyhow::{ensure, Result};
use gyro_core::{
    project_memory::{
        plan_write, read_project_memory, MemoryDocument, MemoryStatus, MemoryWrite, MEMORY_PATH,
    },
    CapabilityId,
};
use serde_json::{json, Value};

pub(super) fn schema(id: CapabilityId) -> Option<Value> {
    let (properties, required) = match id {
        CapabilityId::MemoryRead => (
            json!({"query":{"type":"string","maxLength":512},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":200},"raw":{"type":"boolean"},"maxBytes":{"type":"integer","minimum":1024,"maximum":49152}}),
            vec![],
        ),
        CapabilityId::MemoryWrite => (
            json!({"action":{"type":"string","enum":["append","forget"]},"text":{"type":"string"},"match":{"type":"string"}}),
            vec!["action"],
        ),
        _ => return None,
    };
    Some(
        json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
    )
}

pub(super) fn invoke(host: &CliRunnerHost, id: CapabilityId, args: &Value) -> Result<Value> {
    let workspace = &host.session.workspace_path;
    ensure!(
        !workspace.starts_with(&host.paths.base_dir.canonicalize()?),
        "private scratch workspaces do not have project memory"
    );
    let source = read_project_memory(workspace)?;
    let document = MemoryDocument::parse(source.as_deref().unwrap_or_default())?;
    if id == CapabilityId::MemoryRead {
        let budget = args["maxBytes"]
            .as_u64()
            .unwrap_or(16 * 1024)
            .clamp(1024, 49152) as usize;
        if args["raw"].as_bool() == Some(true) {
            let offset = args["offset"]
                .as_u64()
                .unwrap_or(0)
                .min(document.source().len() as u64) as usize;
            let mut start = offset;
            while !document.source().is_char_boundary(start) {
                start -= 1;
            }
            let mut end = start
                .saturating_add(budget / 2)
                .min(document.source().len());
            while !document.source().is_char_boundary(end) {
                end -= 1;
            }
            return Ok(
                json!({"schema":"gyro.memory.v1","path":MEMORY_PATH,"exists":source.is_some(),"raw":&document.source()[start..end],"offset":start,"nextOffset":(end<document.source().len()).then_some(end),"truncated":end<document.source().len()}),
            );
        }
        let query = args["query"].as_str().unwrap_or_default().to_lowercase();
        let entries: Vec<_> = document
            .entries
            .iter()
            .filter(|entry| {
                entry.status != MemoryStatus::Invalid
                    && (query.is_empty() || entry.text.to_lowercase().contains(&query))
            })
            .collect();
        let offset = args["offset"]
            .as_u64()
            .unwrap_or(0)
            .min(entries.len() as u64) as usize;
        let limit = args["limit"].as_u64().unwrap_or(20).min(200) as usize;
        let mut selected = Vec::new();
        for entry in entries.iter().skip(offset).take(limit) {
            selected.push(
                json!({"id":entry.id,"date":entry.date,"text":entry.text,"status":entry.status}),
            );
            if serde_json::to_vec(&selected)?.len() > budget / 2 {
                selected.pop();
                break;
            }
        }
        let next = offset + selected.len();
        return Ok(
            json!({"schema":"gyro.memory.v1","path":MEMORY_PATH,"exists":source.is_some(),"total":entries.len(),"entries":selected,"offset":offset,"nextOffset":(next<entries.len()).then_some(next),"diagnostics":document.diagnostics.len()}),
        );
    }
    ensure!(
        host.request_mode == gyro_core::CapabilityRunMode::Normal,
        "memory writes are disabled in this mode"
    );
    let store = host.store()?;
    let policy = store
        .get_project_capability_policy(&workspace.to_string_lossy())?
        .with_missing_classes_defaulted();
    ensure!(
        policy.access_for(gyro_core::CapabilityClass::WorkspaceWrite)
            != gyro_core::CapabilityAccess::Deny,
        "project policy denies memory changes"
    );
    let date = gyro_core::project_memory::today();
    let operation = match args["action"].as_str() {
        Some("append") => MemoryWrite::Append {
            date: &date,
            text: args["text"].as_str().unwrap_or_default(),
        },
        Some("forget") => MemoryWrite::Forget {
            needle: args["match"].as_str().unwrap_or_default(),
        },
        _ => anyhow::bail!("memory action must be append or forget"),
    };
    let expected = source.as_ref().map(|_| document.document_hash.as_str());
    let plan = plan_write(source.as_deref(), expected, operation)?;
    let directory = workspace.join(".gyro");
    if !directory.exists() {
        std::fs::create_dir(&directory)?;
    }
    // Prove the directory was not replaced by a symlink before proposing.
    let current = read_project_memory(workspace)?;
    ensure!(current == source, "project memory changed on disk; reload");
    let proposal = store.create_mutation_proposal(
        host.session.id,
        Some(host.turn),
        MEMORY_PATH,
        &plan.content,
        plan.expected_hash,
        source.is_some(),
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
        json!({"schema":"gyro.memory.v1","path":MEMORY_PATH,"proposalId":proposal.id,"status":result.proposal.status,"applied":result.proposal.status==gyro_core::MutationProposalStatus::Applied}),
    )
}
