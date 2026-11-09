//! Claude plan usage through the CLI's own `/usage` command.
//!
//! Gyro reads the plan from `/api/oauth/usage` with the token Claude Code
//! keeps in the keychain. That token lives about eight hours, and only the CLI
//! renews it — `claude auth status` does not, a model request does. A user who
//! had not sent a Claude turn from the default config dir in a while saw the
//! popover pinned on "Last known usage · retrying" with a days-old reading.
//!
//! `claude -p /usage` runs the local command: no model request, no cost, zero
//! turns. It renews the token on the way and prints the same levels the
//! account endpoint returns. Gyro runs it when the stored token has lapsed or
//! been refused, then asks the endpoint again; if that still fails, the levels
//! the command printed are the reading.

use crate::{
    providers::process::command_for_provider,
    stores::to_string,
    usage::{fetch::plan_window_status, types::ProviderRateLimitWindow},
};
use std::{io::Read, process::Stdio, time::Duration};
/// The CLI starts in a few seconds; a hung keychain prompt must not hold the
/// usage poll's mutex for long.
const CLAUDE_USAGE_CLI_TIMEOUT: Duration = Duration::from_secs(30);

/// Run `/usage` and return the plan windows it printed.
///
/// Errors only when the CLI could not run or printed nothing Gyro recognises.
/// The token refresh is a side effect of a successful run.
pub(crate) fn read_claude_usage_via_cli() -> Result<Vec<ProviderRateLimitWindow>, String> {
    let mut process = command_for_provider("claude", "anthropic").map_err(to_string)?;
    process
        .args([
            "-p",
            "/usage",
            "--output-format",
            "json",
            "--no-session-persistence",
            "--strict-mcp-config",
        ])
        // Outside any project, so the run neither reads a repo's settings nor
        // files a transcript under it.
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = gyro_core::process_guard::spawn_service(&mut process)
        .map_err(|error| format!("could not start Claude Code to read usage: {error}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Claude Code usage output is unavailable".to_string())?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = sender.send(text);
    });
    let text = match receiver.recv_timeout(CLAUDE_USAGE_CLI_TIMEOUT) {
        Ok(text) => text,
        Err(_) => {
            // Dropping the guard tears down the rest of the process group.
            let _ = child.kill();
            return Err("Claude Code took too long to report usage.".into());
        }
    };
    let _ = child.wait();
    let payload: serde_json::Value = serde_json::from_str(text.trim())
        .map_err(|_| "Claude Code usage output could not be read.".to_string())?;
    if payload.get("is_error").and_then(serde_json::Value::as_bool) == Some(true) {
        return Err("Claude Code could not read plan usage.".into());
    }
    let result = payload
        .get("result")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let windows = claude_usage_windows_from_text(result, chrono::Local::now());
    if windows.is_empty() {
        return Err("Claude Code reported no plan usage window.".into());
    }
    Ok(windows)
}

/// Read the level lines `/usage` prints:
///
/// ```text
/// Current session: 6% used · resets Nov 8 at 5:10pm (Europe/Amsterdam)
/// Current week (all models): 92% used · resets Nov 8 at 6pm (Europe/Amsterdam)
/// ```
///
/// The reset is printed in the machine's own zone, so it is read as local time.
pub(crate) fn claude_usage_windows_from_text(
    text: &str,
    now: chrono::DateTime<chrono::Local>,
) -> Vec<ProviderRateLimitWindow> {
    let mut windows: Vec<ProviderRateLimitWindow> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let (id, label) = if name == "current session" {
            ("five-hour", "5-hour limit")
        } else if name.starts_with("current week") {
            if name.contains("opus") {
                ("weekly-opus", "Weekly · Opus")
            } else if name.contains("sonnet") {
                ("weekly-sonnet", "Weekly · Sonnet")
            } else {
                ("weekly", "Weekly limit")
            }
        } else {
            continue;
        };
        if windows.iter().any(|window| window.id == id) {
            continue;
        }
        let Some(used_percent) = percent_used(rest) else {
            continue;
        };
        let resets_at = rest
            .split_once("resets")
            .and_then(|(_, reset)| local_reset(reset, now))
            .map(|at| at.with_timezone(&chrono::Utc).to_rfc3339());
        windows.push(ProviderRateLimitWindow {
            id: id.into(),
            label: label.into(),
            status: plan_window_status(used_percent).into(),
            used_percent: Some(used_percent),
            resets_at,
        });
    }
    windows
}

fn percent_used(text: &str) -> Option<i32> {
    let (number, _) = text.split_once('%')?;
    let digits: String = number
        .trim()
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let value: f64 = digits.parse().ok()?;
    Some(value.round().clamp(0.0, 100.0) as i32)
}

/// `Nov 8 at 5:10pm (Europe/Amsterdam)`, `Nov 8 at 6pm`, `5:10pm` or `Nov 15`.
fn local_reset(
    text: &str,
    now: chrono::DateTime<chrono::Local>,
) -> Option<chrono::DateTime<chrono::Local>> {
    use chrono::{Datelike, NaiveDate, NaiveTime, TimeZone};
    let text = text.split('(').next()?.trim();
    let (date_part, time_part) = match text.split_once(" at ") {
        Some((date, time)) => (Some(date.trim()), Some(time.trim())),
        None if text.chars().next()?.is_ascii_digit() => (None, Some(text)),
        None => (Some(text), None),
    };
    let time = match time_part {
        Some(time) => parse_clock(time)?,
        None => NaiveTime::from_hms_opt(0, 0, 0)?,
    };
    let date = match date_part {
        Some(date) => {
            let mut parts = date.split_whitespace();
            let month = month_number(parts.next()?)?;
            let day: u32 = parts.next()?.trim_end_matches(',').parse().ok()?;
            let this_year = NaiveDate::from_ymd_opt(now.year(), month, day)?;
            // A reset is never far in the past; one that reads that way is
            // next year's (a weekly reset printed on 30 December).
            if this_year < now.date_naive() - chrono::Duration::days(1) {
                NaiveDate::from_ymd_opt(now.year() + 1, month, day)?
            } else {
                this_year
            }
        }
        None => {
            let today = now.date_naive();
            if today.and_time(time) < now.naive_local() {
                today.succ_opt()?
            } else {
                today
            }
        }
    };
    chrono::Local
        .from_local_datetime(&date.and_time(time))
        .earliest()
}

fn parse_clock(text: &str) -> Option<chrono::NaiveTime> {
    let text = text.trim().to_ascii_lowercase();
    let (clock, pm) = if let Some(clock) = text.strip_suffix("pm") {
        (clock, Some(true))
    } else if let Some(clock) = text.strip_suffix("am") {
        (clock, Some(false))
    } else {
        (text.as_str(), None)
    };
    let (hour, minute) = match clock.trim().split_once(':') {
        Some((hour, minute)) => (hour.parse::<u32>().ok()?, minute.parse::<u32>().ok()?),
        None => (clock.trim().parse::<u32>().ok()?, 0),
    };
    let hour = match pm {
        Some(true) if hour < 12 => hour + 12,
        Some(false) if hour == 12 => 0,
        _ => hour,
    };
    chrono::NaiveTime::from_hms_opt(hour, minute, 0)
}

fn month_number(name: &str) -> Option<u32> {
    let prefix = name.get(..3)?.to_ascii_lowercase();
    [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ]
    .iter()
    .position(|month| *month == prefix)
    .map(|index| index as u32 + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> chrono::DateTime<chrono::Local> {
        chrono::Local
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .earliest()
            .unwrap()
    }

    #[test]
    fn reads_session_and_week_levels_with_local_resets() {
        let text = "You are currently using your subscription to power your Claude Code usage\n\n\
Current session: 6% used · resets Nov 8 at 5:10pm (Europe/Amsterdam)\n\
Current week (all models): 92% used · resets Nov 8 at 6pm (Europe/Amsterdam)\n\n\
What's contributing to your usage?\n  41%  Turn off MCP servers you don't use";
        let windows = claude_usage_windows_from_text(text, at(2026, 11, 8, 12, 0));
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].id, "five-hour");
        assert_eq!(windows[0].used_percent, Some(6));
        assert_eq!(
            windows[0].resets_at.as_deref(),
            Some(
                at(2026, 11, 8, 17, 10)
                    .with_timezone(&chrono::Utc)
                    .to_rfc3339()
                    .as_str()
            )
        );
        assert_eq!(windows[1].id, "weekly");
        assert_eq!(windows[1].used_percent, Some(92));
        assert_eq!(windows[1].status, "warning");
        assert_eq!(
            windows[1].resets_at.as_deref(),
            Some(
                at(2026, 11, 8, 18, 0)
                    .with_timezone(&chrono::Utc)
                    .to_rfc3339()
                    .as_str()
            )
        );
    }

    #[test]
    fn reads_model_scoped_weeks_and_rolls_a_january_reset_into_next_year() {
        let text = "Current week (Opus): 100% used · resets Jan 2 at 9am\n\
Current week (Sonnet only): 12.4% used · resets 11:30pm";
        let windows = claude_usage_windows_from_text(text, at(2026, 12, 30, 23, 45));
        assert_eq!(windows[0].id, "weekly-opus");
        assert_eq!(windows[0].status, "exhausted");
        assert!(windows[0]
            .resets_at
            .as_deref()
            .unwrap()
            .starts_with("2027-01-0"));
        assert_eq!(windows[1].id, "weekly-sonnet");
        assert_eq!(windows[1].used_percent, Some(12));
        // 11:30pm already passed at 23:45, so it is tomorrow's.
        assert_eq!(
            windows[1].resets_at.as_deref(),
            Some(
                at(2026, 12, 31, 23, 30)
                    .with_timezone(&chrono::Utc)
                    .to_rfc3339()
                    .as_str()
            )
        );
    }

    #[test]
    fn ignores_the_contribution_breakdown() {
        let text = "Last 24h · 614 requests\n  41%  Turn off MCP servers\n  17%  Give subagents a cheaper model";
        assert!(claude_usage_windows_from_text(text, at(2026, 11, 8, 12, 0)).is_empty());
    }
}
