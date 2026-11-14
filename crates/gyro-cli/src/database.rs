use anyhow::Result;
use clap::{Args, Subcommand};
use gyro_core::{sqlite::recovery, GyroPaths};
use std::path::PathBuf;

#[derive(Debug, Args)]
pub(crate) struct DatabaseArgs {
    /// Emit versioned JSON instead of text.
    #[arg(long, global = true)]
    pub json: bool,
    /// Gyro data directory. Defaults to this user's Gyro data directory.
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: DatabaseCommand,
}

#[derive(Debug, Subcommand)]
enum DatabaseCommand {
    /// List retained pre-migration snapshots, newest first.
    Backups,
    /// Verify and restore a snapshot into a NEW file, preserving the original.
    Restore {
        backup: PathBuf,
        /// New SQLite file to create. Existing files are never overwritten.
        #[arg(long)]
        output: PathBuf,
    },
}

pub(crate) fn run(args: DatabaseArgs) -> Result<()> {
    match args.command {
        DatabaseCommand::Backups => {
            let paths = match args.data_dir {
                Some(path) => GyroPaths::from_base_dir(path),
                None => GyroPaths::for_current_user()?,
            };
            let backups = recovery::list_backups(&paths)?;
            if args.json {
                println!(
                    "{}",
                    serde_json::json!({"schema":super::CLI_JSON_SCHEMA_V1,"backups":backups})
                );
            } else if backups.is_empty() {
                println!("No migration backups in {}", paths.base_dir.display());
            } else {
                for backup in backups {
                    println!("{} ({} bytes)", backup.path.display(), backup.bytes);
                }
            }
        }
        DatabaseCommand::Restore { backup, output } => {
            recovery::restore_backup(&backup, &output)?;
            if args.json {
                println!(
                    "{}",
                    serde_json::json!({"schema":super::CLI_JSON_SCHEMA_V1,"restoredDatabase":output,"activated":false})
                );
            } else {
                println!("Verified database restored to {}. The active database is unchanged. Keep the matching sessions directory when recovering Gyro data.",output.display());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use clap::Parser;
    #[test]
    fn recovery_commands_parse_without_opening_the_live_store() {
        let cli = crate::Cli::try_parse_from([
            "gyro",
            "database",
            "--json",
            "--data-dir",
            "/tmp/isolated",
            "backups",
        ])
        .unwrap();
        assert!(cli.wants_json());
        assert!(matches!(cli.command, Some(crate::Commands::Database(_))));
        let cli = crate::Cli::try_parse_from([
            "gyro",
            "database",
            "restore",
            "/tmp/source.sqlite3",
            "--output",
            "/tmp/new.sqlite3",
            "--json",
        ])
        .unwrap();
        assert!(cli.wants_json());
        assert!(
            crate::Cli::try_parse_from(["gyro", "database", "restore", "/tmp/source.sqlite3"])
                .is_err()
        );
    }
}
