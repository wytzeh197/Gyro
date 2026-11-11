use super::{
    Automation, AutomationSchedule, AutomationStatus, AutomationStore, CreateAutomationRequest,
};
use anyhow::{ensure, Result};
use uuid::Uuid;
pub(super) fn collect_supported_automations(
    rows: impl IntoIterator<Item = rusqlite::Result<Automation>>,
) -> Result<Vec<Automation>> {
    let mut supported = Vec::new();
    for row in rows {
        match row{Ok(automation)=>supported.push(automation),Err(rusqlite::Error::FromSqlConversionFailure(..)|rusqlite::Error::InvalidColumnType(..))=>eprintln!("Skipped an automation whose stored configuration is unavailable in this build; its record was preserved"),Err(error)=>return Err(error.into())}
    }
    Ok(supported)
}
pub(super) fn validate_workflow_automation(draft: &CreateAutomationRequest) -> Result<()> {
    if let Some(workflow) = &draft.execution.workflow_binding {
        workflow.binding.validate(&workflow.definition)?;
        ensure!(
            !workflow.root_id.is_empty() && workflow.root_id.len() <= 96,
            "workflow root is required"
        );
        ensure!(
            draft.stop_condition.is_none(),
            "workflow completion is defined by its steps, not a model stop marker"
        );
        ensure!(
            draft
                .execution
                .workspace_path
                .as_ref()
                .is_some_and(|path| !path.is_empty()),
            "workflow requires an authorized project root"
        );
    }
    Ok(())
}
impl AutomationStore {
    pub fn adopt_workflow_setup(
        &self,
        id: Uuid,
        expected: chrono::DateTime<chrono::Utc>,
        pinned: crate::workflows::WorkflowAutomationBinding,
    ) -> Result<Automation> {
        pinned.binding.validate(&pinned.definition)?;
        let current = self
            .get_automation(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow schedule is unavailable"))?;
        ensure!(
            current.execution.workflow_binding.is_some(),
            "legacy schedules have no workflow version to adopt"
        );
        let mut execution = current.execution;
        execution.workflow_binding = Some(pinned);
        self.edit_automation_with_expected(
            id,
            CreateAutomationRequest {
                title: current.title,
                prompt: current.prompt,
                schedule: current.schedule,
                project: current.project,
                provider: current.provider,
                branch: current.branch,
                workspace_mode: current.workspace_mode,
                worktree_name: current.worktree_name,
                stop_condition: None,
                next_run_at: current.next_run_at,
                execution,
            },
            Some(expected),
        )
    }
    /// Manual launches have stable job IDs so retries cannot create two jobs.
    pub fn create_workflow_automation(
        &self,
        draft: CreateAutomationRequest,
        operation: Uuid,
    ) -> Result<Automation> {
        validate_workflow_automation(&draft)?;
        ensure!(
            draft.execution.workflow_binding.is_some(),
            "workflow binding is required"
        );
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        if let Some(existing) = self.get_automation(operation)? {
            ensure!(
                existing.execution == draft.execution
                    && existing.schedule == draft.schedule
                    && existing.workspace_mode == draft.workspace_mode
                    && existing.branch == draft.branch,
                "launch operation belongs to another workflow configuration"
            );
            transaction.commit()?;
            return Ok(existing);
        }
        let created = self.create_automation_with_id(draft, operation)?;
        transaction.commit()?;
        Ok(created)
    }
    pub fn queue_manual_workflow_once(&self, id: Uuid) -> Result<Automation> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let automation = self
            .get_automation(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow job is unavailable"))?;
        ensure!(
            automation.schedule == AutomationSchedule::Manual
                && automation.execution.workflow_binding.is_some(),
            "this is not a manual workflow launch"
        );
        if !automation.run_history.is_empty()
            || automation.next_run_at.is_some()
            || automation.lease_owner.is_some()
        {
            transaction.commit()?;
            return Ok(automation);
        }
        ensure!(
            automation.status == AutomationStatus::Current,
            "resume the workflow job before launching"
        );
        let queued = self
            .queue_automation_now(id)?
            .ok_or_else(|| anyhow::anyhow!("workflow job is unavailable"))?;
        transaction.commit()?;
        Ok(queued)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{workflows::*, AutomationExecutionContext, GyroPaths, SessionWorkspaceMode};
    use std::collections::BTreeMap;
    fn draft() -> CreateAutomationRequest {
        let definition=parse_definition(br#"{"schema":"gyro.workflow.v1","id":"inspect","name":"Inspect","description":"Scoped inspection","inputs":[],"roles":["reader"],"steps":[{"kind":"agent","id":"read","role":"reader","instructions":"Inspect the project","requestedAccess":"read-only","output":{"name":"report","required":true}}],"completion":{"requiredOutputs":["report"],"requireReviewCompletion":false,"requireVerificationSuccess":false}}"#).unwrap();
        let binding = WorkflowBinding {
            definition_id: definition.id.clone(),
            definition_hash: definition_hash(&definition).unwrap(),
            roles: BTreeMap::from([(
                "reader".into(),
                WorkflowRoleBinding {
                    provider_id: "fixture".into(),
                    model_id: "model".into(),
                    access_ceiling: WorkflowAccess::ReadOnly,
                },
            )]),
            commands: Default::default(),
            inputs: Default::default(),
        };
        CreateAutomationRequest {
            title: "Inspect".into(),
            prompt: "Pinned recipe".into(),
            schedule: AutomationSchedule::Manual,
            project: "Fixture".into(),
            provider: "fixture".into(),
            branch: "main".into(),
            workspace_mode: SessionWorkspaceMode::Local,
            worktree_name: None,
            stop_condition: None,
            next_run_at: None,
            execution: AutomationExecutionContext {
                workspace_path: Some("/fixture".into()),
                workflow_binding: Some(WorkflowAutomationBinding {
                    continuation: None,
                    source_session_id: Uuid::new_v4(),
                    root_id: "root".into(),
                    definition,
                    binding,
                }),
                ..Default::default()
            },
        }
    }
    #[test]
    fn workflow_launch_is_idempotent_and_manual_retry_does_not_queue_twice() {
        let temp = tempfile::tempdir().unwrap();
        let store =
            AutomationStore::open(GyroPaths::from_base_dir(temp.path().join("private"))).unwrap();
        let draft = draft();
        let operation = Uuid::new_v4();
        let first = store
            .create_workflow_automation(draft.clone(), operation)
            .unwrap();
        assert_eq!(
            store
                .create_workflow_automation(draft.clone(), operation)
                .unwrap()
                .id,
            first.id
        );
        let queued = store.queue_manual_workflow_once(first.id).unwrap();
        let repeated = store.queue_manual_workflow_once(first.id).unwrap();
        assert_eq!(queued.next_run_at, repeated.next_run_at);
        let mut changed = draft;
        changed
            .execution
            .workflow_binding
            .as_mut()
            .unwrap()
            .binding
            .roles
            .get_mut("reader")
            .unwrap()
            .model_id = "different".into();
        assert!(store
            .create_workflow_automation(changed, operation)
            .is_err());
        assert_eq!(store.list_automations().unwrap().len(), 1);
    }
    #[test]
    fn future_workflow_configuration_is_preserved_and_cannot_fall_back_to_a_legacy_prompt() {
        let temp = tempfile::tempdir().unwrap();
        let store =
            AutomationStore::open(GyroPaths::from_base_dir(temp.path().join("private"))).unwrap();
        let mut legacy = draft();
        legacy.execution.workflow_binding = None;
        legacy.prompt = "legacy stays exact".into();
        let legacy = store.create_automation(legacy).unwrap();
        let future = store
            .create_workflow_automation(draft(), Uuid::new_v4())
            .unwrap();
        let mut value = serde_json::to_value(&future.execution).unwrap();
        value["workflowBinding"]["definition"]["schema"] = serde_json::json!("gyro.workflow.v9");
        let raw = serde_json::to_string(&value).unwrap();
        store
            .conn
            .execute(
                "update automations set execution_context=?2 where id=?1",
                rusqlite::params![future.id.to_string(), raw],
            )
            .unwrap();
        assert!(store.get_automation(future.id).is_err());
        let listed = store.list_automations().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].prompt, legacy.prompt);
        let preserved: String = store
            .conn
            .query_row(
                "select execution_context from automations where id=?1",
                [future.id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved, raw);
    }
    #[test]
    fn adopting_a_schedule_checks_the_reviewed_timestamp() {
        let temp = tempfile::tempdir().unwrap();
        let store =
            AutomationStore::open(GyroPaths::from_base_dir(temp.path().join("private"))).unwrap();
        let mut draft = draft();
        draft.schedule = AutomationSchedule::Hourly;
        let created = store
            .create_workflow_automation(draft, Uuid::new_v4())
            .unwrap();
        let pinned = created.execution.workflow_binding.clone().unwrap();
        assert!(store
            .adopt_workflow_setup(
                created.id,
                created.updated_at - chrono::Duration::seconds(1),
                pinned.clone()
            )
            .is_err());
        assert!(store
            .adopt_workflow_setup(created.id, created.updated_at, pinned)
            .is_ok());
    }
}
