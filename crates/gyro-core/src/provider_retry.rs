//! Retry one HTTP exchange, never an agent's already-executed tool loop.
use crate::CancellationToken;
use std::time::{Duration, Instant};

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
                        && (error.downcast_ref::<std::io::Error>().is_some()
                            || error
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
