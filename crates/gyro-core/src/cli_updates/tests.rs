use super::*;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};

fn executable(path: &Path, script: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn npm_cli(prefix: &Path, program: &str, package: &str, script: &str) -> PathBuf {
    let package_dir = prefix.join("lib/node_modules").join(package);
    let launcher = package_dir.join("bin").join(program);
    executable(&launcher, script);
    fs::write(package_dir.join("package.json"), "{}").unwrap();
    fs::create_dir_all(prefix.join("bin")).unwrap();
    symlink(&launcher, prefix.join("bin").join(program)).unwrap();
    launcher
}

fn test_path(dirs: &[&Path]) -> String {
    std::env::join_paths(dirs).unwrap().into_string().unwrap()
}

#[test]
fn uses_the_installed_npm_prefix_even_when_other_copies_exist() {
    let fixture = tempfile::tempdir().unwrap();
    let home = fixture.path();
    let shadowed = home.join("system");
    let selected = home.join(".npm-global");
    let alias_bin = home.join("bin");
    let package = "@google/gemini-cli";
    let shadowed_launcher = npm_cli(&shadowed, "gemini", package, "printf '0.9.0\\n'");
    let selected_launcher = npm_cli(&selected, "gemini", package, "printf '1.0.0\\n'");
    fs::create_dir_all(&alias_bin).unwrap();
    symlink(selected.join("bin/gemini"), alias_bin.join("gemini")).unwrap();
    // The user prefix has no npm. The system npm must read and write the
    // explicitly selected prefix and leave its own installed copy alone.
    executable(
        &shadowed.join("bin/npm"),
        r#"
case "$1" in
  view)
    [ "$2" = "@google/gemini-cli@latest" ] || exit 11
    [ "$9" = "--prefix" ] || exit 12
    [ "$#" = 10 ] && [ "$(basename "${10}")" = ".npm-global" ] || exit 13
    printf '["1.1.0"]\n'
    printf 'npm warn fixture\n' >&2
    ;;
  install)
    [ "$2" = "--global" ] && [ "$3" = "--prefix" ] || exit 14
    [ "$5" = "@google/gemini-cli@1.1.0" ] || exit 15
    printf '#!/bin/sh\nprintf "1.1.0\\n"\n' > "$4/lib/node_modules/@google/gemini-cli/bin/gemini"
    printf 'updated selected prefix\n'
    ;;
  *) exit 16 ;;
esac
"#,
    );
    let path = test_path(&[&alias_bin, &shadowed.join("bin"), Path::new("/usr/bin")]);

    let report = check_cli_updates_on_path(&path).unwrap();
    assert_eq!(report.offers.len(), 1);
    let offer = &report.offers[0];
    assert_eq!(offer.current_version.as_deref(), Some("1.0.0"));
    assert_eq!(offer.latest_version.as_deref(), Some("1.1.0"));
    assert_eq!(
        Path::new(&offer.update_command[4]),
        selected.canonicalize().unwrap()
    );
    assert!(fs::read_to_string(&selected_launcher)
        .unwrap()
        .contains("1.0.0"));

    let results = apply_cli_updates_on_path(&["gemini".into(), "gemini".into()], &path);
    assert_eq!(results.len(), 1);
    assert!(results[0].ok, "{results:?}");
    assert!(fs::read_to_string(&selected_launcher)
        .unwrap()
        .contains("1.1.0"));
    assert!(fs::read_to_string(&shadowed_launcher)
        .unwrap()
        .contains("0.9.0"));
    assert!(check_cli_updates_on_path(&path).unwrap().offers.is_empty());
    let current = apply_cli_updates_on_path(&["gemini".into()], &path);
    assert!(current[0].ok && current[0].message.contains("already up to date"));
}

#[test]
fn standalone_gemini_cannot_update_a_shadowed_npm_installation() {
    let fixture = tempfile::tempdir().unwrap();
    let active_bin = fixture.path().join("active");
    let npm_prefix = fixture.path().join("other");
    let npm_bin = npm_prefix.join("bin");
    executable(&active_bin.join("gemini"), "printf '1.0.0\\n'");
    npm_cli(&npm_prefix, "gemini", "@google/gemini-cli", "exit 42");
    executable(&npm_bin.join("npm"), "exit 99");
    let path = test_path(&[&active_bin, &npm_bin]);

    assert!(check_cli_updates_on_path(&path).unwrap().offers.is_empty());
    let results = apply_cli_updates_on_path(&["gemini".into()], &path);
    assert!(!results[0].ok);
    assert!(results[0].message.contains("supported update route"));
}

#[test]
fn homebrew_private_package_tree_is_not_an_npm_install_target() {
    let fixture = tempfile::tempdir().unwrap();
    let keg = fixture.path().join("Cellar/gemini-cli/1.0.0");
    let resolved = npm_cli(
        &keg.join("libexec"),
        "gemini",
        "@google/gemini-cli",
        "printf '1.0.0\\n'",
    )
    .canonicalize()
    .unwrap();
    fs::write(keg.join("INSTALL_RECEIPT.json"), "{}").unwrap();
    assert!(npm_prefix_for(&resolved, "gemini", "@google/gemini-cli").is_none());
}

#[test]
fn targeted_updates_distinguish_probe_failure_and_missing_clis_from_current() {
    let fixture = tempfile::tempdir().unwrap();
    let bin = fixture.path();
    executable(&bin.join("claude"), "printf '1.0.0 (Claude Code)\\n'");
    executable(
        &bin.join("npm"),
        "printf 'registry unavailable\\n' >&2; exit 12",
    );
    executable(
        &bin.join("codex"),
        "printf 'unrelated provider was checked\\n' >&2; exit 19",
    );
    let path = test_path(&[bin]);

    let failed_check = check_cli_updates_on_path(&path).unwrap_err();
    assert!(failed_check.to_string().contains("registry unavailable"));
    let results =
        apply_cli_updates_on_path(&["anthropic".into(), "xai".into(), "unknown".into()], &path);
    assert_eq!(results.len(), 3);
    assert!(results.iter().all(|result| !result.ok));
    assert!(results[0].message.contains("registry unavailable"));
    assert!(!results[0].message.contains("unrelated provider"));
    assert!(results[1].message.contains("cannot find grok"));
    assert!(results[2].message.contains("no update route"));
}

#[test]
fn native_json_ignores_stderr_and_success_requires_a_new_active_version() {
    let fixture = tempfile::tempdir().unwrap();
    let bin = fixture.path();
    executable(
        &bin.join("grok"),
        r#"
case "$*" in
  --version) printf 'grok 1.0.0\n' >&2 ;;
  'update --check --json')
    printf '{"updateAvailable":true,"latestVersion":"1.1.0"}\n'
    printf 'registry warning\n' >&2
    ;;
  update) printf 'updated successfully\n' ;;
  *) exit 51 ;;
esac
"#,
    );
    let path = test_path(&[bin]);
    let report = check_cli_updates_on_path(&path).unwrap();
    assert_eq!(report.offers[0].check_source, "native");
    let results = apply_cli_updates_on_path(&["xai".into()], &path);
    assert!(!results[0].ok);
    assert!(results[0]
        .message
        .contains("still uses 1.0.0 (expected 1.1.0)"));
}

#[test]
fn an_external_upgrade_during_registry_lookup_does_not_get_downgraded() {
    let fixture = tempfile::tempdir().unwrap();
    let prefix = fixture.path();
    npm_cli(
        prefix,
        "codex",
        "@openai/codex",
        r#"IFS= read -r version < "$(dirname "$0")/../lib/node_modules/@openai/codex/version"
printf 'codex-cli %s\n' "$version""#,
    );
    let version = prefix.join("lib/node_modules/@openai/codex/version");
    fs::write(&version, "1.0.0\n").unwrap();
    executable(
        &prefix.join("bin/npm"),
        r#"
[ "$1" = "view" ] || exit 91
printf '3.0.0\n' > "$(dirname "$0")/../lib/node_modules/@openai/codex/version"
printf '"2.0.0"\n'
"#,
    );
    let path = test_path(&[&prefix.join("bin"), Path::new("/usr/bin")]);
    let results = apply_cli_updates_on_path(&["openai".into()], &path);
    assert!(results[0].ok, "{results:?}");
    assert!(results[0].message.contains("already up to date (3.0.0)"));
    assert_eq!(fs::read_to_string(version).unwrap(), "3.0.0\n");
}

#[test]
fn version_checks_reject_non_version_output_and_compare_semver_precedence() {
    let codex = &CLI_UPDATE_SPECS[1];
    assert_eq!(
        parse_version_output(
            codex,
            "warning: requires Node.js 20.0.0\ncodex-cli v0.144.4\n"
        ),
        parse_version("0.144.4"),
    );
    assert!(parse_version_output(codex, "Unknown command --version\n").is_none());
    assert!(parse_npm_version(r#"{"error": {"code":"E404"}}"#).is_err());
    assert!(parse_npm_version(r#"["1.1.0","2.0.0"]"#).is_err());
    assert!(at_least(
        &parse_version("1.2.0-beta.10+local").unwrap(),
        &parse_version("1.2.0-beta.2").unwrap(),
    ));
    assert!(at_least(
        &parse_version("2.0.0+local").unwrap(),
        &parse_version("2.0.0").unwrap(),
    ));
    assert!(!at_least(
        &parse_version("1.2.0-beta.10").unwrap(),
        &parse_version("1.2.0").unwrap(),
    ));
}

#[test]
fn a_background_check_skips_while_an_update_holds_the_lock() {
    let _guard = CLI_UPDATES.write().unwrap();
    let result = check_cli_updates().unwrap_err();
    assert!(result.to_string().contains("already running"));
}

#[test]
fn summarize_failure_keeps_the_reason_and_drops_npm_noise() {
    let summary = summarize_failure(
        "npm exited with Some(1):\nnpm warn config x\nnpm error code EEXIST\nnpm error A complete log of this run can be found in: /tmp/x.log\n",
    );
    assert!(summary.contains("EEXIST"));
    assert!(!summary.contains("complete log"));
    assert!(!summary.contains("npm warn"));
}
