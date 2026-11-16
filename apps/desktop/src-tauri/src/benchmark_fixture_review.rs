//! Opt-in reviewer for disposable benchmark fixtures. Never used by chat commands.
use crate::{
    capabilities::types::{CapabilityApprovalDecisionRequest, ProviderApprovalDecisionRequest},
    state::{
        managers::{ProviderApprovalManager, ProviderCapabilityApprovalManager},
        provider_run::PendingProviderApproval,
    },
};
use gyro_core::{
    decide_mutation_proposal_with_cancellation, CapabilityApprovalDecision, CapabilityId,
    MutationDecision, MutationProposal, MutationProposalOperation, MutationProposalStatus,
    SessionEvent, SessionEventKind, SessionStore,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
use tauri::Manager;
use uuid::Uuid;

pub(super) struct FixtureReviewer {
    workspace: PathBuf,
    session: Uuid,
    turn: Uuid,
    allowed: &'static [&'static str],
    seen: HashSet<Uuid>,
    pub(super) audit: Vec<Value>,
    pub(super) require_file_edit_approval: bool,
}

impl FixtureReviewer {
    pub(super) fn new(
        store: &SessionStore,
        root: &Path,
        workspace: &Path,
        session: Uuid,
        turn: Uuid,
        task: &str,
    ) -> anyhow::Result<Self> {
        let temporary = std::env::temp_dir().canonicalize()?;
        anyhow::ensure!(
            root.is_absolute() && root.canonicalize()? == root,
            "fixture root must be canonical"
        );
        anyhow::ensure!(
            (root.starts_with(&temporary) && root != temporary)
                || (root.starts_with("/private/tmp") && root != Path::new("/private/tmp")),
            "fixture review requires a disposable temporary root"
        );
        anyhow::ensure!(
            store.paths().base_dir.canonicalize()? == root.join("data"),
            "fixture review requires a separate data directory"
        );
        anyhow::ensure!(
            workspace.canonicalize()? == workspace
                && workspace.parent() == Some(root.join("workspaces").as_path()),
            "fixture review requires a direct fixture workspace"
        );
        let owner = store
            .get_session(session)?
            .ok_or_else(|| anyhow::anyhow!("fixture session missing"))?;
        anyhow::ensure!(
            owner.workspace_path == workspace
                && owner.workspace_identity.roots.len() == 1
                && owner.workspace_identity.roots[0].path == workspace,
            "fixture session must own only its fixture workspace"
        );
        let allowed: &'static [&'static str] = match task {
            "readme" | "follow-up" => &["README.md"],
            "code" => &["src/clamp.mjs", "clamp.test.mjs"],
            "no-tool" | "browser" => &[],
            _ => anyhow::bail!("unknown fixture review task"),
        };
        Ok(Self {
            workspace: workspace.into(),
            session,
            turn,
            allowed,
            seen: HashSet::new(),
            audit: Vec::new(),
            require_file_edit_approval: false,
        })
    }

    fn eligible(&self, proposal: &MutationProposal) -> bool {
        proposal.session_id == self.session
            && proposal.turn_id == Some(self.turn)
            && proposal.workspace_path == self.workspace
            && proposal.status == MutationProposalStatus::Pending
            && proposal.operation == MutationProposalOperation::Update
            && proposal.base_exists
            && self.allowed.contains(&proposal.path.as_str())
    }

    fn review_count(&self) -> usize {
        self.audit
            .iter()
            .filter(|entry| {
                matches!(
                    entry["decision"].as_str(),
                    Some(
                        "approve-fixture-edit"
                            | "approve-provider-fixture-edit"
                            | "allow-fixture-inspection"
                    )
                )
            })
            .count()
    }

    fn native_update_paths(&self, pending: &PendingProviderApproval) -> Option<Vec<String>> {
        if !self.require_file_edit_approval
            || pending.session_id != self.session
            || pending.turn_id != Some(self.turn)
            || pending.payload["approvalType"] != "file-change"
        {
            return None;
        }
        let transaction = pending.file_transaction.as_ref()?;
        if transaction.workspace_path() != self.workspace {
            return None;
        }
        let paths = transaction.existing_file_updates()?.collect::<Vec<_>>();
        if paths.iter().any(|path| !self.allowed.contains(path)) {
            return None;
        }
        Some(paths.into_iter().map(str::to_owned).collect())
    }

    fn inspection(&self, event: &SessionEvent) -> Option<(Uuid, CapabilityId)> {
        if !self.require_file_edit_approval
            || event.session_id != self.session
            || event.turn_id != Some(self.turn)
            || event.kind != SessionEventKind::ApprovalRequested
            || event.payload["kind"] != "capability-approval"
            || event.payload["schema"] != gyro_core::CAPABILITY_SCHEMA_V1
            || event.payload["status"] != "waiting"
            || event.payload["scopeKind"] != "call"
        {
            return None;
        }
        let capability: CapabilityId =
            serde_json::from_value(event.payload["capabilityId"].clone()).ok()?;
        if !matches!(
            capability,
            CapabilityId::WorkspaceDiff | CapabilityId::WorkspaceGitStatus
        ) {
            return None;
        }
        let prefix = format!("{}:", capability.as_str());
        let fingerprint = event.payload["scopeValue"]
            .as_str()?
            .strip_prefix(&prefix)?;
        if fingerprint.len() != 64 || !fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let id = event.payload["approvalId"].as_str()?.parse().ok()?;
        Some((id, capability))
    }

    /// Resolve only opted-in fixture updates and two read-only inspections.
    /// Production chat commands never construct this temporary-root reviewer.
    pub(super) fn poll_approvals(
        &mut self,
        app: &tauri::AppHandle,
        store: &SessionStore,
        stopped: impl Fn() -> bool,
    ) -> anyhow::Result<()> {
        if !self.require_file_edit_approval || stopped() {
            return Ok(());
        }
        let updates = {
            let manager = app.state::<ProviderApprovalManager>();
            let pending = manager
                .pending
                .lock()
                .map_err(|_| anyhow::anyhow!("fixture approval state unavailable"))?;
            pending
                .values()
                .filter(|pending| {
                    pending.session_id == self.session && pending.turn_id == Some(self.turn)
                })
                .map(|pending| (pending.approval_id, self.native_update_paths(pending)))
                .collect::<Vec<_>>()
        };
        for (id, paths) in updates {
            if stopped() {
                return Ok(());
            }
            if !self.seen.insert(id) {
                continue;
            }
            let Some(paths) = paths else {
                self.audit
                    .push(json!({"approvalId":id,"decision":"skip","status":"out-of-scope"}));
                continue;
            };
            if self.review_count() >= 32 {
                self.audit
                    .push(json!({"approvalId":id,"decision":"skip","status":"review-limit"}));
                continue;
            }
            let result = crate::providers::approvals::resolve_provider_approval_blocking(
                app.clone(),
                ProviderApprovalDecisionRequest {
                    approval_id: id.to_string(),
                    decision: "approve".into(),
                },
            );
            self.audit.push(json!({"approvalId":id,"paths":paths,"decision":"approve-provider-fixture-edit","status":if result.is_ok() {"applied"} else {"core-rejected"}}));
        }
        if stopped() {
            return Ok(());
        }
        let waiting = {
            let manager = app.state::<ProviderCapabilityApprovalManager>();
            let pending = manager
                .pending
                .lock()
                .map_err(|_| anyhow::anyhow!("fixture capability approval state unavailable"))?;
            pending
                .iter()
                .filter(|(_, approval)| {
                    approval.session_id == self.session && approval.turn_id == Some(self.turn)
                })
                .map(|(id, _)| id.clone())
                .collect::<HashSet<_>>()
        };
        if waiting.is_empty() {
            return Ok(());
        }
        for event in store.read_recent_events(self.session, 128)? {
            if stopped() {
                break;
            }
            let Some((id, capability)) = self.inspection(&event) else {
                continue;
            };
            if !waiting.contains(&id.to_string()) || !self.seen.insert(id) {
                continue;
            }
            if self.review_count() >= 32 {
                self.audit
                    .push(json!({"approvalId":id,"decision":"skip","status":"review-limit"}));
                continue;
            }
            let result = tauri::async_runtime::block_on(
                crate::capabilities::execute::resolve_capability_approval(
                    app.clone(),
                    CapabilityApprovalDecisionRequest {
                        approval_id: id.to_string(),
                        session_id: self.session.to_string(),
                        turn_id: Some(self.turn.to_string()),
                        decision: CapabilityApprovalDecision::AllowOnce,
                    },
                    app.state::<ProviderCapabilityApprovalManager>(),
                ),
            );
            self.audit.push(json!({"approvalId":id,"capabilityId":capability,"decision":"allow-fixture-inspection","status":if result.is_ok() {"allowed-once"} else {"core-rejected"}}));
        }
        Ok(())
    }

    pub(super) fn poll(
        &mut self,
        store: &SessionStore,
        stopped: impl Fn() -> bool,
    ) -> anyhow::Result<()> {
        if stopped() {
            return Ok(());
        }
        for proposal in store.list_pending_mutation_proposals(self.session)? {
            if stopped() {
                break;
            }
            if !self.seen.insert(proposal.id) {
                continue;
            }
            let status = if !self.eligible(&proposal) {
                "out-of-scope"
            } else if self.review_count() >= 32 {
                "review-limit"
            } else {
                let result = decide_mutation_proposal_with_cancellation(
                    store,
                    proposal.id,
                    MutationDecision::Approve,
                    &stopped,
                );
                self.audit.push(json!({
                    "proposalId":proposal.id, "path":proposal.path,
                    "decision":"approve-fixture-edit",
                    "status":if result.is_ok() { "applied" } else { "core-rejected" },
                }));
                continue;
            };
            self.audit.push(json!({"proposalId":proposal.id, "path":proposal.path, "decision":"skip", "status":status}));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gyro_core::{GyroPaths, SessionOrigin};
    use sha2::{Digest, Sha256};
    use std::fs;

    fn setup() -> (tempfile::TempDir, PathBuf, SessionStore, Uuid, Uuid) {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let workspace = root.join("workspaces/fixture");
        super::super::fixture(&workspace).unwrap();
        let store = SessionStore::open(GyroPaths::from_base_dir(root.join("data"))).unwrap();
        let session = store
            .create_session(&workspace, SessionOrigin::Desktop, "fixture reviewer")
            .unwrap()
            .id;
        (temporary, workspace, store, session, Uuid::new_v4())
    }
    fn propose(
        store: &SessionStore,
        session: Uuid,
        turn: Uuid,
        path: &str,
        content: &str,
    ) -> MutationProposal {
        let workspace = store.get_session(session).unwrap().unwrap().workspace_path;
        let hash = format!(
            "{:x}",
            Sha256::digest(fs::read(workspace.join(path)).unwrap())
        );
        store
            .create_mutation_proposal(session, Some(turn), path, content, Some(hash), true)
            .unwrap()
    }

    #[test]
    fn fixture_reviewer_applies_only_current_task_files_and_records_no_content() {
        let (_temporary, workspace, store, session, turn) = setup();
        let root = workspace.parent().unwrap().parent().unwrap();
        let good = propose(
            &store,
            session,
            turn,
            "README.md",
            "# PRIVATE_FIXTURE_CONTENT\n",
        );
        let wrong_file = propose(&store, session, turn, "src/clamp.mjs", "wrong task\n");
        let wrong_turn = propose(&store, session, Uuid::new_v4(), "README.md", "wrong turn\n");
        let mut reviewer =
            FixtureReviewer::new(&store, root, &workspace, session, turn, "readme").unwrap();
        reviewer.poll(&store, || false).unwrap();
        reviewer.poll(&store, || false).unwrap();
        assert_eq!(reviewer.audit.len(), 3);
        assert_eq!(
            store
                .get_mutation_proposal(good.id)
                .unwrap()
                .unwrap()
                .status,
            MutationProposalStatus::Applied
        );
        for id in [wrong_file.id, wrong_turn.id] {
            assert_eq!(
                store.get_mutation_proposal(id).unwrap().unwrap().status,
                MutationProposalStatus::Pending
            );
        }
        assert!(!serde_json::to_string(&reviewer.audit)
            .unwrap()
            .contains("PRIVATE_FIXTURE_CONTENT"));
    }

    #[test]
    fn fixture_review_keeps_hash_checks_and_stops_without_applying() {
        let (_temporary, workspace, store, session, turn) = setup();
        let root = workspace.parent().unwrap().parent().unwrap();
        let proposal = propose(&store, session, turn, "README.md", "new content\n");
        let mut reviewer =
            FixtureReviewer::new(&store, root, &workspace, session, turn, "readme").unwrap();
        reviewer.poll(&store, || true).unwrap();
        assert!(reviewer.audit.is_empty());
        assert_eq!(
            store
                .get_mutation_proposal(proposal.id)
                .unwrap()
                .unwrap()
                .status,
            MutationProposalStatus::Pending
        );
        fs::write(workspace.join("README.md"), "concurrent change\n").unwrap();
        reviewer.poll(&store, || false).unwrap();
        assert_eq!(reviewer.audit[0]["status"], "core-rejected");
        assert_eq!(
            fs::read_to_string(workspace.join("README.md")).unwrap(),
            "concurrent change\n"
        );
    }

    #[test]
    fn fixture_review_rejects_legacy_store_and_aliased_workspace() {
        let (_temporary, workspace, store, session, turn) = setup();
        let root = workspace.parent().unwrap().parent().unwrap();
        let legacy = SessionStore::open(GyroPaths::from_base_dir(root.into())).unwrap();
        assert!(FixtureReviewer::new(&legacy, root, &workspace, session, turn, "readme").is_err());
        assert!(
            FixtureReviewer::new(&store, root, &workspace.join(".."), session, turn, "readme")
                .is_err()
        );
        #[cfg(unix)]
        {
            let alias = root.join("workspaces/alias");
            std::os::unix::fs::symlink(&workspace, &alias).unwrap();
            assert!(FixtureReviewer::new(&store, root, &alias, session, turn, "readme").is_err());
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn reviewed_code_fixture_passes_upper_bound_checks_under_command_confinement() {
        use gyro_core::workspace_sandbox::PreparedWorkspaceSandbox;
        use std::{ffi::OsStr, process::Command};
        let (_temporary, workspace, store, session, turn) = setup();
        let root = workspace.parent().unwrap().parent().unwrap();
        propose(&store, session, turn, "src/clamp.mjs", "export function clamp(value, minimum, maximum) {\n  return Math.min(Math.max(value, minimum), maximum);\n}\n");
        let tests = fs::read_to_string(workspace.join("clamp.test.mjs")).unwrap();
        propose(
            &store,
            session,
            turn,
            "clamp.test.mjs",
            &format!("{tests}test('upper bound', () => assert.equal(clamp(20, 0, 10), 10));\n"),
        );
        let mut reviewer =
            FixtureReviewer::new(&store, root, &workspace, session, turn, "code").unwrap();
        reviewer.poll(&store, || false).unwrap();
        assert_eq!(reviewer.audit.len(), 2);
        assert!(reviewer
            .audit
            .iter()
            .all(|entry| entry["status"] == "applied"));
        let home = root.join("home");
        fs::create_dir(&home).unwrap();
        let sandbox = PreparedWorkspaceSandbox::prepare(
            &workspace,
            &workspace,
            &home,
            Some(&root.join("data")),
        )
        .unwrap();
        let (program, args) = sandbox.wrap_command(OsStr::new("node"), &["--test".into()]);
        let output = Command::new(program)
            .args(args)
            .envs(sandbox.environment())
            .current_dir(&workspace)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("pass 2"));
        assert!(super::super::verify(&workspace, "code"));
    }

    #[test]
    fn no_tool_trials_and_other_sessions_receive_no_fixture_approvals() {
        let (_temporary, workspace, store, session, turn) = setup();
        let root = workspace.parent().unwrap().parent().unwrap();
        let current = propose(&store, session, turn, "README.md", "disallowed\n");
        let other = store
            .create_session(&workspace, SessionOrigin::Desktop, "other session")
            .unwrap();
        let foreign = propose(&store, other.id, turn, "README.md", "foreign\n");
        let mut reviewer =
            FixtureReviewer::new(&store, root, &workspace, session, turn, "no-tool").unwrap();
        reviewer.poll(&store, || false).unwrap();
        assert_eq!(reviewer.audit.len(), 1);
        assert_eq!(reviewer.audit[0]["status"], "out-of-scope");
        for proposal in [current, foreign] {
            assert_eq!(
                store
                    .get_mutation_proposal(proposal.id)
                    .unwrap()
                    .unwrap()
                    .status,
                MutationProposalStatus::Pending
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn allowed_filename_cannot_escape_through_a_symlink() {
        let (_temporary, workspace, store, session, turn) = setup();
        let root = workspace.parent().unwrap().parent().unwrap();
        let proposal = propose(&store, session, turn, "README.md", "unexpected change\n");
        let outside = root.join("outside.md");
        let original = fs::read(workspace.join("README.md")).unwrap();
        fs::write(&outside, &original).unwrap();
        fs::remove_file(workspace.join("README.md")).unwrap();
        std::os::unix::fs::symlink(&outside, workspace.join("README.md")).unwrap();
        let mut reviewer =
            FixtureReviewer::new(&store, root, &workspace, session, turn, "readme").unwrap();
        reviewer.poll(&store, || false).unwrap();
        assert_eq!(reviewer.audit[0]["status"], "core-rejected");
        assert_eq!(
            store
                .get_mutation_proposal(proposal.id)
                .unwrap()
                .unwrap()
                .status,
            MutationProposalStatus::Failed
        );
        assert_eq!(fs::read(&outside).unwrap(), original);
    }
    #[test]
    fn native_fixture_updates_require_opt_in_owner_turn_and_existing_task_files() {
        let (_temporary, workspace, store, session, turn) = setup();
        let root = workspace.parent().unwrap().parent().unwrap();
        let mut reviewer =
            FixtureReviewer::new(&store, root, &workspace, session, turn, "readme").unwrap();
        let transaction = |path: &str| {
            gyro_core::prepare_provider_text_replacement_transaction(
                &workspace,
                &workspace.join(path),
                "fixture replacement\n",
            )
            .unwrap()
        };
        let (sender, _) = std::sync::mpsc::channel();
        let mut pending = PendingProviderApproval {
            sender,
            approval_id: Uuid::new_v4(),
            session_id: session,
            turn_id: Some(turn),
            payload: json!({"approvalType":"file-change"}),
            file_transaction: Some(transaction("README.md")),
        };
        assert!(reviewer.native_update_paths(&pending).is_none());
        reviewer.require_file_edit_approval = true;
        assert_eq!(
            reviewer.native_update_paths(&pending),
            Some(vec!["README.md".to_string()])
        );
        pending.turn_id = Some(Uuid::new_v4());
        assert!(reviewer.native_update_paths(&pending).is_none());
        pending.turn_id = Some(turn);
        pending.session_id = Uuid::new_v4();
        assert!(reviewer.native_update_paths(&pending).is_none());
        pending.session_id = session;
        pending.payload["approvalType"] = "command".into();
        assert!(reviewer.native_update_paths(&pending).is_none());
        pending.payload["approvalType"] = "file-change".into();
        pending.file_transaction = Some(transaction("src/clamp.mjs"));
        assert!(reviewer.native_update_paths(&pending).is_none());
        pending.file_transaction = Some(transaction("new.txt"));
        assert!(reviewer.native_update_paths(&pending).is_none());
        pending.file_transaction = Some(
            gyro_core::prepare_provider_mutation_transaction(
                &workspace,
                &[gyro_core::ProviderFileChange {
                    path: "README.md".into(),
                    kind: gyro_core::ProviderFileChangeKind {
                        change_type: "delete".into(),
                        move_path: None,
                    },
                    diff: String::new(),
                }],
            )
            .unwrap(),
        );
        assert!(reviewer.native_update_paths(&pending).is_none());
        let (_, details) = gyro_core::mutations::prepare_provider_text_replacement_review(
            &workspace,
            &workspace.join("README.md"),
            "changed\n",
        )
        .unwrap();
        let mut changes: Vec<gyro_core::ProviderFileChange> =
            serde_json::from_value(details["patch"]["changes"].clone()).unwrap();
        changes[0].kind.move_path = Some("moved.md".into());
        pending.file_transaction =
            Some(gyro_core::prepare_provider_mutation_transaction(&workspace, &changes).unwrap());
        assert!(reviewer.native_update_paths(&pending).is_none());
        let other = tempfile::tempdir().unwrap();
        let other_root = other.path().canonicalize().unwrap();
        fs::write(other_root.join("README.md"), "other workspace\n").unwrap();
        pending.file_transaction = Some(
            gyro_core::prepare_provider_text_replacement_transaction(
                &other_root,
                &other_root.join("README.md"),
                "changed\n",
            )
            .unwrap(),
        );
        assert!(reviewer.native_update_paths(&pending).is_none());
        pending.file_transaction = None;
        assert!(reviewer.native_update_paths(&pending).is_none());
    }

    #[test]
    fn fixture_inspections_are_read_only_single_call_and_turn_bound() {
        let (_temporary, workspace, store, session, turn) = setup();
        let root = workspace.parent().unwrap().parent().unwrap();
        let mut reviewer =
            FixtureReviewer::new(&store, root, &workspace, session, turn, "code").unwrap();
        let id = Uuid::new_v4();
        let mut event = store.append_event_with_turn_id(session, SessionEventKind::ApprovalRequested, "fixture inspection", json!({"schema":gyro_core::CAPABILITY_SCHEMA_V1,"kind":"capability-approval","approvalId":id,"status":"waiting","capabilityId":CapabilityId::WorkspaceDiff,"scopeKind":"call","scopeValue":format!("workspace.diff:{}", "a".repeat(64))}), Some(turn)).unwrap();
        assert!(reviewer.inspection(&event).is_none());
        reviewer.require_file_edit_approval = true;
        assert_eq!(
            reviewer.inspection(&event),
            Some((id, CapabilityId::WorkspaceDiff))
        );
        event.turn_id = Some(Uuid::new_v4());
        assert!(reviewer.inspection(&event).is_none());
        event.turn_id = Some(turn);
        event.session_id = Uuid::new_v4();
        assert!(reviewer.inspection(&event).is_none());
        event.session_id = session;
        event.payload["capabilityId"] =
            serde_json::to_value(CapabilityId::WorkspaceRunTask).unwrap();
        assert!(reviewer.inspection(&event).is_none());
        event.payload["capabilityId"] = serde_json::to_value(CapabilityId::WorkspaceDiff).unwrap();
        event.payload["scopeKind"] = "workspace".into();
        assert!(reviewer.inspection(&event).is_none());
        event.payload["scopeKind"] = "call".into();
        event.payload["scopeValue"] = "workspace.diff:bad".into();
        assert!(reviewer.inspection(&event).is_none());
        event.payload["scopeValue"] = format!("workspace.diff:{}", "a".repeat(64)).into();
        event.payload["status"] = "approved".into();
        assert!(reviewer.inspection(&event).is_none());
        reviewer.audit = (0..31)
            .map(|_| json!({"decision":"approve-fixture-edit"}))
            .collect();
        reviewer
            .audit
            .push(json!({"decision":"allow-fixture-inspection"}));
        assert_eq!(reviewer.review_count(), 32);
    }
}
