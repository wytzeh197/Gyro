use super::root_scope;
use crate::state::managers::ProviderCancellationManager;
use anyhow::{ensure, Result};
use gyro_core::{project_memory::confined_bytes, workflows::*, GyroConfig, SessionStore};
use std::{collections::HashSet, path::Path};
use tauri::Manager;
use uuid::Uuid;
pub(super) fn first_agent(definition: &WorkflowDefinition) -> Result<&str> {
    definition
        .steps
        .iter()
        .find_map(|step| match step {
            WorkflowStep::Agent { role, .. } => Some(role.as_str()),
            _ => None,
        })
        .ok_or_else(|| {
            anyhow::anyhow!(
                "This workflow runner requires an agent step with an explicit provider binding"
            )
        })
}
pub(crate) fn check(
    app: &tauri::AppHandle,
    store: &SessionStore,
    pinned: &WorkflowAutomationBinding,
    root: &Path,
    owned: &[Uuid],
    allow_busy: bool,
) -> Result<()> {
    pinned.binding.validate(&pinned.definition)?;
    let (_, _, authorized) = root_scope(
        store,
        &pinned.source_session_id.to_string(),
        Some(&pinned.root_id),
    )?;
    ensure!(authorized == root, "workflow root changed");
    let bytes = confined_bytes(
        root,
        &format!(".gyro/workflows/{}.json", pinned.definition.id),
        MAX_DEFINITION_BYTES,
    )?
    .ok_or_else(|| anyhow::anyhow!("workflow definition is no longer present"))?;
    ensure!(
        definition_hash(&parse_definition(&bytes)?)? == pinned.binding.definition_hash,
        "Workflow version changed. Review it and explicitly update the schedule's pinned version."
    );
    let config = GyroConfig::load(store.paths())?;
    for step in &pinned.definition.steps {
        match step {
            WorkflowStep::Agent { role, .. } | WorkflowStep::Review { role, .. } => {
                let binding = &pinned.binding.roles[role];
                let provider = config
                    .model_providers
                    .iter()
                    .find(|provider| provider.enabled && provider.id == binding.provider_id)
                    .ok_or_else(|| {
                        anyhow::anyhow!("Enable the explicitly bound provider for role {role}")
                    })?;
                if matches!(step, WorkflowStep::Review { .. }) {
                    crate::features::code_reviews::execution::validate_reviewer(
                        &config,
                        &binding.provider_id,
                        &binding.model_id,
                    )?;
                } else {
                    let adapter =
                        gyro_core::provider_runtime::api_config::provider_adapter_with_kind(
                            &binding.provider_id,
                            provider.kind.as_deref(),
                        );
                    ensure!(
                        crate::providers::runner::runner_for(adapter.kind).is_executable(),
                        "role {role} has an unavailable adapter"
                    );
                }
            }
            WorkflowStep::Verification { command_ref, .. } => {
                bound_task(root, &pinned.binding, command_ref)?;
            }
        }
    }
    if !allow_busy {
        ensure!(!checkout_busy(app,store,root,owned)?,"Another chat is active in this checkout. Stop it or use another authorized project root before running this workflow.");
    }
    Ok(())
}
pub(crate) fn checkout_busy(
    app: &tauri::AppHandle,
    store: &SessionStore,
    root: &Path,
    owned: &[Uuid],
) -> Result<bool> {
    let owned: HashSet<_> = owned.iter().copied().collect();
    if store
        .active_workflow_for_root(&root.to_string_lossy())?
        .is_some_and(|run| !owned.contains(&run.source_session_id))
    {
        return Ok(true);
    }
    let active: Vec<_> = app
        .state::<ProviderCancellationManager>()
        .flags
        .lock()
        .map_err(|_| anyhow::anyhow!("provider state is unavailable"))?
        .keys()
        .filter_map(|key| Uuid::parse_str(key).ok())
        .collect();
    let durable = store
        .list_running_turns()?
        .into_iter()
        .map(|(session, _)| session);
    for session in active.into_iter().chain(durable) {
        if owned.contains(&session) {
            continue;
        }
        if let Some(session) = store.get_session(session)? {
            if session.workspace_path.canonicalize().ok().as_deref() == Some(root) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
pub(super) fn bound_task(
    root: &Path,
    binding: &WorkflowBinding,
    id: &str,
) -> Result<crate::ide::types::TaskDefinitionResult> {
    super::tasks::bound(root, binding, id)
}
#[cfg(test)]
mod tests {
    use super::bound_task;
    use gyro_core::workflows::{WorkflowBinding, WorkflowCommandBinding};
    #[test]
    fn workflow_verification_requires_a_current_discovered_argv_not_a_shell_string() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("package.json"),
            r#"{"scripts":{"test":"node --test"}}"#,
        )
        .unwrap();
        let tasks =
            crate::ide::task_discovery::task_discover_impl(&temp.path().to_string_lossy()).unwrap();
        let task = tasks
            .into_iter()
            .find(|task| task.label.to_lowercase().contains("test"))
            .unwrap();
        let mut binding = WorkflowBinding {
            definition_id: "fixture".into(),
            definition_hash: "fixture".into(),
            roles: Default::default(),
            commands: std::collections::BTreeMap::from([(
                "test".into(),
                WorkflowCommandBinding {
                    task_id: None,
                    task_fingerprint: None,
                    program: task.command.clone(),
                    args: task.args.clone(),
                },
            )]),
            inputs: Default::default(),
        };
        let choices = super::super::tasks::choices(temp.path()).unwrap();
        let choice = choices
            .as_array()
            .unwrap()
            .iter()
            .find(|choice| choice["id"] == task.id)
            .unwrap();
        let command = binding.commands.get_mut("test").unwrap();
        command.task_id = Some(task.id.clone());
        command.task_fingerprint = choice["fingerprint"].as_str().map(str::to_string);
        assert!(bound_task(temp.path(), &binding, "test").is_ok());
        std::fs::write(
            temp.path().join("package.json"),
            r#"{"scripts":{"test":"node changed-test.js"}}"#,
        )
        .unwrap();
        assert!(bound_task(temp.path(), &binding, "test").is_err());
        std::fs::write(
            temp.path().join("package.json"),
            r#"{"scripts":{"test":"node --test"}}"#,
        )
        .unwrap();
        binding
            .commands
            .get_mut("test")
            .unwrap()
            .args
            .push("; touch stolen".into());
        assert!(bound_task(temp.path(), &binding, "test").is_err());
        binding.commands.get_mut("test").unwrap().args = task.args;
        std::fs::write(temp.path().join("package.json"), r#"{"scripts":{}}"#).unwrap();
        assert!(bound_task(temp.path(), &binding, "test").is_err());
    }
}
