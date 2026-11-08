//! Opt-in reviewer for disposable benchmark fixtures. Never used by chat commands.
use gyro_core::{
    decide_mutation_proposal_with_cancellation, MutationDecision, MutationProposal,
    MutationProposalOperation, MutationProposalStatus, SessionStore,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
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
            } else if self
                .audit
                .iter()
                .filter(|entry| entry["decision"] == "approve-fixture-edit")
                .count()
                >= 32
            {
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
}
