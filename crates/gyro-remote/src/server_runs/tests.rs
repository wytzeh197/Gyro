use super::*;
use crate::{ssh::exec::Remote, store::Store};
use std::{os::unix::fs::PermissionsExt, path::PathBuf, process::Command as StdCommand};

fn options(host: &str) -> Options {
    Options {
        host: host.into(),
        user: None,
        port: None,
        identity_file: None,
        socket_path: None,
    }
}
fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}
/// An `ssh` stand-in that runs the remote command locally with HOME set to
/// `home`, the way sshd would run it on the server.
fn local_host(dir: &Path) -> (RunnerHost, PathBuf) {
    let home = dir.join("server-home");
    std::fs::create_dir_all(&home).unwrap();
    let program = script(
        dir,
        "fake-ssh",
        &format!(
            "for last; do :; done\nHOME={} exec /bin/sh -c \"$last\"",
            crate::ssh::shell_quote(home.to_str().unwrap())
        ),
    );
    let remote = Remote::with_program(options("server"), &program, Vec::new()).unwrap();
    (RunnerHost::with_remote(remote), home)
}
pub(super) fn fake_agent() -> String {
    concat!(env!("CARGO_MANIFEST_DIR"), "/runner/testdata/fake_agent.py").into()
}
pub(super) fn git_in(dir: &Path, args: &[&str]) -> String {
    let output = StdCommand::new("git")
        .current_dir(dir)
        .env_remove("GIT_DIR")
        .env_remove("GIT_INDEX_FILE")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
        ])
        .args([
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
/// A repo with a commit, an unstaged edit, a staged file, an untracked file
/// and an ignored file.
pub(super) fn messy_repo(dir: &Path) -> PathBuf {
    let repo = dir.join("my app");
    std::fs::create_dir_all(&repo).unwrap();
    git_in(&repo, &["init", "--quiet"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    std::fs::write(repo.join(".gitignore"), "ignored.txt\n").unwrap();
    git_in(&repo, &["add", "-A"]);
    git_in(&repo, &["commit", "--quiet", "-m", "first"]);
    std::fs::write(repo.join("a.txt"), "two\n").unwrap();
    std::fs::write(repo.join("staged.txt"), "staged\n").unwrap();
    git_in(&repo, &["add", "staged.txt"]);
    std::fs::write(repo.join("new.txt"), "untracked\n").unwrap();
    std::fs::write(repo.join("ignored.txt"), "secret-ish\n").unwrap();
    repo
}
/// Everything about the user's checkout that a run must leave alone.
pub(super) fn checkout_state(repo: &Path) -> Vec<String> {
    vec![
        git_in(
            repo,
            &[
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
                "--ignored",
            ],
        ),
        git_in(repo, &["diff", "--cached"]),
        git_in(repo, &["diff"]),
        git_in(repo, &["rev-parse", "HEAD"]),
        git_in(repo, &["symbolic-ref", "HEAD"]),
        git_in(repo, &["stash", "list"]),
    ]
}

#[test]
fn exec_and_terminal_arguments_keep_the_command_one_argument() {
    let mut o = options("box");
    o.user = Some("dev".into());
    o.port = Some(2222);
    let args = o.exec_arguments("python3 x; rm -rf /").unwrap();
    assert_eq!(args[0], "-T");
    assert_eq!(
        &args[args.len() - 3..],
        ["--", "box", "python3 x; rm -rf /"]
    );
    assert!(args.contains(&"RequestTTY=no".into()));
    assert!(args.contains(&"ClearAllForwardings=yes".into()));
    assert!(args.contains(&"BatchMode=yes".into()));
    let at = args.iter().position(|a| a == "-p").unwrap();
    assert_eq!(args[at + 1], "2222");

    let args = o.terminal_arguments("claude").unwrap();
    assert_eq!(args[0], "-t");
    assert!(args.contains(&"RequestTTY=yes".into()));
    assert!(!args.contains(&"RequestTTY=no".into()));
    assert_eq!(&args[args.len() - 3..], ["--", "box", "claude"]);

    for host in ["-oProxyCommand=x", "a b", "a;b", "user@box", ""] {
        assert!(options(host).exec_arguments("true").is_err(), "{host:?}");
        assert!(
            options(host).terminal_arguments("true").is_err(),
            "{host:?}"
        );
    }
}

#[test]
fn extra_options_come_first_so_they_win() {
    let remote = Remote::with_program(
        options("box"),
        Path::new("/usr/bin/ssh"),
        vec!["-o".into(), "UserKnownHostsFile=/k".into()],
    )
    .unwrap();
    let args = remote.exec_arguments("true").unwrap();
    assert_eq!(&args[..3], ["-T", "-o", "UserKnownHostsFile=/k"]);
}

#[test]
fn git_ssh_command_quotes_every_part() {
    let mut o = options("box");
    o.identity_file = Some("/Users/me/my key's/id".into());
    let remote = Remote::with_program(o, Path::new("/opt/my ssh/ssh"), Vec::new()).unwrap();
    let command = remote.git_ssh_command().unwrap();
    assert!(command.starts_with("'/opt/my ssh/ssh' '-T' '-o' 'BatchMode=yes'"));
    assert!(command.contains("'/Users/me/my key'\\''s/id'"));
    assert!(!command.contains("box"), "git adds the destination itself");
    // The shell must split it back into the exact arguments.
    let output = StdCommand::new("/bin/sh")
        .args([
            "-c",
            &format!(
                "printf '%s\\n' {}",
                command.replacen("'/opt/my ssh/ssh' ", "", 1)
            ),
        ])
        .output()
        .unwrap();
    let parts: Vec<String> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(String::from)
        .collect();
    assert_eq!(parts[0], "-T");
    assert!(parts.contains(&"/Users/me/my key's/id".to_string()));
}

#[test]
fn git_urls_point_under_home_and_reject_odd_paths() {
    let remote = Remote::new(options("box.local")).unwrap();
    assert_eq!(
        remote.git_url(".gyro/repos/app-1.git").unwrap(),
        "ssh://box.local/~/.gyro/repos/app-1.git"
    );
    let remote = Remote::new(options("::1")).unwrap();
    assert_eq!(remote.git_url("r.git").unwrap(), "ssh://[::1]/~/r.git");
    for path in ["/etc/x", "a/../b", "a//b", "a b", "a;b", "", "a/'b"] {
        assert!(remote.git_url(path).is_err(), "{path:?}");
    }
}

#[test]
fn replies_parse_and_refusals_keep_their_code() {
    let ok = parse_reply(Some(0), b"noise\n{\"ok\":true,\"x\":1}\n\n", "").unwrap();
    assert_eq!(ok["x"], 1);
    let error = parse_reply(
        Some(2),
        b"{\"ok\":false,\"error\":\"busy\",\"message\":\"another run\"}\n",
        "",
    )
    .unwrap_err();
    assert_eq!(runner_error_code(&error), Some("busy"));
    assert_eq!(error.to_string(), "another run");

    let error = parse_reply(Some(127), b"", "sh: 1: python3: not found").unwrap_err();
    assert!(error.to_string().contains("Python 3 is not installed"));
    let error = parse_reply(
        Some(2),
        b"",
        "python3: can't open file '/home/dev/.gyro/runner/gyro_runner.py': [Errno 2]",
    )
    .unwrap_err();
    assert_eq!(runner_error_code(&error), Some("runner_missing"));
    let error = parse_reply(Some(1), b"not json", "Traceback\nValueError: boom\n").unwrap_err();
    assert_eq!(runner_error_code(&error), None);
    assert!(error.to_string().ends_with("ValueError: boom"));
    // ok:true with a failing exit code is not success.
    assert!(parse_reply(Some(3), b"{\"ok\":true}", "").is_err());
}

#[test]
fn events_decode_and_unknown_kinds_are_skipped() {
    let line: EventLine = serde_json::from_str(r#"{"t":5,"kind":"out","line":"hi"}"#).unwrap();
    assert_eq!(
        line.event,
        RunEvent::Out {
            line: "hi".into(),
            cut: false
        }
    );
    let line: EventLine = serde_json::from_str(
        r#"{"t":6,"kind":"end","state":"done","reason":null,"exit_code":0,"result_commit":"ab","changed":true}"#,
    )
    .unwrap();
    assert!(matches!(
        line.event,
        RunEvent::End {
            state: RunState::Done,
            changed: Some(true),
            ..
        }
    ));
    let line: EventLine = serde_json::from_str(r#"{"t":7,"kind":"usage","tokens":3}"#).unwrap();
    assert_eq!(line.event, RunEvent::Unknown);
    assert!(RunState::Lost.is_terminal());
    assert!(!RunState::Committing.is_terminal());
}

#[test]
fn sign_in_signals_match_phase_zero() {
    let out = |line: &str| RunEvent::Out {
        line: line.into(),
        cut: false,
    };
    assert!(needs_sign_in(
        "codex",
        &out(r#"{"type":"turn.failed","error":{"message":"401 Unauthorized"}}"#)
    ));
    assert!(!needs_sign_in(
        "codex",
        &out(r#"{"type":"turn.failed","error":{"message":"rate limit"}}"#)
    ));
    assert!(needs_sign_in(
        "claude",
        &out("Not logged in · Please run /login")
    ));
    assert!(needs_sign_in(
        "cursor",
        &out("Error: Authentication required.")
    ));
    let end = |code| RunEvent::End {
        state: RunState::Failed,
        reason: None,
        exit_code: Some(code),
        result_commit: None,
        changed: None,
    };
    assert!(needs_sign_in("gemini", &end(41)));
    assert!(!needs_sign_in("gemini", &end(1)));
    assert!(!needs_sign_in("claude", &out("all good")));
}

#[test]
fn names_and_project_names_fit_the_runner() {
    assert!(valid_name(&new_run_id()));
    for bad in ["", "-x", "a b", "a/b", "a.b", &"a".repeat(65)] {
        assert!(!valid_name(bad), "{bad:?}");
    }
    let a = project_name(Path::new("/Users/me/code/my app!"));
    let b = project_name(Path::new("/Users/me/other/my app!"));
    assert!(a.starts_with("my-app--"), "{a}");
    assert_ne!(a, b);
    assert!(valid_name(&a));
    assert!(valid_name(&project_name(Path::new("/x/.hidden"))));
    assert!(valid_name(&project_name(Path::new(&format!(
        "/x/{}",
        "é".repeat(80)
    )))));
    assert!(valid_name(&project_name(Path::new("/"))));
}

#[tokio::test]
async fn ssh_failures_and_timeouts_become_plain_errors() {
    let dir = tempfile::tempdir().unwrap();
    let refused = script(
        dir.path(),
        "refused",
        "echo 'ssh: connect to host box port 22: Connection refused' >&2; exit 255",
    );
    let remote = Remote::with_program(options("box"), &refused, Vec::new()).unwrap();
    let error = remote
        .run("true", b"", Duration::from_secs(5))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("connection refused"), "{error}");

    let slow = script(dir.path(), "slow", "exec sleep 30");
    let remote = Remote::with_program(options("box"), &slow, Vec::new()).unwrap();
    let error = remote
        .run("true", b"", Duration::from_millis(300))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("did not answer in time"));

    // Input goes over stdin, even when the far side never reads it.
    let echo = script(dir.path(), "echo", "cat; echo err >&2; exit 4");
    let remote = Remote::with_program(options("box"), &echo, Vec::new()).unwrap();
    let output = remote
        .run("ignored", b"hello", Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(
        (
            output.code,
            output.stdout.as_slice(),
            output.stderr.as_str()
        ),
        (Some(4), &b"hello"[..], "err\n")
    );
    let deaf = script(dir.path(), "deaf", "exit 0");
    let remote = Remote::with_program(options("box"), &deaf, Vec::new()).unwrap();
    let big = vec![b'x'; 4 * 1024 * 1024];
    assert_eq!(
        remote
            .run("x", &big, Duration::from_secs(5))
            .await
            .unwrap()
            .code,
        Some(0)
    );
}

#[tokio::test]
async fn snapshot_includes_the_working_tree_and_leaves_the_checkout_alone() {
    let dir = tempfile::tempdir().unwrap();
    let repo = messy_repo(dir.path());
    let before = checkout_state(&repo);
    let snapshot = git::snapshot(&repo.join(".")).await.unwrap();
    assert_eq!(checkout_state(&repo), before);
    assert_eq!(
        snapshot.root.canonicalize().unwrap(),
        repo.canonicalize().unwrap()
    );
    let head = git_in(&repo, &["rev-parse", "HEAD"]);
    assert_eq!(snapshot.head.as_deref(), Some(head.trim()));
    assert_eq!(
        git_in(&repo, &["rev-parse", &format!("{}^", snapshot.commit)]),
        head
    );
    let files = git_in(&repo, &["ls-tree", "-r", "--name-only", &snapshot.commit]);
    assert_eq!(files, ".gitignore\na.txt\nnew.txt\nstaged.txt\n");
    assert_eq!(
        git_in(&repo, &["show", &format!("{}:a.txt", snapshot.commit)]),
        "two\n"
    );

    // A repo with no commits yet snapshots too, with no parent.
    let empty = dir.path().join("empty");
    std::fs::create_dir(&empty).unwrap();
    git_in(&empty, &["init", "--quiet"]);
    std::fs::write(empty.join("f"), "x").unwrap();
    let snapshot = git::snapshot(&empty).await.unwrap();
    assert_eq!(snapshot.head, None);
    assert_eq!(
        git_in(&empty, &["ls-tree", "--name-only", &snapshot.commit]),
        "f\n"
    );
    assert_eq!(git_in(&empty, &["status", "--porcelain"]), "?? f\n");

    assert!(git::snapshot(dir.path()).await.is_err(), "not a repo");
}

#[test]
fn server_runs_round_trip_in_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let mut run = ServerRun {
        id: new_run_id(),
        host_id: "host-1".into(),
        project: "app-0123456789".into(),
        repo: "/Users/me/app".into(),
        cli: "codex".into(),
        state: RunState::Running,
        offset: 0,
        result_branch: "gyro/cloud/x".into(),
        result_commit: None,
        created_at: 1,
    };
    store.save_server_run(&run).unwrap();
    run.offset = 512;
    run.state = RunState::Done;
    store.save_server_run(&run).unwrap();
    drop(store);
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(store.server_runs().unwrap(), vec![run.clone()]);
    store.remove_server_run(&run.id).unwrap();
    assert!(store.server_runs().unwrap().is_empty());
    run.id = "../x".into();
    assert!(store.save_server_run(&run).is_err());
}

async fn drain(attach: &mut Attach) -> Vec<Event> {
    let mut events = Vec::new();
    while let Some(event) = attach.next().await.unwrap() {
        events.push(event);
    }
    events
}

/// The whole life of a run: install, launch, stream, reattach, fetch, stop,
/// clean up. Shared with the Docker test, which runs it over real SSH.
pub(super) async fn exercise(host: &RunnerHost, agent: &[String], work: &Path) {
    let installed = host.ensure_runner().await.unwrap();
    assert!(installed.uploaded);
    assert_eq!(installed.doctor.runner_sha256, runner_sha256());
    let again = host.ensure_runner().await.unwrap();
    assert!(
        !again.uploaded,
        "an up-to-date runner is not uploaded again"
    );
    let doctor = host
        .doctor(&[
            CliProbe {
                id: "fake".into(),
                binary: agent[0].clone(),
                version_argv: None,
            },
            CliProbe {
                id: "nope".into(),
                binary: "gyro-no-such-cli".into(),
                version_argv: None,
            },
        ])
        .await
        .unwrap();
    assert!(doctor.clis[0].found);
    assert!(!doctor.clis[1].found);
    let check = |extra: &[&str], rule: SignInRule| SignInCheck {
        argv: agent
            .iter()
            .cloned()
            .chain(extra.iter().map(|s| s.to_string()))
            .collect(),
        signed_in: rule,
        timeout_seconds: Some(10),
    };
    let matching = SignInRule {
        matches: Some("^Logged in".into()),
        ..Default::default()
    };
    let status = host
        .sign_in_status(&check(
            &["--say", "Logged in as a@b.c", "x"],
            matching.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(
        status,
        SignInStatus {
            found: true,
            signed_in: Some(true),
            error: None
        }
    );
    let status = host
        .sign_in_status(&check(&["--say", "Not logged in", "x"], matching))
        .await
        .unwrap();
    assert_eq!(status.signed_in, Some(false));
    let exit = SignInRule {
        exit: Some(0),
        ..Default::default()
    };
    let status = host
        .sign_in_status(&check(&["--exit", "41", "x"], exit))
        .await
        .unwrap();
    assert_eq!(status.signed_in, Some(false));
    let mut missing = check(&["x"], SignInRule::default());
    missing.argv[0] = "gyro-no-such-cli".into();
    assert!(!host.sign_in_status(&missing).await.unwrap().found);

    let repo = messy_repo(work);
    let before = checkout_state(&repo);
    let marker = work.join("pwned");
    let task = format!(
        "Fix it'; touch {m}; $(touch {m}) `touch {m}`\n\"second\" line\\ {{task}} ünïcode",
        m = marker.display()
    );
    let argv = |extra: &[&str]| -> Vec<String> {
        agent
            .iter()
            .cloned()
            .chain(extra.iter().map(|s| s.to_string()))
            .collect()
    };
    let id = new_run_id();
    let request = RunRequest {
        cli: "fake".into(),
        task: task.clone(),
        argv: argv(&[
            "--say",
            "hello",
            "--lines",
            "3",
            "--edit",
            "result.txt",
            "{task}",
        ]),
        env: BTreeMap::new(),
        timeout_seconds: Some(120),
        idle_seconds: None,
        allow_parallel: false,
    };
    let started = host.launch(&repo, &id, &request).await.unwrap();
    assert_eq!(started.result_branch, format!("gyro/cloud/{id}"));

    let mut attach = host.attach(&id, 0).await.unwrap();
    let events = drain(&mut attach).await;
    let Some(Event {
        event:
            RunEvent::End {
                state,
                result_commit,
                changed,
                ..
            },
        ..
    }) = events.last().cloned()
    else {
        panic!("no end event: {events:?}");
    };
    assert_eq!(state, RunState::Done);
    assert_eq!(changed, Some(true));
    let lines: Vec<&str> = events
        .iter()
        .filter_map(|e| match &e.event {
            RunEvent::Out { line, .. } => Some(line.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(lines, ["hello", "line 0", "line 1", "line 2"]);
    assert!(!marker.exists(), "the task text reached a shell");

    // Reattaching replays the same bytes, from the start or mid-way.
    let replay = drain(&mut host.attach(&id, 0).await.unwrap()).await;
    assert_eq!(replay, events);
    let tail = drain(&mut host.attach(&id, events[1].offset).await.unwrap()).await;
    assert_eq!(tail, events[2..]);
    let mut past = host.attach(&id, 1 << 40).await.unwrap();
    assert_eq!(
        runner_error_code(&past.next().await.unwrap_err()),
        Some("bad_offset")
    );
    let mut missing = host.attach("no-such-run", 0).await.unwrap();
    assert_eq!(
        runner_error_code(&missing.next().await.unwrap_err()),
        Some("no_run")
    );

    let shown = host.show(&id).await.unwrap();
    assert_eq!(shown.state, RunState::Done);
    assert_eq!(shown.result_commit, result_commit);
    assert!(host.list().await.unwrap().iter().any(|run| run.id == id));

    let project = project_name(&repo.canonicalize().unwrap());
    let fetched = host.fetch_result(&repo, &project, &id).await.unwrap();
    assert_eq!(Some(fetched.clone()), result_commit);
    assert_eq!(
        checkout_state(&repo),
        before,
        "fetching must not touch the checkout"
    );
    let branch = format!("gyro/cloud/{id}");
    assert_eq!(
        git_in(&repo, &["show", &format!("{branch}:result.txt")]),
        task
    );
    assert_eq!(
        git_in(&repo, &["show", &format!("{branch}:a.txt")]),
        "two\n"
    );
    assert_eq!(
        git_in(&repo, &["show", &format!("{branch}:new.txt")]),
        "untracked\n"
    );
    let files = git_in(&repo, &["ls-tree", "-r", "--name-only", &branch]);
    assert!(!files.contains("ignored.txt"));

    // A long run: drop the stream mid-run, reattach, then stop it.
    let long = new_run_id();
    let request = RunRequest {
        argv: argv(&["--lines", "600", "--interval", "0.05", "{task}"]),
        task: "long".into(),
        ..request
    };
    host.launch(&repo, &long, &request).await.unwrap();
    let busy = host
        .launch(&repo, &new_run_id(), &request)
        .await
        .unwrap_err();
    assert_eq!(runner_error_code(&busy), Some("busy"));
    let mut attach = host.attach(&long, 0).await.unwrap();
    let mut seen = Vec::new();
    while seen.len() < 4 {
        seen.push(attach.next().await.unwrap().unwrap());
    }
    attach.close();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut attach = host
        .attach(&long, seen.last().unwrap().offset)
        .await
        .unwrap();
    let next = attach.next().await.unwrap().unwrap();
    assert!(
        matches!(&next.event, RunEvent::Out { line, .. } if line.starts_with("line ")),
        "{next:?}"
    );
    assert!(host.show(&long).await.unwrap().state == RunState::Running);
    host.stop(&long).await.unwrap();
    let rest = drain(&mut attach).await;
    assert!(
        matches!(
            rest.last().map(|e| &e.event),
            Some(RunEvent::End {
                state: RunState::Stopped,
                ..
            })
        ),
        "{:?}",
        rest.last()
    );
    assert_eq!(host.show(&long).await.unwrap().state, RunState::Stopped);

    host.cleanup(&id, false).await.unwrap();
    host.cleanup(&long, true).await.unwrap();
    assert_eq!(
        runner_error_code(&host.show(&id).await.unwrap_err()),
        Some("no_run")
    );
    assert!(!host
        .list()
        .await
        .unwrap()
        .iter()
        .any(|run| run.id == id || run.id == long));
    assert_eq!(checkout_state(&repo), before);
}

#[tokio::test]
async fn a_whole_run_through_a_local_stand_in_for_ssh() {
    let dir = tempfile::tempdir().unwrap();
    let (host, home) = local_host(dir.path());
    exercise(&host, &["python3".into(), fake_agent()], dir.path()).await;
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&home.join(".gyro")), 0o700);
    assert_eq!(mode(&home.join(".gyro/runner/gyro_runner.py")), 0o600);
    assert_eq!(
        std::fs::read_to_string(home.join(".gyro/runner/gyro_runner.py")).unwrap(),
        RUNNER
    );
}
