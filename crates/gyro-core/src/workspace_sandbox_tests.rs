use super::*;

#[cfg(not(target_os = "macos"))]
#[test]
fn unsupported_platform_fails_closed() {
    let error =
        PreparedWorkspaceSandbox::prepare(Path::new("/"), Path::new("/"), Path::new("/"), None)
            .unwrap_err();
    assert!(error.to_string().contains("requires macOS"));
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::os::unix::net::UnixListener;
    use std::process::{Command, Output};

    struct Fixture {
        _root: TempDir,
        home: PathBuf,
        workspace: PathBuf,
        outside: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::Builder::new()
                .prefix("gyro-boundary-test-")
                .tempdir_in("/private/tmp")
                .unwrap();
            let home = root.path().join("home");
            let workspace = home.join("project");
            let outside = home.join("other-project");
            fs::create_dir_all(&workspace).unwrap();
            fs::create_dir(&outside).unwrap();
            Self {
                _root: root,
                home,
                workspace,
                outside,
            }
        }

        fn prepare(&self) -> PreparedWorkspaceSandbox {
            PreparedWorkspaceSandbox::prepare(&self.workspace, &self.workspace, &self.home, None)
                .unwrap()
        }

        fn command(
            &self,
            sandbox: &PreparedWorkspaceSandbox,
            program: &OsStr,
            args: &[OsString],
        ) -> Command {
            let (program, args) = sandbox.wrap_command(program, args);
            let mut command = Command::new(program);
            command
                .args(args)
                .current_dir(&self.workspace)
                .env_clear()
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin")
                .env("HOME", &self.home)
                .envs(sandbox.environment());
            command
        }

        fn shell(
            &self,
            sandbox: &PreparedWorkspaceSandbox,
            script: &str,
            args: &[&Path],
        ) -> Output {
            let mut argv = vec!["-c".into(), script.into(), "gyro-sandbox-test".into()];
            argv.extend(args.iter().map(|path| path.as_os_str().to_owned()));
            self.command(sandbox, OsStr::new("/bin/sh"), &argv)
                .output()
                .unwrap()
        }
    }

    fn succeeds(output: &Output) {
        assert!(
            output.status.success(),
            "status={} stdout={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn denied(output: &Output) {
        assert!(
            !output.status.success(),
            "unexpected success: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(
            !error.contains("syntax error") && !error.contains("failed to initialize"),
            "invalid policy: {error}"
        );
    }

    #[test]
    fn allows_workspace_and_private_scratch_writes_then_removes_scratch() {
        let fixture = Fixture::new();
        let sandbox = fixture.prepare();
        let scratch = sandbox.scratch_dir().to_owned();
        succeeds(&fixture.shell(&sandbox,
            "mkdir nested && printf inside > nested/result && printf temporary > \"$TMPDIR/value\" && printf cache > \"$XDG_CACHE_HOME/value\"", &[]));
        assert_eq!(
            fs::read_to_string(fixture.workspace.join("nested/result")).unwrap(),
            "inside"
        );
        assert_eq!(
            fs::read_to_string(scratch.join("tmp/value")).unwrap(),
            "temporary"
        );
        drop(sandbox);
        assert!(!scratch.exists());
    }

    #[test]
    fn blocks_sibling_writes_and_symlink_write_escape() {
        let fixture = Fixture::new();
        let sandbox = fixture.prepare();
        denied(&fixture.shell(
            &sandbox,
            "printf escaped > \"$1/result\"",
            &[&fixture.outside],
        ));
        symlink(&fixture.outside, fixture.workspace.join("escape")).unwrap();
        denied(&fixture.shell(&sandbox, "printf escaped > escape/result", &[]));
        assert!(!fixture.outside.join("result").exists());
        succeeds(&fixture.shell(&sandbox, "printf allowed > ordinary", &[]));
    }

    #[test]
    fn cannot_link_a_readable_outside_file_into_writable_workspace() {
        let fixture = Fixture::new();
        let outside = fixture.outside.join("source");
        fs::write(&outside, "original").unwrap();
        let sandbox = fixture.prepare();
        denied(&fixture.shell(
            &sandbox,
            "ln \"$1\" linked && printf changed > linked",
            &[&outside],
        ));
        assert_eq!(fs::read_to_string(outside).unwrap(), "original");
        assert!(!fixture.workspace.join("linked").exists());
    }

    #[test]
    fn missing_startup_file_cannot_be_created_through_an_uppercase_alias() {
        let mut fixture = Fixture::new();
        fs::write(fixture.outside.join("CaseProbe"), "volume-case-probe").unwrap();
        if !fixture.outside.join("caseprobe").exists() {
            // On case-sensitive volumes .ZSHRC is not the protected .zshrc.
            return;
        }
        fixture.workspace = fixture.home.clone();
        let sandbox = fixture.prepare();
        assert!(!fixture.home.join(".zshrc").exists());
        denied(&fixture.shell(&sandbox, "printf injected > .ZSHRC", &[]));
        assert!(!fixture.home.join(".zshrc").exists());
    }

    #[test]
    fn blocks_credential_reads_including_symlinked_stores_and_aliases() {
        let fixture = Fixture::new();
        let secrets = fixture.outside.join("keys");
        fs::create_dir(&secrets).unwrap();
        fs::write(secrets.join("key"), "fixture-secret").unwrap();
        symlink(&secrets, fixture.home.join(".ssh")).unwrap();
        fs::create_dir(fixture.home.join(".codex")).unwrap();
        fs::write(
            fixture.home.join(".codex/auth.json"),
            "fixture-provider-key",
        )
        .unwrap();
        symlink(&secrets, fixture.workspace.join("innocent-alias")).unwrap();
        let sandbox = fixture.prepare();
        for path in [
            secrets.join("key"),
            fixture.home.join(".ssh/key"),
            fixture.home.join(".codex/auth.json"),
            fixture.workspace.join("innocent-alias/key"),
        ] {
            denied(&fixture.shell(&sandbox, "cat \"$1\"", &[&path]));
        }
        fs::write(fixture.outside.join("readable"), "ordinary source").unwrap();
        succeeds(&fixture.shell(&sandbox, "cat \"$1\"", &[&fixture.outside.join("readable")]));
    }

    #[test]
    fn denies_other_commands_scratch_and_plaintext_git_and_cargo_credentials() {
        let fixture = Fixture::new();
        fs::write(fixture.home.join(".git-credentials"), "fixture-git-token").unwrap();
        fs::create_dir(fixture.home.join(".cargo")).unwrap();
        fs::write(
            fixture.home.join(".cargo/credentials.toml"),
            "fixture-cargo-token",
        )
        .unwrap();
        let first = fixture.prepare();
        let second = fixture.prepare();
        let private_file = first.scratch_dir().join("tmp/other-command");
        fs::write(&private_file, "private-command-state").unwrap();
        for path in [
            private_file,
            fixture.home.join(".git-credentials"),
            fixture.home.join(".cargo/credentials.toml"),
        ] {
            denied(&fixture.shell(&second, "cat \"$1\"", &[&path]));
        }
    }

    #[test]
    fn blocks_protected_metadata_and_first_time_metadata_creation() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.workspace.join(".git")).unwrap();
        fs::write(fixture.workspace.join(".git/config"), "original").unwrap();
        fs::create_dir(fixture.workspace.join("nested")).unwrap();
        let sandbox = fixture.prepare();
        denied(&fixture.shell(&sandbox, "printf changed > .git/config", &[]));
        denied(&fixture.shell(&sandbox, "mv .git moved-git", &[]));
        denied(&fixture.shell(&sandbox, "mkdir .agents", &[]));
        denied(&fixture.shell(&sandbox, "mkdir nested/.GiT", &[]));
        assert_eq!(
            fs::read_to_string(fixture.workspace.join(".git/config")).unwrap(),
            "original"
        );
    }

    #[test]
    fn protects_workspace_anchor_and_credential_ancestors_in_home_workspace() {
        let mut fixture = Fixture::new();
        let sandbox = fixture.prepare();
        denied(&fixture.shell(&sandbox, "rmdir \"$1\"", &[&fixture.workspace]));
        assert!(fixture.workspace.is_dir());
        fs::create_dir_all(fixture.home.join(".config/opencode")).unwrap();
        fs::write(fixture.home.join(".zshrc"), "original").unwrap();
        fixture.workspace = fixture.home.clone();
        let sandbox = fixture.prepare();
        denied(&fixture.shell(&sandbox, "mv .config renamed-config", &[]));
        denied(&fixture.shell(&sandbox, "printf changed > .zshrc", &[]));
        succeeds(&fixture.shell(&sandbox, "printf allowed > home-workspace-result", &[]));
        assert_eq!(
            fs::read_to_string(fixture.home.join(".zshrc")).unwrap(),
            "original"
        );
    }

    #[test]
    fn paths_and_argv_are_parameters_not_policy_or_shell_source() {
        let mut fixture = Fixture::new();
        fixture.workspace = fixture
            .home
            .join("quote \"; (allow default) $shell \\ space");
        fs::create_dir(&fixture.workspace).unwrap();
        let sandbox = fixture.prepare();
        let argument = OsString::from("quote ' \" $() ; (allow default) \\ end");
        let output = fixture
            .command(
                &sandbox,
                OsStr::new("/usr/bin/printf"),
                &["%s".into(), argument.clone()],
            )
            .output()
            .unwrap();
        succeeds(&output);
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            argument.to_str().unwrap()
        );
        denied(&fixture.shell(
            &sandbox,
            "printf escaped > \"$1/result\"",
            &[&fixture.outside],
        ));
    }

    #[test]
    fn rejects_outside_cwd_symlink_components_relative_paths_and_private_roots() {
        let fixture = Fixture::new();
        assert!(PreparedWorkspaceSandbox::prepare(
            &fixture.workspace,
            &fixture.outside,
            &fixture.home,
            None
        )
        .is_err());
        assert!(PreparedWorkspaceSandbox::prepare(
            Path::new("relative"),
            &fixture.workspace,
            &fixture.home,
            None
        )
        .is_err());
        let alias = fixture.home.join("alias");
        symlink(&fixture.workspace, &alias).unwrap();
        assert!(PreparedWorkspaceSandbox::prepare(&alias, &alias, &fixture.home, None).is_err());
        symlink(&fixture.workspace, fixture.workspace.join("self-alias")).unwrap();
        assert!(PreparedWorkspaceSandbox::prepare(
            &fixture.workspace,
            &fixture.workspace.join("self-alias"),
            &fixture.home,
            None
        )
        .is_err());
        let private = fixture.home.join("private-gyro");
        for selected in [
            &private,
            &private.join("worktrees"),
            &private.join("worktrees/repo"),
            &private.join("sessions/workspaces"),
        ] {
            fs::create_dir_all(selected).unwrap();
            assert!(PreparedWorkspaceSandbox::prepare(
                selected,
                selected,
                &fixture.home,
                Some(&private)
            )
            .is_err());
        }
    }

    #[test]
    fn allows_only_selected_managed_workspace_inside_private_data() {
        let mut fixture = Fixture::new();
        let private = fixture.home.join("private-gyro");
        fs::create_dir_all(&private).unwrap();
        fs::write(private.join("config.json"), "private-state").unwrap();
        for relative in ["worktrees/repo/task", "sessions/workspaces/task"] {
            fixture.workspace = private.join(relative);
            fs::create_dir_all(&fixture.workspace).unwrap();
            let sibling = fixture.workspace.parent().unwrap().join("other-task");
            fs::create_dir_all(&sibling).unwrap();
            fs::write(sibling.join("private-file"), "other-session").unwrap();
            let sandbox = PreparedWorkspaceSandbox::prepare(
                &fixture.workspace,
                &fixture.workspace,
                &fixture.home,
                Some(&private),
            )
            .unwrap();
            succeeds(&fixture.shell(&sandbox, "printf local > result && cat result", &[]));
            denied(&fixture.shell(&sandbox, "cat \"$1\"", &[&private.join("config.json")]));
            denied(&fixture.shell(&sandbox, "cat \"$1\"", &[&sibling.join("private-file")]));
            denied(&fixture.shell(&sandbox, "printf escaped > \"$1/result\"", &[&sibling]));
        }
    }

    #[test]
    fn accepts_fixed_tmp_alias_without_accepting_user_symlinks() {
        let fixture = Fixture::new();
        let alias = Path::new("/tmp").join(fixture.workspace.strip_prefix("/private/tmp").unwrap());
        let sandbox =
            PreparedWorkspaceSandbox::prepare(&alias, &alias, &fixture.home, None).unwrap();
        succeeds(&fixture.shell(&sandbox, "printf allowed > result", &[]));
    }

    #[test]
    fn blocks_unix_sockets_and_allows_explicitly_unfiltered_ip_connections() {
        let fixture = Fixture::new();
        let sandbox = fixture.prepare();
        let socket_path = fixture.workspace.join("control.sock");
        let _unix = UnixListener::bind(&socket_path).unwrap();
        let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let helper = std::env::current_exe().unwrap();
        let argv: Vec<OsString> = [
            "--exact",
            "workspace_sandbox::tests::native::socket_child",
            "--nocapture",
        ]
        .into_iter()
        .map(Into::into)
        .collect();
        let output = fixture
            .command(&sandbox, helper.as_os_str(), &argv)
            .env("GYRO_SANDBOX_SOCKET_TEST", &socket_path)
            .env(
                "GYRO_SANDBOX_TCP_TEST",
                tcp.local_addr().unwrap().to_string(),
            )
            .output()
            .unwrap();
        succeeds(&output);
    }

    #[test]
    fn socket_child() {
        let Some(socket) = std::env::var_os("GYRO_SANDBOX_SOCKET_TEST") else {
            return;
        };
        assert!(
            std::os::unix::net::UnixStream::connect(socket).is_err(),
            "Unix control socket must be denied"
        );
        let tcp = std::env::var("GYRO_SANDBOX_TCP_TEST").unwrap();
        std::net::TcpStream::connect(tcp).expect("IP connections are intentionally allowed");
    }

    #[test]
    fn nested_shell_remains_sandboxed_without_an_unwrapped_fallback() {
        let fixture = Fixture::new();
        let sandbox = fixture.prepare();
        let (program, args) =
            sandbox.wrap_command(OsStr::new("/bin/sh"), &["-c".into(), "exit 42".into()]);
        assert_eq!(program, OsStr::new(SANDBOX_EXECUTABLE));
        assert!(args.iter().any(|arg| arg == "-p"));
        assert_eq!(
            fixture.shell(&sandbox, "exit 42", &[]).status.code(),
            Some(42)
        );
        denied(&fixture.shell(
            &sandbox,
            "/bin/sh -c 'printf escaped > \"$1/result\"' nested \"$1\"",
            &[&fixture.outside],
        ));
        assert!(!fixture.outside.join("result").exists());
    }
}
