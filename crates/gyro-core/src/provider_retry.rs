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

pub(crate) fn http_response(
    cancellation: &CancellationToken,
    mut send: impl FnMut() -> Result<ureq::Response, ureq::Error>,
) -> Result<ureq::Response, ureq::Error> {
    for attempt in 0..=DELAYS.len() {
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        match send() {
            Ok(response) => return Ok(response),
            Err(error) => {
                let Some(delay) = DELAYS
                    .get(attempt)
                    .and_then(|delay| retry_delay(&error, *delay))
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
            assert!(http_response(&CancellationToken::default(), || {
                calls += 1;
                Err(status(code, "0"))
            })
            .is_err());
            assert_eq!(calls, expected);
        }
        assert_eq!(retry_delay(&status(429, "60"), Duration::ZERO), None);
        assert_eq!(
            retry_delay(&status(503, "2"), Duration::ZERO),
            Some(Duration::from_secs(2))
        );
    }
    #[test]
    fn cancellation_interrupts_backoff() {
        let token = CancellationToken::default();
        let mut calls = 0;
        let result = http_response(&token, || {
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
    for attempt in 0..3 {
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
                if published || !interrupted || attempt == 2 || cancellation.is_cancelled() {
                    return Err(error);
                }
                let deadline = Instant::now() + DELAYS[attempt];
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
