//! Startup acknowledgements have a shorter deadline than model/tool execution.
use super::*;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) fn receive(
    messages: &mpsc::Receiver<Result<serde_json::Value, String>>,
    request_id: u64,
    run_deadline: Instant,
    cancelled: impl Fn() -> bool,
) -> Result<serde_json::Value, String> {
    receive_until(
        messages,
        request_id,
        run_deadline,
        STARTUP_TIMEOUT,
        cancelled,
    )
}

fn receive_until(
    messages: &mpsc::Receiver<Result<serde_json::Value, String>>,
    request_id: u64,
    run_deadline: Instant,
    startup_timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<serde_json::Value, String> {
    let deadline = run_deadline.min(Instant::now() + startup_timeout);
    receive_codex_app_server_response_until(messages, request_id, deadline, cancelled)
        .map_err(|error| match error.as_str() {
            "Codex usage request timed out" =>
                "Codex chat startup timed out before it acknowledged the request. Try again or restart the provider.".into(),
            "Codex usage service disconnected" =>
                "Codex chat startup disconnected before it acknowledged the request. Try again or restart the provider.".into(),
            _ => error,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silent_startup_does_not_inherit_the_day_long_turn_deadline() {
        let (_sender, messages) = mpsc::channel();
        let start = Instant::now();
        let error = receive_until(
            &messages,
            1,
            start + Duration::from_secs(24 * 60 * 60),
            Duration::from_millis(20),
            || false,
        )
        .unwrap_err();
        assert!(error.contains("chat startup timed out"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn unrelated_frames_cannot_extend_startup_or_acknowledge_the_request() {
        let (sender, messages) = mpsc::channel();
        for _ in 0..100 {
            sender
                .send(Ok(serde_json::json!({"method":"heartbeat"})))
                .unwrap();
            sender
                .send(Ok(serde_json::json!({"id":2,"result":{}})))
                .unwrap();
        }
        let error = receive_until(
            &messages,
            1,
            Instant::now() + Duration::from_secs(60),
            Duration::from_millis(20),
            || false,
        )
        .unwrap_err();
        assert!(error.contains("chat startup timed out"));
    }

    #[test]
    fn acknowledged_startup_returns_the_matching_response() {
        let (sender, messages) = mpsc::channel();
        sender
            .send(Ok(
                serde_json::json!({"id":2,"result":{"thread":{"id":"saved"}}}),
            ))
            .unwrap();
        let response = receive(
            &messages,
            2,
            Instant::now() + Duration::from_secs(60),
            || false,
        )
        .unwrap();
        assert_eq!(response["result"]["thread"]["id"], "saved");
    }

    #[test]
    fn cancellation_disconnect_and_shorter_run_deadline_are_preserved() {
        let (sender, messages) = mpsc::channel();
        let deadline = Instant::now() + Duration::from_secs(60);
        assert_eq!(
            receive(&messages, 1, deadline, || true).unwrap_err(),
            "Codex request was stopped"
        );
        assert!(receive(&messages, 1, Instant::now(), || false)
            .unwrap_err()
            .contains("startup timed out"));
        drop(sender);
        assert!(receive(&messages, 1, deadline, || false)
            .unwrap_err()
            .contains("startup disconnected"));
    }
}
