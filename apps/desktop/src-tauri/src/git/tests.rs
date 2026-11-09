use super::*;

#[test]
fn git_discard_restores_tracked_files_and_removes_untracked_files() {
    let workspace = tempfile::tempdir().unwrap();
    run_git(workspace.path(), &["init"]);
    run_git(
        workspace.path(),
        &["config", "user.email", "gyro@example.test"],
    );
    run_git(workspace.path(), &["config", "user.name", "Gyro Tests"]);
    std::fs::write(workspace.path().join("tracked.txt"), "original\n").unwrap();
    run_git(workspace.path(), &["add", "tracked.txt"]);
    run_git(workspace.path(), &["commit", "-m", "initial"]);
    std::fs::write(workspace.path().join("tracked.txt"), "changed\n").unwrap();

    git_discard_blocking(GitStageRequest {
        workspace_path: workspace.path().to_string_lossy().to_string(),
        path: "tracked.txt".into(),
    })
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("tracked.txt")).unwrap(),
        "original\n"
    );

    std::fs::write(workspace.path().join("untracked.txt"), "temporary\n").unwrap();
    git_discard_blocking(GitStageRequest {
        workspace_path: workspace.path().to_string_lossy().to_string(),
        path: "untracked.txt".into(),
    })
    .unwrap();
    assert!(!workspace.path().join("untracked.txt").exists());
}

/// The whole path behind the Source Control panel, against a real remote:
/// stage a file, commit it, and get the branch published. A branch that has
/// never been pushed is the state every new branch starts in, so the first
/// push has to set its upstream rather than fail with a hint no button can
/// act on.
#[test]
fn staging_committing_and_pushing_publishes_an_unpublished_branch() {
    let temporary = tempfile::tempdir().unwrap();
    let remote = temporary.path().join("origin.git");
    let workspace = temporary.path().join("work");
    std::fs::create_dir_all(&workspace).unwrap();
    Command::new("git")
        .args(["init", "--bare"])
        .arg(&remote)
        .output()
        .unwrap();
    run_git(&workspace, &["init"]);
    run_git(&workspace, &["config", "user.email", "gyro@example.test"]);
    run_git(&workspace, &["config", "user.name", "Gyro Tests"]);
    run_git(
        &workspace,
        &["remote", "add", "origin", &remote.to_string_lossy()],
    );
    let workspace_path = workspace.to_string_lossy().to_string();

    std::fs::write(workspace.join("note.txt"), "first\n").unwrap();
    let staged = git_stage_blocking(GitStageRequest {
        workspace_path: workspace_path.clone(),
        path: "note.txt".into(),
    })
    .unwrap();
    assert!(staged
        .files
        .iter()
        .any(|file| file.path == "note.txt" && file.staged));
    assert!(staged.upstream.is_none());

    let committed = git_commit_blocking(GitCommitRequest {
        workspace_path: workspace_path.clone(),
        message: "add a note".into(),
    })
    .unwrap();
    assert_eq!(committed.status, "done", "{}", committed.stderr);

    // The caller has not been told to set an upstream, and there is none:
    // publishing is what the press has to mean.
    let published = git_push_blocking(GitSyncRequest {
        workspace_path: workspace_path.clone(),
        remote: None,
        set_upstream: false,
    })
    .unwrap();
    assert_eq!(
        published.output.status, "done",
        "{}",
        published.output.stderr
    );
    let branch = git_current_branch(&workspace).unwrap();
    assert_eq!(published.status.upstream, Some(format!("origin/{branch}")));
    assert_eq!(published.status.ahead, 0);

    // A second commit is an ordinary push against the upstream just set.
    std::fs::write(workspace.join("note.txt"), "second\n").unwrap();
    git_stage_blocking(GitStageRequest {
        workspace_path: workspace_path.clone(),
        path: "note.txt".into(),
    })
    .unwrap();
    git_commit_blocking(GitCommitRequest {
        workspace_path: workspace_path.clone(),
        message: "revise the note".into(),
    })
    .unwrap();
    let ahead = git_status_impl(&workspace_path).unwrap();
    assert_eq!(ahead.ahead, 1);
    let pushed = git_push_blocking(GitSyncRequest {
        workspace_path: workspace_path.clone(),
        remote: None,
        set_upstream: false,
    })
    .unwrap();
    assert_eq!(pushed.output.status, "done", "{}", pushed.output.stderr);
    assert_eq!(pushed.status.ahead, 0);

    // Nothing staged is a commit git refuses. It answers with output rather
    // than an error, so the exit status is the only thing separating it
    // from a commit that worked.
    let empty = git_commit_blocking(GitCommitRequest {
        workspace_path: workspace_path.clone(),
        message: "nothing to say".into(),
    })
    .unwrap();
    assert_eq!(empty.status, "failed");
    assert!(!git_action_error(&empty).is_empty());
}

/// A git command a button ran must report a refusal as a refusal.
#[test]
fn a_refused_git_command_is_reported_rather_than_passed_over() {
    let workspace = tempfile::tempdir().unwrap();
    run_git(workspace.path(), &["init"]);
    let workspace_path = workspace.path().to_string_lossy().to_string();
    std::fs::write(workspace.path().join("note.txt"), "first\n").unwrap();
    std::fs::write(workspace.path().join(".gitignore"), "note.txt\n").unwrap();

    // Staging an ignored file is the everyday refusal: git says no, and the
    // panel has to say so rather than refresh unchanged.
    let refused = git_stage_blocking(GitStageRequest {
        workspace_path,
        path: "note.txt".into(),
    })
    .unwrap_err();
    assert!(
        refused.contains("note.txt") || refused.contains("ignored"),
        "{refused}"
    );

    // Nothing said, and no exit to read: the termination is the account.
    assert_eq!(
        git_action_error(&IdeCommandOutput {
            status: "timed-out".into(),
            exit_code: None,
            source_truncated: false,
            stdout: String::new(),
            stderr: "   \n".into(),
        }),
        "the git command timed-out"
    );
}

/// Nothing git runs from a window may sit waiting for an answer that can
/// only come from a terminal.
#[test]
fn git_never_waits_on_a_prompt_it_cannot_show() {
    let command = git_command();
    let prompt = command
        .get_envs()
        .find(|(key, _)| *key == std::ffi::OsStr::new("GIT_TERMINAL_PROMPT"))
        .and_then(|(_, value)| value)
        .map(|value| value.to_string_lossy().to_string());
    assert_eq!(prompt.as_deref(), Some("0"));
}

#[test]
fn workspace_watcher_ignores_git_internals_and_dependency_churn() {
    let root = PathBuf::from("/tmp/gyro-workspace");
    let ignored =
        NotifyEvent::new(notify::EventKind::Any).add_path(root.join(".git/objects/object"));
    let dependency = NotifyEvent::new(notify::EventKind::Any)
        .add_path(root.join("node_modules/package/index.js"));
    let source = NotifyEvent::new(notify::EventKind::Any).add_path(root.join("src/app.ts"));

    assert!(!workspace_watch_event_is_relevant(&root, &ignored));
    assert!(workspace_watch_event_is_relevant(&root, &source));
    // `pnpm install` or a test run churns these at any depth; only the
    // folder itself appearing at the top level changes the tree.
    assert!(!workspace_watch_event_is_relevant(&root, &dependency));
    for churn in [
        "packages/ui/node_modules/x/index.js",
        "src/__pycache__/a.pyc",
    ] {
        let event = NotifyEvent::new(notify::EventKind::Any).add_path(root.join(churn));
        assert!(!workspace_watch_event_is_relevant(&root, &event), "{churn}");
    }
    let installed = NotifyEvent::new(notify::EventKind::Any).add_path(root.join("node_modules"));
    assert!(workspace_watch_event_is_relevant(&root, &installed));

    let build_output =
        NotifyEvent::new(notify::EventKind::Any).add_path(root.join("target/debug/deps/gyro.o"));
    let build_folder = NotifyEvent::new(notify::EventKind::Any).add_path(root.join("target"));
    assert!(!workspace_watch_event_is_relevant(&root, &build_output));
    assert!(workspace_watch_event_is_relevant(&root, &build_folder));
}

#[test]
fn terminal_local_cwd_uses_source_repo_for_gyro_worktree() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    run_git(&repo, &["init"]);
    run_git(&repo, &["config", "user.email", "gyro@example.test"]);
    run_git(&repo, &["config", "user.name", "Gyro Test"]);
    std::fs::write(repo.join("README.md"), "# test\n").unwrap();
    run_git(&repo, &["add", "README.md"]);
    run_git(&repo, &["commit", "-m", "initial"]);

    let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
    let plan = create_worktree(
        &paths,
        &repo,
        "gyro/terminal-cwd",
        Some("gyro-terminal-cwd".into()),
    )
    .unwrap();

    let local_request = TerminalPaneRequest {
        pane_id: "local-cwd".into(),
        title: "Shell".into(),
        profile_id: Some("shell".into()),
        command: "zsh".into(),
        args: Vec::new(),
        workspace_path: Some(plan.worktree_path.display().to_string()),
        workspace_mode: Some("local".into()),
        working_directory: Some("Workspace".into()),
        cols: None,
        rows: None,
        ..Default::default()
    };
    assert_eq!(
        resolve_terminal_cwd(&local_request).unwrap(),
        Some(repo.canonicalize().unwrap())
    );

    let worktree_request = TerminalPaneRequest {
        workspace_mode: Some("worktree".into()),
        ..local_request
    };
    assert_eq!(
        resolve_terminal_cwd(&worktree_request).unwrap(),
        Some(plan.worktree_path.canonicalize().unwrap())
    );
}

#[test]
fn git_status_reports_clean_and_live_line_stats() {
    let repo = tempfile::tempdir().unwrap();
    init_git_repo(repo.path());
    fs::write(repo.path().join("tracked.txt"), "alpha\nbeta\n").unwrap();
    fs::write(repo.path().join("old.txt"), "rename me\n").unwrap();
    run_git(repo.path(), &["add", "."]);
    run_git(repo.path(), &["commit", "-m", "base"]);

    let clean = git_status_impl(repo.path().to_str().unwrap()).unwrap();
    assert!(clean.available);
    assert!(clean.files.is_empty());
    assert_eq!((clean.additions, clean.deletions), (0, 0));

    fs::write(repo.path().join("tracked.txt"), "alpha\ngamma\ndelta\n").unwrap();
    fs::write(repo.path().join("new.txt"), "one\ntwo\n").unwrap();
    run_git(repo.path(), &["mv", "old.txt", "renamed.txt"]);

    let changed = git_status_impl(repo.path().to_str().unwrap()).unwrap();
    assert_eq!(changed.branch.as_deref(), Some("main"));
    assert_eq!(
        changed.repo_root.as_deref(),
        repo.path().canonicalize().unwrap().to_str()
    );
    assert!(changed.additions >= 5);
    assert!(changed.deletions >= 2);
    assert!(changed.files.iter().any(|file| file.path == "tracked.txt"));
    assert!(changed
        .files
        .iter()
        .any(|file| file.path == "new.txt" && file.additions == 2));
    assert!(changed.files.iter().any(|file| file.state == "renamed"));
    assert!(!changed.stats_partial);
}

#[test]
fn branch_catalog_order_sorts_newest_first_even_when_main_is_older() {
    let mut branches = vec![
        (300, "feature/newest".to_string()),
        (100, "feature/oldest".to_string()),
        (50, "main".to_string()),
        (200, "feature/middle".to_string()),
    ];

    sort_branch_catalog_entries(&mut branches);

    assert_eq!(
        branches
            .into_iter()
            .map(|(_, branch)| branch)
            .collect::<Vec<_>>(),
        vec!["feature/newest", "feature/middle", "feature/oldest", "main"]
    );
}

#[test]
fn git_branch_catalog_switches_preserving_edits_and_refuses_conflicts() {
    let repo = tempfile::tempdir().unwrap();
    init_git_repo(repo.path());
    fs::write(repo.path().join("tracked.txt"), "main\n").unwrap();
    run_git(repo.path(), &["add", "."]);
    run_git(repo.path(), &["commit", "-m", "base"]);
    run_git(repo.path(), &["branch", "feature/picker"]);

    let workspace_path = repo.path().to_str().unwrap().to_string();
    let catalog = git_branch_catalog_impl(&workspace_path).unwrap();
    assert_eq!(catalog.current.as_deref(), Some("main"));
    assert_eq!(catalog.branches, vec!["main", "feature/picker"]);
    assert!(catalog.last_commit_at["main"] > 0);
    assert_eq!(
        catalog.last_commit_at["main"],
        catalog.last_commit_at["feature/picker"]
    );

    let switched = git_checkout_branch_impl(&GitCheckoutBranchRequest {
        workspace_path: workspace_path.clone(),
        branch: "feature/picker".into(),
    })
    .unwrap();
    assert_eq!(switched.current.as_deref(), Some("feature/picker"));

    fs::write(repo.path().join("tracked.txt"), "dirty\n").unwrap();
    let switched = git_checkout_branch_impl(&GitCheckoutBranchRequest {
        workspace_path: workspace_path.clone(),
        branch: "main".into(),
    })
    .unwrap();
    assert_eq!(switched.current.as_deref(), Some("main"));
    assert_eq!(
        fs::read_to_string(repo.path().join("tracked.txt")).unwrap(),
        "dirty\n"
    );
    run_git(repo.path(), &["add", "."]);
    run_git(repo.path(), &["commit", "-m", "diverge"]);
    fs::write(repo.path().join("tracked.txt"), "keep me\n").unwrap();
    assert!(git_checkout_branch_impl(&GitCheckoutBranchRequest {
        workspace_path: workspace_path.clone(),
        branch: "feature/picker".into(),
    })
    .is_err());
    assert_eq!(
        fs::read_to_string(repo.path().join("tracked.txt")).unwrap(),
        "keep me\n"
    );
    let renamed = git_rename_branch_impl(&GitCheckoutBranchRequest {
        workspace_path: workspace_path.clone(),
        branch: "feature/renamed".into(),
    })
    .unwrap();
    assert_eq!(renamed.current.as_deref(), Some("feature/renamed"));
    assert!(!renamed.branches.contains(&"main".to_string()));
    assert!(git_rename_branch_impl(&GitCheckoutBranchRequest {
        workspace_path,
        branch: "feature/picker".into(),
    })
    .is_err());
}

#[test]
fn git_branch_catalog_creates_a_session_branch_from_the_selected_base() {
    let repo = tempfile::tempdir().unwrap();
    init_git_repo(repo.path());
    let tracked = repo.path().join("tracked.txt");
    fs::write(&tracked, "release base\n").unwrap();
    run_git(repo.path(), &["add", "."]);
    run_git(repo.path(), &["commit", "-m", "release base"]);
    run_git(repo.path(), &["branch", "release/base"]);
    fs::write(&tracked, "main head\n").unwrap();
    run_git(repo.path(), &["commit", "-am", "main head"]);
    fs::write(repo.path().join("scratch.txt"), "keep me\n").unwrap();

    let catalog = git_create_branch_impl(&GitCreateBranchRequest {
        workspace_path: repo.path().to_string_lossy().into_owned(),
        branch: "feature/session-goal".into(),
        start_point: Some("release/base".into()),
    })
    .unwrap();

    assert_eq!(catalog.current.as_deref(), Some("feature/session-goal"));
    assert!(catalog
        .branches
        .contains(&"feature/session-goal".to_string()));
    assert_eq!(fs::read_to_string(tracked).unwrap(), "release base\n");
    assert_eq!(
        fs::read_to_string(repo.path().join("scratch.txt")).unwrap(),
        "keep me\n"
    );
}

#[test]
fn branch_catalog_lists_and_safely_removes_linked_worktrees() {
    let repo = tempfile::tempdir().unwrap();
    init_git_repo(repo.path());
    fs::write(repo.path().join("tracked.txt"), "main\n").unwrap();
    run_git(repo.path(), &["add", "."]);
    run_git(repo.path(), &["commit", "-m", "base"]);

    let worktree_parent = tempfile::tempdir().unwrap();
    let linked_path = worktree_parent.path().join("linked");
    let linked_path_string = linked_path.to_string_lossy().into_owned();
    run_git(
        repo.path(),
        &[
            "worktree",
            "add",
            "-b",
            "feature/linked",
            &linked_path_string,
        ],
    );

    let workspace_path = repo.path().to_string_lossy().into_owned();
    let catalog = git_branch_catalog_impl(&workspace_path).unwrap();
    assert!(catalog
        .worktrees
        .iter()
        .any(|worktree| worktree.branch == "feature/linked"));

    let updated = git_remove_worktree_impl(&GitRemoveWorktreeRequest {
        workspace_path: workspace_path.clone(),
        branch: "feature/linked".into(),
    })
    .unwrap();
    assert!(!linked_path.exists());
    assert!(updated.worktrees.is_empty());
    assert!(updated.branches.contains(&"feature/linked".to_string()));

    let dirty_path = worktree_parent.path().join("dirty");
    let dirty_path_string = dirty_path.to_string_lossy().into_owned();
    run_git(
        repo.path(),
        &["worktree", "add", "-b", "feature/dirty", &dirty_path_string],
    );
    fs::write(dirty_path.join("untracked.txt"), "keep me\n").unwrap();
    let error = git_remove_worktree_impl(&GitRemoveWorktreeRequest {
        workspace_path,
        branch: "feature/dirty".into(),
    })
    .unwrap_err();
    assert!(error.to_string().contains("could not remove worktree"));
    assert!(dirty_path.exists());
}

#[test]
fn git_status_handles_unborn_binary_large_and_non_git_workspaces() {
    let repo = tempfile::tempdir().unwrap();
    init_git_repo(repo.path());
    fs::write(repo.path().join("staged.txt"), "first\nsecond\n").unwrap();
    run_git(repo.path(), &["add", "staged.txt"]);
    fs::write(repo.path().join("untracked.txt"), "third\n").unwrap();
    fs::write(repo.path().join("binary.bin"), [0, 1, 2, 3]).unwrap();
    fs::write(
        repo.path().join("large.txt"),
        vec![b'x'; MAX_WORKSPACE_FILE_EDIT_BYTES + 1],
    )
    .unwrap();

    let status = git_status_impl(repo.path().to_str().unwrap()).unwrap();
    assert!(status.available);
    assert_eq!(status.additions, 4);
    assert!(!status.stats_partial);
    assert!(status
        .files
        .iter()
        .any(|file| file.path == "binary.bin" && file.additions == 0));
    assert!(status
        .files
        .iter()
        .any(|file| file.path == "large.txt" && file.additions == 1));

    let folder = tempfile::tempdir().unwrap();
    let unavailable = git_status_impl(folder.path().to_str().unwrap()).unwrap();
    assert!(!unavailable.available);
    assert_eq!((unavailable.additions, unavailable.deletions), (0, 0));
}

#[test]
fn git_status_for_preparation_skips_line_stats_and_history() {
    let repo = tempfile::tempdir().unwrap();
    init_git_repo(repo.path());
    fs::write(repo.path().join("tracked.txt"), "alpha\n").unwrap();
    run_git(repo.path(), &["add", "."]);
    run_git(repo.path(), &["commit", "-m", "base"]);
    fs::write(repo.path().join("untracked.txt"), "one\ntwo\n").unwrap();

    let prepared = git_status_for_preparation(repo.path().to_str().unwrap()).unwrap();
    assert!(prepared.available);
    assert!(prepared
        .files
        .iter()
        .any(|file| file.path == "untracked.txt"));
    assert_eq!((prepared.additions, prepared.deletions), (0, 0));
    assert!(prepared.history.is_empty());
    assert!(prepared.compared_to_main.is_none());

    let full = git_status_impl(repo.path().to_str().unwrap()).unwrap();
    assert!(full.additions >= 2);
    assert!(!full.history.is_empty());
}

#[test]
fn git_status_reuses_decorations_until_porcelain_changes() {
    let repo = tempfile::tempdir().unwrap();
    init_git_repo(repo.path());
    fs::write(repo.path().join("tracked.txt"), "alpha\n").unwrap();
    run_git(repo.path(), &["add", "."]);
    run_git(repo.path(), &["commit", "-m", "base"]);
    fs::write(repo.path().join("tracked.txt"), "alpha\nbeta\n").unwrap();

    let first = git_status_impl(repo.path().to_str().unwrap()).unwrap();
    let second = git_status_impl(repo.path().to_str().unwrap()).unwrap();
    assert_eq!(first.additions, second.additions);
    assert_eq!(first.deletions, second.deletions);
    assert_eq!(first.files, second.files);
    assert_eq!(first.history, second.history);

    fs::write(repo.path().join("tracked.txt"), "alpha\nbeta\ngamma\n").unwrap();
    let third = git_status_impl(repo.path().to_str().unwrap()).unwrap();
    assert!(third.additions > first.additions);
    assert!(third
        .files
        .iter()
        .any(|file| file.path == "tracked.txt" && file.additions >= 2));
}

#[test]
fn git_status_failure_keeps_the_last_snapshot_for_the_repository() {
    let repo = tempfile::tempdir().unwrap();
    init_git_repo(repo.path());
    fs::write(repo.path().join("tracked.txt"), "alpha\n").unwrap();
    run_git(repo.path(), &["add", "."]);
    run_git(repo.path(), &["commit", "-m", "base"]);
    fs::write(repo.path().join("tracked.txt"), "alpha\nbeta\n").unwrap();

    let read = git_status_impl(repo.path().to_str().unwrap()).unwrap();
    assert!(read.available);
    assert!(read.files.iter().any(|file| file.path == "tracked.txt"));
    let repo_root = git_repo_root(&workspace_root(repo.path().to_str().unwrap()).unwrap()).unwrap();

    // A read that ran out of budget reports what the last one saw instead of
    // an empty change list, so the panel keeps its changes and decorations.
    let stalled = git_status_read_failure(
        Some(&repo_root),
        "could not inspect Git status timed out".into(),
        true,
    );
    assert!(stalled.available);
    assert_eq!(stalled.files, read.files);
    assert!(stalled
        .error
        .unwrap()
        .contains("showing the last known changes"));

    // An answer from git — a directory that is not a repository — replaces
    // the snapshot as before.
    let unavailable = git_status_read_failure(
        Some(&repo_root),
        "could not inspect Git status exited with Some(128)".into(),
        false,
    );
    assert!(!unavailable.available);
    assert!(unavailable.files.is_empty());
    assert!(unavailable.error.is_some());
}

#[test]
fn git_status_counts_large_untracked_files() {
    let repo = tempfile::tempdir().unwrap();
    init_git_repo(repo.path());
    fs::write(repo.path().join("ok.txt"), "one\n").unwrap();
    run_git(repo.path(), &["add", "."]);
    run_git(repo.path(), &["commit", "-m", "base"]);
    fs::write(repo.path().join("ok.txt"), "one\ntwo\n").unwrap();
    fs::write(repo.path().join("huge.txt"), vec![b'x'; 2 * 1024 * 1024]).unwrap();

    let status = git_status_impl(repo.path().to_str().unwrap()).unwrap();
    assert!(!status.stats_partial);
    assert_eq!(status.additions, 2);
    assert!(status
        .files
        .iter()
        .any(|file| file.path == "ok.txt" && file.additions == 1));
    assert!(status
        .files
        .iter()
        .any(|file| file.path == "huge.txt" && file.additions == 1));
    let comparison = status.compared_to_main.unwrap();
    assert!(!comparison.partial);
    assert_eq!((comparison.additions, comparison.deletions), (1, 0));
}

#[test]
fn git_status_parser_splits_index_and_worktree_sides() {
    let status = parse_git_status_v2(
        "# branch.head main\n\
             1 MM N... 100644 100644 100644 aaaa bbbb src/app.rs\n\
             1 D. N... 100644 000000 000000 aaaa bbbb docs/old.md\n\
             1 .M N... 100644 100644 100644 aaaa bbbb site/app.js\n",
    );
    let staged = status
        .files
        .iter()
        .filter(|file| file.staged)
        .map(|file| (file.path.as_str(), file.state.as_str()))
        .collect::<Vec<_>>();
    let unstaged = status
        .files
        .iter()
        .filter(|file| !file.staged)
        .map(|file| (file.path.as_str(), file.state.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        staged,
        vec![("src/app.rs", "modified"), ("docs/old.md", "deleted")]
    );
    assert_eq!(
        unstaged,
        vec![("src/app.rs", "modified"), ("site/app.js", "modified")]
    );
}

#[test]
fn git_status_parser_marks_conflicts() {
    let status = parse_git_status_v2(
        "# branch.head main\nu UU N... 100644 100644 100644 100644 a b c conflicted.txt\n",
    );
    assert!(status
        .files
        .iter()
        .any(|file| file.path == "conflicted.txt" && file.state == "conflicted"));
}

#[test]
fn git_status_parser_reads_detached_and_gone_upstreams() {
    let tracking = parse_git_status_v2(
        "# branch.head feature\n# branch.upstream origin/feature\n# branch.ab +2 -1\n",
    );
    assert!(!tracking.upstream_gone);
    assert!(!tracking.detached);
    assert_eq!((tracking.ahead, tracking.behind), (2, 1));

    // No `branch.ab` next to a configured upstream means the remote ref is gone.
    let gone = parse_git_status_v2("# branch.head feature\n# branch.upstream origin/feature\n");
    assert!(gone.upstream_gone);

    let unpublished = parse_git_status_v2("# branch.head feature\n");
    assert!(!unpublished.upstream_gone);

    let detached = parse_git_status_v2("# branch.head (detached)\n");
    assert!(detached.detached);
}

#[test]
fn git_repository_state_reads_operation_and_stash_across_worktrees() {
    let temp = tempfile::tempdir().unwrap();
    let main = temp.path().join("main");
    let git_dir = main.join(".git");
    fs::create_dir_all(git_dir.join("logs/refs")).unwrap();
    fs::write(git_dir.join("logs/refs/stash"), "a\nb\n").unwrap();
    assert_eq!(
        git_repository_state(&main),
        GitRepositoryState {
            operation: None,
            stash_count: 2,
        }
    );

    fs::write(git_dir.join("MERGE_HEAD"), "abc\n").unwrap();
    assert_eq!(git_repository_state(&main).operation, Some("merge"));
    fs::create_dir_all(git_dir.join("rebase-merge")).unwrap();
    assert_eq!(git_repository_state(&main).operation, Some("rebase"));

    // A linked worktree has its own operation markers but shares the stash.
    let linked = temp.path().join("linked");
    let linked_git_dir = git_dir.join("worktrees/linked");
    fs::create_dir_all(&linked).unwrap();
    fs::create_dir_all(&linked_git_dir).unwrap();
    fs::write(
        linked.join(".git"),
        format!("gitdir: {}\n", linked_git_dir.display()),
    )
    .unwrap();
    fs::write(linked_git_dir.join("commondir"), "../..\n").unwrap();
    assert_eq!(
        git_repository_state(&linked),
        GitRepositoryState {
            operation: None,
            stash_count: 2,
        }
    );

    assert_eq!(
        git_repository_state(&temp.path().join("missing")),
        GitRepositoryState::default()
    );
}
