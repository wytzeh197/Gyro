//! Argument contracts for the provider CLIs Gyro shells out to.
//!
//! Gyro drives third-party CLIs (`claude`, `codex`, and the ACP agents) whose
//! releases it does not control. When one of those CLIs changes how it parses
//! arguments, the mismatch used to surface only at send time, as an opaque
//! provider failure that the recovery hint told the user to retry — advice that
//! can never succeed for an argument error.
//!
//! This module makes that dependency explicit in three layers:
//!
//! 1. [`audit_provider_args`] enforces the invariants Gyro controls, before it
//!    spawns anything. It is pure, so it runs on every send at no cost.
//! 2. [`probe_provider_args`] launches a CLI with a real argument vector and
//!    reports whether the CLI accepted it, catching drift that only the CLI can
//!    detect (undocumented flags, flag combinations).
//! 3. [`is_cli_argument_error`] recognises argument failures in provider output
//!    so a run that fails this way is reported as a version mismatch instead of
//!    a transient error.
//!
//! Help text is deliberately *not* used to verify flags. Some flags Gyro
//! depends on are accepted but undocumented (`claude --permission-prompt-tool`
//! is one), so grepping `--help` reports failures for flags that work fine.

use crate::provider_registry::{provider_descriptor, ProviderExecutionKind};
use anyhow::{Context, Result};
use std::ffi::OsStr;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Argument-vector probes launch a real provider CLI, so they are only used by
/// explicitly invoked diagnostics — never on the send path.
pub const PROVIDER_ARG_PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// The option terminator that separates flags from the trailing prompt.
pub const ARG_TERMINATOR: &str = "--";

/// How Gyro hands the user's prompt to a provider process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PromptDelivery {
    /// The prompt is the final positional argument on the command line.
    ///
    /// Both CLIs that use this form expose variadic options (`claude
    /// --allowedTools <tools...>`, `codex --image <FILE>...`) which will
    /// consume the prompt as one more value unless it sits behind
    /// [`ARG_TERMINATOR`].
    TrailingPositional,
    /// The prompt is sent over a stdio protocol after the process starts, so it
    /// never passes through argument parsing.
    Protocol,
}

/// What Gyro relies on when it launches a provider CLI.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProviderCliContract {
    pub provider_id: &'static str,
    /// Executable Gyro launches, resolved through the GUI PATH at spawn time.
    pub program: &'static str,
    pub prompt_delivery: PromptDelivery,
}

const CONTRACTS: &[ProviderCliContract] = &[
    ProviderCliContract {
        provider_id: "anthropic",
        program: "claude",
        prompt_delivery: PromptDelivery::TrailingPositional,
    },
    ProviderCliContract {
        provider_id: "openai",
        program: "codex",
        prompt_delivery: PromptDelivery::TrailingPositional,
    },
    ProviderCliContract {
        provider_id: "kimi",
        program: "kimi",
        prompt_delivery: PromptDelivery::Protocol,
    },
    ProviderCliContract {
        provider_id: "xai",
        program: "grok",
        prompt_delivery: PromptDelivery::Protocol,
    },
    ProviderCliContract {
        provider_id: "gemini",
        program: "gemini",
        prompt_delivery: PromptDelivery::Protocol,
    },
];

pub fn provider_cli_contracts() -> &'static [ProviderCliContract] {
    CONTRACTS
}

pub fn provider_cli_contract(provider_id: &str) -> Option<&'static ProviderCliContract> {
    CONTRACTS
        .iter()
        .find(|contract| contract.provider_id == provider_id)
}

/// An argument vector that the provider CLI would misread.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArgContractViolation {
    /// The prompt is not guarded by an option terminator, so a variadic option
    /// earlier in the vector can absorb it. This is the failure that made
    /// `claude` report a missing prompt while Gyro believed it had sent one.
    UnterminatedPrompt,
    /// The vector carries no prompt at all.
    MissingPrompt,
}

/// Marker shared by every contract-violation message.
///
/// [`is_cli_argument_error`] matches on it so a vector Gyro rejects before
/// spawning is reported exactly like one the CLI itself rejects — both are
/// argument failures, and neither is fixed by retrying.
pub const ARG_CONTRACT_MARKER: &str = "Gyro's argument contract";

impl ArgContractViolation {
    pub fn message(&self, provider_id: &str) -> String {
        match self {
            Self::UnterminatedPrompt => format!(
                "{ARG_CONTRACT_MARKER} for `{provider_id}` was violated: the prompt is not separated by \
                 `{ARG_TERMINATOR}`, so a variadic option would absorb it and the CLI would report that \
                 no prompt was given."
            ),
            Self::MissingPrompt => format!(
                "{ARG_CONTRACT_MARKER} for `{provider_id}` was violated: the command carries no prompt argument."
            ),
        }
    }
}

/// Check an argument vector against the invariants Gyro is responsible for.
///
/// This runs before every spawn. It cannot detect drift inside the CLI, but it
/// does guarantee Gyro never ships the shape of bug that motivated this module.
pub fn audit_provider_args<S: AsRef<str>>(
    contract: &ProviderCliContract,
    args: &[S],
) -> Result<(), ArgContractViolation> {
    if contract.prompt_delivery == PromptDelivery::Protocol {
        return Ok(());
    }
    let prompt = args.last().map(AsRef::as_ref);
    match prompt {
        None => return Err(ArgContractViolation::MissingPrompt),
        // A prompt that is itself the terminator means nothing was appended.
        Some(prompt) if prompt.trim().is_empty() || prompt == ARG_TERMINATOR => {
            return Err(ArgContractViolation::MissingPrompt)
        }
        Some(_) => {}
    }
    let terminator = args
        .len()
        .checked_sub(2)
        .map(|index| args[index].as_ref())
        .filter(|value| *value == ARG_TERMINATOR);
    if terminator.is_none() {
        return Err(ArgContractViolation::UnterminatedPrompt);
    }
    Ok(())
}

/// Marker shared by failures where a CLI's output stopped matching what Gyro
/// knows how to read.
///
/// The arguments are only half of what Gyro depends on; the other half is the
/// shape of the stream it parses back. When Claude Code moved its partial
/// messages inside a `stream_event` envelope, no text matched any known shape
/// and the chat answered with the raw transcript. A run that reaches the end
/// with nothing readable is version drift, exactly like a rejected flag, and
/// [`is_cli_argument_error`] recognises it so both are reported that way.
pub const STREAM_CONTRACT_MARKER: &str = "Gyro could not read this provider's output";

/// Report a provider run whose output Gyro could not parse.
pub fn stream_contract_failure(provider_label: &str, cli_label: &str) -> String {
    format!(
        "{STREAM_CONTRACT_MARKER}: {provider_label} finished, but nothing in the stream matched a \
         reply Gyro knows how to read, which usually means {cli_label} changed its output format. \
         Update Gyro and {cli_label}; retrying will not help."
    )
}

/// Whether provider output describes an argument-parsing failure.
///
/// Both CLI families are covered: `claude` uses Commander (Node) and `codex`
/// uses clap (Rust). Patterns stay specific so a model that merely *discusses*
/// command-line flags is not misreported as a version mismatch.
pub fn is_cli_argument_error(output: &str) -> bool {
    let normalized = output.to_ascii_lowercase();
    const PATTERNS: &[&str] = &[
        // Gyro's own pre-spawn audit.
        "gyro's argument contract",
        // Gyro's own read of a stream it no longer recognises.
        "gyro could not read this provider's output",
        // Observed verbatim from `claude` when a variadic option absorbed the
        // prompt, and when a flag combination was incomplete.
        "input must be provided either through stdin or as a prompt argument",
        "requires --verbose",
        // Commander.
        "error: unknown option",
        "error: unknown command",
        "error: missing required argument",
        "error: option requires argument",
        "too many arguments",
        // clap.
        "error: unexpected argument",
        "error: unrecognized subcommand",
        "error: invalid value for",
        "the following required arguments were not provided",
    ];
    PATTERNS.iter().any(|pattern| normalized.contains(pattern))
}

/// The result of launching a provider CLI with a candidate argument vector.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArgAcceptance {
    /// The CLI parsed the arguments and began work.
    Accepted,
    /// The CLI rejected the arguments before doing any work.
    Rejected { message: String },
    /// The CLI could not be launched at all.
    Unavailable { message: String },
}

/// Launch `program` with `args` and report whether the arguments were accepted.
///
/// Argument validation happens before a provider does any real work, so a CLI
/// that rejects a vector exits almost immediately. This waits for that early
/// exit and terminates the process as soon as it is clear the arguments parsed,
/// so an accepted vector does no meaningful work.
///
/// This spawns a real provider process. Callers must keep it on explicitly
/// invoked paths (diagnostics, tests) rather than the send path.
///
/// The probe runs in an empty temporary directory. Gyro's argument vectors can
/// include `--dangerously-skip-permissions`, and a probe must never hand an
/// agent write access to the user's workspace just to find out whether a flag
/// still parses.
pub fn probe_provider_args<S: AsRef<OsStr>>(
    program: &str,
    args: &[S],
    timeout: Duration,
) -> Result<ArgAcceptance> {
    let sandbox = std::env::temp_dir().join(format!(
        "gyro-arg-probe-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    std::fs::create_dir_all(&sandbox).context("create provider probe directory")?;
    let acceptance = probe_in_directory(program, args, timeout, &sandbox);
    let _ = std::fs::remove_dir_all(&sandbox);
    acceptance
}

fn probe_in_directory<S: AsRef<OsStr>>(
    program: &str,
    args: &[S],
    timeout: Duration,
    sandbox: &std::path::Path,
) -> Result<ArgAcceptance> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(sandbox)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Ok(ArgAcceptance::Unavailable {
                message: format!("could not launch `{program}`: {error}"),
            })
        }
    };

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait().context("await provider CLI probe")? {
            Some(status) => break Some(status),
            None if Instant::now() >= deadline => break None,
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };

    // Still running past the deadline means argument parsing succeeded and the
    // provider moved on to real work; stop it before it gets far.
    let Some(status) = status else {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(ArgAcceptance::Accepted);
    };

    let output = child
        .wait_with_output()
        .context("collect provider CLI probe output")?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if status.success() && !is_cli_argument_error(&combined) {
        return Ok(ArgAcceptance::Accepted);
    }
    if is_cli_argument_error(&combined) {
        return Ok(ArgAcceptance::Rejected {
            message: first_meaningful_line(&combined)
                .unwrap_or("the provider CLI rejected Gyro's arguments")
                .to_string(),
        });
    }
    // A non-zero exit that is not an argument error is some other problem
    // (auth, network); the argument vector itself parsed.
    Ok(ArgAcceptance::Accepted)
}

fn first_meaningful_line(output: &str) -> Option<&str> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('{'))
}

/// Providers Gyro launches as a subprocess, and therefore has a contract with.
pub fn executable_provider_contracts() -> impl Iterator<Item = &'static ProviderCliContract> {
    CONTRACTS.iter().filter(|contract| {
        provider_descriptor(contract.provider_id).is_some_and(|descriptor| {
            descriptor.execution_kind != ProviderExecutionKind::ReadinessOnly
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude_contract() -> &'static ProviderCliContract {
        provider_cli_contract("anthropic").expect("anthropic contract")
    }

    #[test]
    fn every_executable_provider_declares_a_contract() {
        for descriptor in crate::provider_registry::provider_registry() {
            if descriptor.execution_kind == ProviderExecutionKind::ReadinessOnly {
                continue;
            }
            assert!(
                provider_cli_contract(descriptor.id).is_some(),
                "provider `{}` is launched as a subprocess but declares no CLI contract",
                descriptor.id
            );
        }
        assert_eq!(executable_provider_contracts().count(), CONTRACTS.len());
    }

    #[test]
    fn readiness_only_providers_declare_no_contract() {
        assert!(provider_cli_contract("cursor").is_none());
        assert!(provider_cli_contract("opencode").is_none());
    }

    #[test]
    fn rejects_the_argument_shape_that_lost_the_prompt() {
        // The exact vector that made `claude` report a missing prompt: a
        // variadic option immediately followed by the prompt.
        let args = vec![
            "--print",
            "--allowedTools",
            "mcp__gyro_capabilities__read_file",
            "explain this repository",
        ];

        assert_eq!(
            audit_provider_args(claude_contract(), &args),
            Err(ArgContractViolation::UnterminatedPrompt)
        );
    }

    #[test]
    fn accepts_a_terminated_prompt() {
        let args = vec![
            "--print",
            "--allowedTools",
            "mcp__gyro_capabilities__read_file",
            "--",
            "explain this repository",
        ];

        assert_eq!(audit_provider_args(claude_contract(), &args), Ok(()));
    }

    #[test]
    fn rejects_a_vector_with_no_prompt() {
        assert_eq!(
            audit_provider_args(claude_contract(), &["--print", "--"]),
            Err(ArgContractViolation::MissingPrompt)
        );
        assert_eq!(
            audit_provider_args(claude_contract(), &["--print", "--", "   "]),
            Err(ArgContractViolation::MissingPrompt)
        );
        assert_eq!(
            audit_provider_args::<&str>(claude_contract(), &[]),
            Err(ArgContractViolation::MissingPrompt)
        );
    }

    #[test]
    fn protocol_providers_skip_the_prompt_invariant() {
        let kimi = provider_cli_contract("kimi").expect("kimi contract");
        // ACP agents receive the prompt over stdio, so a bare launch vector is
        // correct and must not be reported as a violation.
        assert_eq!(audit_provider_args(kimi, &["acp"]), Ok(()));
    }

    #[test]
    fn violation_messages_name_the_provider_and_the_fix() {
        let message = ArgContractViolation::UnterminatedPrompt.message("anthropic");
        assert!(message.contains("anthropic"));
        assert!(message.contains(ARG_TERMINATOR));
    }

    #[test]
    fn audit_violations_classify_as_argument_errors() {
        // A vector rejected before spawning and one rejected by the CLI must
        // reach the same conclusion, or the pre-spawn audit would be reported
        // as a transient failure worth retrying.
        for violation in [
            ArgContractViolation::UnterminatedPrompt,
            ArgContractViolation::MissingPrompt,
        ] {
            assert!(
                is_cli_argument_error(&violation.message("anthropic")),
                "unclassified violation: {violation:?}"
            );
        }
    }

    #[test]
    fn recognises_the_observed_provider_argument_errors() {
        // Both strings were produced by `claude` 2.1.218 against the argument
        // vectors Gyro was building.
        assert!(is_cli_argument_error(
            "Error: Input must be provided either through stdin or as a prompt argument when using --print"
        ));
        assert!(is_cli_argument_error(
            "Error: When using --print, --output-format=stream-json requires --verbose"
        ));
        assert!(is_cli_argument_error("error: unexpected argument '--nope'"));
        assert!(is_cli_argument_error("error: unknown option '--nope'"));
    }

    #[test]
    fn an_unreadable_stream_is_reported_as_version_drift() {
        // A run that succeeds and streams nothing Gyro can read is the same
        // class of problem as a rejected flag: the CLI moved, and retrying
        // repeats it. Classifying it that way is what keeps the raw transcript
        // out of the chat, which is how this surfaced in the first place.
        let failure = stream_contract_failure("Anthropic", "Claude Code");
        assert!(is_cli_argument_error(&failure), "unclassified: {failure}");
        assert!(failure.contains("Claude Code"));
        assert!(failure.contains("retrying will not help"));
    }

    #[test]
    fn ordinary_provider_failures_are_not_argument_errors() {
        assert!(!is_cli_argument_error(
            "Failed to authenticate. API Error: 401 OAuth access token has expired."
        ));
        assert!(!is_cli_argument_error(
            "rate limit exceeded, try again later"
        ));
        assert!(!is_cli_argument_error(
            "network is unreachable while contacting the provider"
        ));
        // A model explaining flags in prose must not be mistaken for drift.
        assert!(!is_cli_argument_error(
            "You can pass --verbose to see more output from the command."
        ));
    }

    #[test]
    fn probe_reports_rejection_for_a_bad_argument_vector() {
        // `false`/`true` are not provider CLIs, so drive the classifier through
        // a shell that emits a real Commander-style argument error.
        let probe = probe_provider_args(
            "/bin/sh",
            &["-c", "echo \"error: unknown option '--nope'\" >&2; exit 1"],
            Duration::from_secs(5),
        )
        .expect("probe runs");

        match probe {
            ArgAcceptance::Rejected { message } => {
                assert!(message.contains("unknown option"), "unexpected: {message}");
            }
            other => panic!("expected rejection, got {other:?}"),
        }
    }

    #[test]
    fn probe_treats_a_clean_exit_as_acceptance() {
        let probe = probe_provider_args("/bin/sh", &["-c", "exit 0"], Duration::from_secs(5))
            .expect("probe runs");

        assert_eq!(probe, ArgAcceptance::Accepted);
    }

    #[test]
    fn probe_treats_non_argument_failures_as_acceptance() {
        // Auth failures mean the arguments parsed fine; only the run failed.
        let probe = probe_provider_args(
            "/bin/sh",
            &["-c", "echo 'API Error: 401 unauthorized' >&2; exit 1"],
            Duration::from_secs(5),
        )
        .expect("probe runs");

        assert_eq!(probe, ArgAcceptance::Accepted);
    }

    #[test]
    fn probe_stops_a_process_that_keeps_running() {
        let started = Instant::now();
        let probe = probe_provider_args("/bin/sh", &["-c", "sleep 30"], Duration::from_millis(200))
            .expect("probe runs");

        assert_eq!(probe, ArgAcceptance::Accepted);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "probe should terminate a long-running process promptly"
        );
    }

    #[test]
    fn probe_reports_a_missing_executable() {
        let probe = probe_provider_args(
            "gyro-provider-that-does-not-exist",
            &["--help"],
            Duration::from_secs(5),
        )
        .expect("probe runs");

        assert!(matches!(probe, ArgAcceptance::Unavailable { .. }));
    }
}
