//! The run flow over real OpenSSH, against the Docker sshd that
//! `runner/testdata/e2e.sh` starts. Skipped unless that script set the
//! GYRO_RUNNER_E2E_* variables.
use super::tests::exercise;
use super::*;
use crate::ssh::exec::Remote;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

#[tokio::test]
async fn a_whole_run_over_real_ssh_against_docker() {
    let (Some(host), Some(port), Some(user), Some(identity), Some(known_hosts)) = (
        env("GYRO_RUNNER_E2E_HOST"),
        env("GYRO_RUNNER_E2E_PORT"),
        env("GYRO_RUNNER_E2E_USER"),
        env("GYRO_RUNNER_E2E_IDENTITY"),
        env("GYRO_RUNNER_E2E_KNOWN_HOSTS"),
    ) else {
        eprintln!("skipped: run runner/testdata/e2e.sh to test against a Docker sshd");
        return;
    };
    let options = Options {
        host,
        user: Some(user),
        port: Some(port.parse().unwrap()),
        identity_file: Some(identity),
        socket_path: None,
    };
    // `-F /dev/null` keeps the user's ~/.ssh/config out of the test, and a
    // private known_hosts keeps ~/.ssh/known_hosts untouched.
    let extra = vec![
        "-F".into(),
        "/dev/null".into(),
        "-o".into(),
        format!("UserKnownHostsFile={known_hosts}"),
        "-o".into(),
        "GlobalKnownHostsFile=/dev/null".into(),
    ];
    let remote = Remote::with_program(options, Path::new("/usr/bin/ssh"), extra).unwrap();
    let host = RunnerHost::with_remote(remote);
    let work = tempfile::tempdir().unwrap();
    exercise(&host, &["fake-agent".into()], work.path()).await;

    // A host key the Mac does not trust is refused, with a plain message.
    let stranger = tempfile::NamedTempFile::new().unwrap();
    let mut options = host.remote().options().clone();
    options.host = "127.0.0.1".into();
    let remote = Remote::with_program(
        options,
        Path::new("/usr/bin/ssh"),
        vec![
            "-F".into(),
            "/dev/null".into(),
            "-o".into(),
            format!("UserKnownHostsFile={}", stranger.path().display()),
            "-o".into(),
            "GlobalKnownHostsFile=/dev/null".into(),
        ],
    )
    .unwrap();
    let error = RunnerHost::with_remote(remote)
        .ensure_runner()
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("host key is not trusted"),
        "{error}"
    );
}
