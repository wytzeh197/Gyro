//! Retry one HTTP exchange, never an agent's already-executed tool loop.
use crate::CancellationToken;
use std::io::{BufRead, Read};
use std::time::{Duration, Instant};

// Bound bytes before parsing: providers can send a huge unterminated line or
// an endless sequence of small frames, including keep-alive comments.
pub(crate) const MAX_CHAT_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CHAT_LINE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_CHAT_TOOL_CALLS: usize = 128;

pub(crate) fn read_chat_line(
    reader: &mut impl BufRead,
    line: &mut String,
    remaining: &mut usize,
) -> anyhow::Result<usize> {
    let allowance = (*remaining).min(MAX_CHAT_LINE_BYTES);
    line.clear();
    let read = reader.take((allowance + 1) as u64).read_line(line)?;
    anyhow::ensure!(
        read <= allowance,
        "provider chat response exceeded its size limit; partial tool calls were not executed"
    );
    *remaining -= read;
    Ok(read)
}

const DELAYS: [Duration; 3] = [
    Duration::from_millis(400),
    Duration::from_millis(1200),
    Duration::from_secs(3),
];

/// The retry ladder every provider connection shares — CLI launches and HTTPS
/// exchanges alike — so one provider's budget is not a different product
/// behaviour from another's.
pub fn transient_retry_delays() -> &'static [Duration] {
    &DELAYS
}

/// The delay before retry `index`, jittered so parallel sessions that failed at
/// the same instant do not respawn in lockstep against one shared quota.
pub fn transient_retry_delay(index: usize) -> Option<Duration> {
    DELAYS.get(index).copied().map(jitter)
}

/// A cooldown the provider stated in its own words.
///
/// The HTTPS runner reads a `Retry-After` header; a provider CLI reports the
/// same instruction as error text ("rate limit reached … retry after 12
/// seconds"). Only a bounded wait is honored — a longer one stays an actionable
/// rate-limit error rather than a hidden hang, exactly as [`retry_delay`]
/// treats a long header.
pub fn retry_after_hint(error: &str) -> Option<Duration> {
    const MAX_HINT: Duration = Duration::from_secs(30);
    let normalized = error.to_ascii_lowercase();
    for marker in ["retry-after:", "retry after ", "retry in ", "try again in "] {
        let Some((_, rest)) = normalized.split_once(marker) else {
            continue;
        };
        let rest = rest.trim_start();
        let digits: String = rest
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect();
        let Ok(whole) = digits.parse::<u64>() else {
            continue;
        };
        // A stated fraction rounds up: waiting slightly long is always safe.
        let after = &rest[digits.len()..];
        let fraction = after
            .strip_prefix('.')
            .map(|rest| {
                rest.chars()
                    .take_while(|character| character.is_ascii_digit())
                    .count()
            })
            .unwrap_or(0);
        let seconds = whole + u64::from(fraction > 0);
        let unit = after
            .trim_start_matches(|character: char| character == '.' || character.is_ascii_digit())
            .trim_start();
        // "retry after 3 attempts" counts attempts, not seconds.
        if unit.starts_with("attempt") || unit.starts_with("try") || unit.starts_with("time") {
            continue;
        }
        let delay = Duration::from_secs(if unit.starts_with("min") {
            seconds * 60
        } else {
            seconds
        });
        return (delay <= MAX_HINT).then_some(delay);
    }
    None
}

// The transport and stream layers share three retries. Nested retry loops
// previously allowed up to twelve HTTP sends for one generation.
thread_local! { static REMAINING: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) }; }
struct RetryScope(Option<usize>);
impl RetryScope {
    fn start() -> Self {
        Self(REMAINING.with(|slot| slot.replace(Some(3))))
    }
}
impl Drop for RetryScope {
    fn drop(&mut self) {
        REMAINING.with(|slot| slot.set(self.0));
    }
}
fn take_retry() -> bool {
    REMAINING.with(|slot| match slot.get() {
        None => true,
        Some(0) => false,
        Some(left) => {
            slot.set(Some(left - 1));
            true
        }
    })
}
pub(crate) fn compatibility_retry() -> bool {
    if !take_retry() {
        return false;
    }
    crate::provider_observation::retry();
    true
}
fn jitter(delay: Duration) -> Duration {
    let spread = delay.as_millis() / 4;
    if spread == 0 {
        return delay;
    }
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u128;
    delay + Duration::from_millis((seed % (spread + 1)) as u64)
}

pub(crate) fn http_response<T>(
    cancellation: &CancellationToken,
    mut send: impl FnMut() -> Result<T, ureq::Error>,
) -> Result<T, ureq::Error> {
    for attempt in 0..=DELAYS.len() {
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        match send() {
            Ok(response) => return Ok(response),
            Err(error) => {
                let Some(delay) = DELAYS
                    .get(attempt)
                    .and_then(|delay| retry_delay(&error, jitter(*delay)))
                    .filter(|_| take_retry())
                else {
                    return Err(error);
                };
                let until = Instant::now() + delay;
                while Instant::now() < until {
                    if cancellation.is_cancelled() {
                        return Err(cancelled());
                    }
                    std::thread::sleep(
                        until
                            .saturating_duration_since(Instant::now())
                            .min(Duration::from_millis(50)),
                    );
                }
                crate::provider_observation::retry();
            }
        }
    }
    unreachable!()
}

fn cancelled() -> ureq::Error {
    std::io::Error::new(std::io::ErrorKind::Interrupted, "Provider chat cancelled").into()
}

fn retry_delay(error: &ureq::Error, fallback: Duration) -> Option<Duration> {
    match error {
        ureq::Error::Status(408 | 429 | 500 | 502 | 503 | 504 | 529, response) => {
            let delay = response
                .header("Retry-After")
                .and_then(|value| {
                    value
                        .parse::<u64>()
                        .ok()
                        .map(Duration::from_secs)
                        .or_else(|| {
                            chrono::DateTime::parse_from_rfc2822(value).ok().map(|at| {
                                (at.with_timezone(&chrono::Utc) - chrono::Utc::now())
                                    .to_std()
                                    .unwrap_or_default()
                            })
                        })
                })
                .unwrap_or(fallback);
            // Never retry before a provider's requested cooldown. Long waits
            // remain actionable rate-limit errors rather than hidden hangs.
            (delay <= Duration::from_secs(30)).then_some(delay)
        }
        ureq::Error::Transport(error)
            if matches!(
                error.kind(),
                ureq::ErrorKind::Dns
                    | ureq::ErrorKind::ConnectionFailed
                    | ureq::ErrorKind::Io
                    | ureq::ErrorKind::ProxyConnect
            ) =>
        {
            Some(fallback)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn status(code: u16, retry_after: &str) -> ureq::Error {
        ureq::Error::Status(
            code,
            format!("HTTP/1.1 {code} Error\r\nRetry-After: {retry_after}\r\n\r\n")
                .parse()
                .unwrap(),
        )
    }
    #[test]
    fn shared_ladder_is_jittered_within_its_step_and_bounded() {
        let delays = transient_retry_delays();
        for (index, base) in delays.iter().enumerate() {
            let delay = transient_retry_delay(index).unwrap();
            assert!(delay >= *base && delay <= *base + *base / 4, "{delay:?}");
        }
        assert_eq!(transient_retry_delay(delays.len()), None);
    }

    #[test]
    fn reads_a_stated_cooldown_and_ignores_a_hint_that_is_not_one() {
        for (error, expected) in [
            (
                "429 rate limited; retry after 12 seconds",
                Some(Duration::from_secs(12)),
            ),
            ("Retry-After: 5", Some(Duration::from_secs(5))),
            ("usage limit reached, try again in 2s", Some(Duration::from_secs(2))),
            ("rate limited; retry in 90s", None),
            ("retry after 1 min", None),
            ("retry after 3 attempts", None),
            ("connection reset by peer", None),
        ] {
            assert_eq!(retry_after_hint(error), expected, "{error}");
        }
    }

    #[test]
    fn recovers_transient_exchange_without_replaying_caller() {
        let mut requests = 0;
        let result = http_response(&CancellationToken::default(), || {
            requests += 1;
            if requests < 3 {
                Err(status(503, "0"))
            } else {
                Ok(ureq::Response::new(200, "OK", "done").unwrap())
            }
        });
        assert_eq!(result.unwrap().into_string().unwrap(), "done");
        assert_eq!(requests, 3);
    }
    #[test]
    fn bounded_retries_and_permanent_errors() {
        for (code, expected) in [(429, 4), (401, 1), (403, 1), (400, 1), (404, 1)] {
            let mut calls = 0;
            assert!(
                http_response::<ureq::Response>(&CancellationToken::default(), || {
                    calls += 1;
                    Err(status(code, "0"))
                })
                .is_err()
            );
            assert_eq!(calls, expected);
        }
        assert_eq!(retry_delay(&status(429, "60"), Duration::ZERO), None);
        assert_eq!(
            retry_delay(&status(503, "2"), Duration::ZERO),
            Some(Duration::from_secs(2))
        );
    }
    #[test]
    fn nested_stream_and_http_retries_share_one_budget() {
        let mut sends = 0;
        let result: anyhow::Result<()> = stream_response(
            &CancellationToken::default(),
            |_| {
                http_response(&CancellationToken::default(), || {
                    sends += 1;
                    if sends < 4 {
                        Err(status(503, "0"))
                    } else {
                        Ok(ureq::Response::new(200, "OK", "").unwrap())
                    }
                })?;
                anyhow::bail!("provider stream ended before completion")
            },
            |_| {},
        );
        assert!(result.is_err());
        assert_eq!(sends, 4);
    }

    #[test]
    fn cancellation_interrupts_backoff() {
        let token = CancellationToken::default();
        let mut calls = 0;
        let result = http_response::<ureq::Response>(&token, || {
            calls += 1;
            token.cancel();
            Err(status(503, "30"))
        });
        assert!(result.unwrap_err().to_string().contains("cancelled"));
        assert_eq!(calls, 1);
    }
}

/// Retry an interrupted response only before publishing text. Tool calls are
/// returned only after the complete response, so no tool has run at this point.
pub(crate) fn stream_response<T>(
    cancellation: &CancellationToken,
    mut run: impl FnMut(&mut dyn FnMut(&str)) -> anyhow::Result<T>,
    mut on_delta: impl FnMut(&str),
) -> anyhow::Result<T> {
    let _budget = RetryScope::start();
    for attempt in 0..3 {
        if cancellation.is_cancelled() {
            return Err(anyhow::anyhow!("Provider chat cancelled"));
        }
        let mut published = false;
        let result = run(&mut |delta| {
            published |= !delta.is_empty();
            on_delta(delta);
        });
        match result {
            Ok(response) => return Ok(response),
            Err(error) => {
                let description = format!("{error:#}");
                let interrupted = description.contains("stream ended before completion")
                    || ((description.contains("chat stream")
                        || description.contains("chat response"))
                        && (error.downcast_ref::<std::io::Error>().is_some_and(|error| {
                            matches!(
                                error.kind(),
                                std::io::ErrorKind::UnexpectedEof
                                    | std::io::ErrorKind::ConnectionReset
                                    | std::io::ErrorKind::ConnectionAborted
                                    | std::io::ErrorKind::BrokenPipe
                                    | std::io::ErrorKind::TimedOut
                                    | std::io::ErrorKind::WouldBlock
                            )
                        }) || error
                            .downcast_ref::<serde_json::Error>()
                            .is_some_and(|e| e.is_eof())));
                if published
                    || !interrupted
                    || attempt == 2
                    || cancellation.is_cancelled()
                    || !take_retry()
                {
                    return Err(error);
                }
                let deadline = Instant::now() + jitter(DELAYS[attempt]);
                while Instant::now() < deadline {
                    if cancellation.is_cancelled() {
                        return Err(anyhow::anyhow!("Provider chat cancelled"));
                    }
                    std::thread::sleep(
                        deadline
                            .saturating_duration_since(Instant::now())
                            .min(Duration::from_millis(50)),
                    );
                }
                crate::provider_observation::retry();
            }
        }
    }
    unreachable!()
}

#[cfg(test)]
mod stream_tests {
    use super::*;

    #[test]
    fn response_budget_accepts_exact_boundary_and_eof() {
        let mut reader = std::io::Cursor::new(b"hello\nworld");
        let mut line = String::new();
        let mut remaining = 11;
        assert_eq!(
            read_chat_line(&mut reader, &mut line, &mut remaining).unwrap(),
            6
        );
        assert_eq!(line, "hello\n");
        assert_eq!(
            read_chat_line(&mut reader, &mut line, &mut remaining).unwrap(),
            5
        );
        assert_eq!(line, "world");
        assert_eq!(remaining, 0);
        assert_eq!(
            read_chat_line(&mut reader, &mut line, &mut remaining).unwrap(),
            0
        );
    }

    #[test]
    fn oversized_line_stops_reading_before_allocating_the_whole_response() {
        let body = vec![b'x'; MAX_CHAT_LINE_BYTES + 100];
        let mut reader = std::io::Cursor::new(body);
        let mut line = String::new();
        let mut remaining = MAX_CHAT_RESPONSE_BYTES;
        let error = read_chat_line(&mut reader, &mut line, &mut remaining).unwrap_err();
        assert!(error.to_string().contains("size limit"));
        assert_eq!(reader.position(), (MAX_CHAT_LINE_BYTES + 1) as u64);
        assert!(line.len() <= MAX_CHAT_LINE_BYTES + 1);
    }

    #[test]
    fn response_budget_counts_small_frames_and_does_not_retry_limit_errors() {
        let mut calls = 0;
        let result: anyhow::Result<()> = stream_response(
            &CancellationToken::default(),
            |_| {
                calls += 1;
                let mut reader = std::io::Cursor::new(b":\n:\n:\n");
                let mut remaining = 4;
                let mut line = String::new();
                loop {
                    use anyhow::Context;
                    if read_chat_line(&mut reader, &mut line, &mut remaining)
                        .context("invalid provider chat stream")?
                        == 0
                    {
                        return Ok(());
                    }
                }
            },
            |_| {},
        );
        assert!(format!("{:#}", result.unwrap_err()).contains("size limit"));
        assert_eq!(calls, 1);
    }

    #[test]
    fn invalid_utf8_is_not_a_transient_stream_failure() {
        let mut calls = 0;
        let result: anyhow::Result<()> = stream_response(
            &CancellationToken::default(),
            |_| {
                calls += 1;
                use anyhow::Context;
                let mut reader = std::io::Cursor::new([0xff]);
                let mut remaining = MAX_CHAT_RESPONSE_BYTES;
                read_chat_line(&mut reader, &mut String::new(), &mut remaining)
                    .context("invalid provider chat stream")?;
                Ok(())
            },
            |_| {},
        );
        assert!(result.is_err());
        assert_eq!(calls, 1);
    }
    #[test]
    fn interrupted_unpublished_response_recovers() {
        let mut calls = 0;
        let mut output = String::new();
        let response = stream_response(
            &CancellationToken::default(),
            |emit| {
                calls += 1;
                if calls == 1 {
                    anyhow::bail!("provider stream ended before completion");
                }
                emit("recovered");
                Ok(42)
            },
            |delta| output.push_str(delta),
        )
        .unwrap();
        assert_eq!((calls, response, output.as_str()), (2, 42, "recovered"));
    }
    #[test]
    fn published_text_and_permanent_errors_are_not_replayed() {
        for published in [false, true] {
            let mut calls = 0;
            let result: anyhow::Result<()> = stream_response(
                &CancellationToken::default(),
                |emit| {
                    calls += 1;
                    if published {
                        emit("already visible");
                        anyhow::bail!("provider stream ended before completion");
                    }
                    anyhow::bail!("provider returned HTTP 401");
                },
                |_| {},
            );
            assert!(result.is_err());
            assert_eq!(calls, 1);
        }
    }
}
