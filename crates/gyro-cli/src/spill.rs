//! Explicit local-owner recovery of bounded spill windows.
use crate::{cli_failure, print_json, CliErrorCategory};
use anyhow::Result;
use clap::Args;
use gyro_core::{efficiency::spill, GyroPaths};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Args)]
pub(crate) struct SpillArgs {
    /// The `spill://` address a preview quoted.
    address: String,

    /// Recover a desktop session's copy. Omit to read the legacy local cache.
    #[arg(long)]
    session: Option<Uuid>,

    /// Emit versioned JSON instead of text.
    #[arg(long, global = true)]
    pub(crate) json: bool,

    /// Byte offset to start the window at.
    #[arg(long, global = true, default_value_t = 0)]
    offset: usize,

    /// Bytes to print. One window by default.
    #[arg(long, global = true)]
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpillReadOutput {
    address: String,
    offset: usize,
    total_bytes: usize,
    truncated: bool,
    next_offset: Option<usize>,
    text: String,
}

pub(crate) fn run(args: SpillArgs) -> Result<()> {
    const MAX_LIMIT: usize = 64 * 1024;
    let limit = args.limit.unwrap_or(spill::SPILL_READ_WINDOW);
    if limit == 0 || limit > MAX_LIMIT {
        return Err(cli_failure(
            CliErrorCategory::InvalidInput,
            format!("--limit must be between 1 and {MAX_LIMIT} bytes"),
        ));
    }
    // This is an explicit local user command, not a provider capability.
    // Selecting a session never falls back to any other session or cache.
    let window = if let Some(session) = args.session {
        let paths = GyroPaths::for_current_user()?;
        let _scope = spill::SessionScope::start(&paths, session);
        spill::read_scoped_window(&args.address, args.offset, limit)
    } else {
        spill::read_window(&args.address, args.offset, limit)
    }
    .map_err(|error| cli_failure(CliErrorCategory::InvalidInput, error.to_string()))?;
    let Some(window) = window else {
        return Err(cli_failure(
            CliErrorCategory::ExecutionFailed,
            format!(
                "no stored copy at {}; check --session for desktop output, or the copy may have been swept or never written",
                args.address
            ),
        ));
    };
    if args.json {
        return print_json(&SpillReadOutput {
            address: window.address.clone(),
            offset: window.offset,
            total_bytes: window.total_bytes,
            truncated: window.truncated(),
            next_offset: window.next_offset(),
            text: window.text.clone(),
        });
    }
    println!("{}", window.render());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn spill_session_is_an_explicit_validated_uuid() {
        let session = Uuid::new_v4();
        let cli = crate::Cli::try_parse_from([
            "gyro",
            "spill",
            "spill://cap/tool/copy",
            "--session",
            &session.to_string(),
            "--json",
        ])
        .unwrap();
        let Some(crate::Commands::Spill(args)) = cli.command else {
            panic!("spill command")
        };
        assert_eq!(args.session, Some(session));
        assert!(args.json);
        assert!(crate::Cli::try_parse_from([
            "gyro",
            "spill",
            "spill://cap/tool/copy",
            "--session",
            "../other"
        ])
        .is_err());
        let cli = crate::Cli::try_parse_from(["gyro", "spill", "spill://cap/tool/copy"]).unwrap();
        let Some(crate::Commands::Spill(args)) = cli.command else {
            panic!("spill command")
        };
        assert!(args.session.is_none());
    }
}
