//! Cancellable, pooled generation transport behind the synchronous adapters.
//! Dropping a pending request/body releases it; no detached blocking readers
//! survive Stop. Short health probes continue to use the existing ureq client.
use crate::CancellationToken;
use serde_json::Value;
use std::{
    future::Future,
    io::{self, Read},
    sync::OnceLock,
    time::Duration,
};

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .thread_name("gyro-provider-http")
            .build()
            .expect("provider HTTP runtime")
    })
}
fn client(local: bool) -> &'static reqwest::Client {
    static LOCAL: OnceLock<reqwest::Client> = OnceLock::new();
    static REMOTE: OnceLock<reqwest::Client> = OnceLock::new();
    if local { &LOCAL } else { &REMOTE }.get_or_init(|| {
        let _entered = runtime().enter();
        let _ = rustls::crypto::ring::default_provider().install_default();
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(if local { 5 } else { 15 }))
            .pool_max_idle_per_host(4);
        let builder = if local { builder.no_proxy() } else { builder };
        builder.build().expect("provider HTTP client")
    })
}
fn wait<T>(
    cancellation: &CancellationToken,
    idle: Duration,
    future: impl Future<Output = Result<T, reqwest::Error>>,
) -> io::Result<T> {
    runtime().block_on(async {
        if cancellation.is_cancelled() { return Err(cancelled()); }
        tokio::pin!(future);
        let deadline = tokio::time::sleep(idle);
        tokio::pin!(deadline);
        tokio::select! {
            biased;
            _ = cancellation.wait_cancelled() => Err(cancelled()),
            result = &mut future => result.map_err(|error|
                io::Error::new(if error.is_timeout() { io::ErrorKind::TimedOut } else { io::ErrorKind::ConnectionAborted }, error.without_url())),
            _ = &mut deadline => Err(io::Error::new(io::ErrorKind::TimedOut, "provider stream idle timeout")),
        }
    })
}
fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "Provider chat cancelled")
}

pub(crate) struct Response {
    response: reqwest::Response,
    cancellation: CancellationToken,
    idle: Duration,
}
impl Response {
    pub(crate) fn status(&self) -> u16 {
        self.response.status().as_u16()
    }
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.response.headers().get(name)?.to_str().ok()
    }
    pub(crate) fn content_type(&self) -> &str {
        self.header("content-type").unwrap_or("")
    }
    pub(crate) fn get_url(&self) -> &str {
        self.response.url().as_str()
    }
    pub(crate) fn into_reader(self) -> Reader {
        Reader {
            response: self,
            pending: Vec::new(),
            offset: 0,
        }
    }
}
pub(crate) struct Reader {
    response: Response,
    pending: Vec<u8>,
    offset: usize,
}
impl Read for Reader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        // Read::read_to_string retries Interrupted automatically. Cancellation
        // must use a terminal error here so buffered error bodies also stop.
        if self.response.cancellation.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "Provider chat cancelled",
            ));
        }
        while self.offset == self.pending.len() {
            let chunk = wait(
                &self.response.cancellation,
                self.response.idle,
                self.response.response.chunk(),
            )
            .map_err(|error| {
                if self.response.cancellation.is_cancelled() {
                    io::Error::new(io::ErrorKind::ConnectionAborted, "Provider chat cancelled")
                } else {
                    error
                }
            })?;
            let Some(chunk) = chunk else { return Ok(0) };
            self.pending = chunk.to_vec();
            self.offset = 0;
        }
        let count = output.len().min(self.pending.len() - self.offset);
        output[..count].copy_from_slice(&self.pending[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }
}

pub(crate) fn post(
    url: &url::Url,
    key: &str,
    payload: &Value,
    cancellation: &CancellationToken,
    idle: Duration,
    local: bool,
) -> Result<Response, ureq::Error> {
    let mut request = client(local)
        .post(url.as_str())
        .header("Accept", "text/event-stream")
        .header("Accept-Encoding", "identity")
        .header("User-Agent", concat!("gyro/", env!("CARGO_PKG_VERSION")))
        .json(payload);
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    let response = wait(cancellation, idle, request.send())?;
    let mut response = Response {
        response,
        cancellation: cancellation.clone(),
        idle,
    };
    if response.status() >= 400 {
        let status = response.status();
        let retry_after = response.header("retry-after").map(str::to_owned);
        let mut body = Vec::new();
        // The status is authoritative even if its explanatory body is broken.
        // Bound the entire error-body read so a quiet/dripping error cannot
        // consume the generation idle budget or turn a 401 into a retryable IO error.
        let body_result = wait(cancellation, idle.min(Duration::from_secs(5)), async {
            while body.len() < 8192 {
                let Some(chunk) = response.response.chunk().await? else {
                    break;
                };
                let take = chunk.len().min(8192 - body.len());
                body.extend_from_slice(&chunk[..take]);
            }
            Ok(())
        });
        if cancellation.is_cancelled() {
            return Err(body_result.err().unwrap_or_else(cancelled).into());
        }
        let body = String::from_utf8_lossy(&body);
        // Preserve the bounded provider error and Retry-After for the existing
        // retry/classification contract without holding a network response open.
        let header = retry_after.map_or(String::new(), |value| format!("Retry-After: {value}\r\n"));
        let wire = format!(
            "HTTP/1.1 {status} Provider Error\r\n{header}Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        return Err(ureq::Error::Status(
            status,
            wire.parse()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
        ));
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        sync::mpsc,
        time::Instant,
    };
    #[test]
    fn broken_or_silent_error_bodies_preserve_status_and_retry_guidance() {
        for (status, quiet) in [(401, false), (429, true)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = url::Url::parse(&format!("http://{}/chat", listener.local_addr().unwrap()))
                .unwrap();
            let (release, wait_release) = mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                let mut length = 0;
                loop {
                    line.clear();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                }
                reader.read_exact(&mut vec![0; length]).unwrap();
                write!(stream, "HTTP/1.1 {status} Error\r\nRetry-After: 60\r\nContent-Length: 100\r\n\r\nrejected").unwrap();
                if quiet {
                    wait_release.recv_timeout(Duration::from_secs(3)).unwrap();
                }
            });
            let start = Instant::now();
            let result = post(
                &url,
                "",
                &serde_json::json!({}),
                &CancellationToken::default(),
                Duration::from_millis(100),
                true,
            );
            if quiet {
                release.send(()).unwrap();
            }
            server.join().unwrap();
            assert!(start.elapsed() < Duration::from_secs(1));
            let Err(ureq::Error::Status(actual, response)) = result else {
                panic!("a damaged error body must not hide its HTTP status");
            };
            assert_eq!(actual, status);
            assert_eq!(response.header("retry-after"), Some("60"));
            assert_eq!(response.into_string().unwrap(), "rejected");
        }
    }
    #[test]
    fn stop_closes_a_silent_request_and_a_silent_body() {
        for status in [None, Some(200), Some(401)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = url::Url::parse(&format!("http://{}/chat", listener.local_addr().unwrap()))
                .unwrap();
            let (ready_tx, ready_rx) = mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                let mut length = 0;
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                }
                reader.read_exact(&mut vec![0; length]).unwrap();
                if let Some(status) = status {
                    write!(
                        stream,
                        "HTTP/1.1 {status} Response\r\nContent-Length: 100\r\n\r\n"
                    )
                    .unwrap();
                }
                ready_tx.send(()).unwrap();
                let closed = stream.read(&mut [0]);
                assert!(
                    matches!(closed, Ok(0))
                        || closed.is_err_and(|e| matches!(
                            e.kind(),
                            io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
                        ))
                );
            });
            let cancellation = CancellationToken::default();
            let worker_token = cancellation.clone();
            let (body_tx, body_rx) = mpsc::channel();
            let worker = std::thread::spawn(move || -> anyhow::Result<()> {
                let response = post(
                    &url,
                    "",
                    &serde_json::json!({}),
                    &worker_token,
                    Duration::from_secs(60),
                    true,
                )?;
                body_tx.send(()).unwrap();
                response.into_reader().read_to_string(&mut String::new())?;
                Ok(())
            });
            ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            if status == Some(200) {
                body_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            }
            let start = Instant::now();
            cancellation.cancel();
            assert!(worker.join().unwrap().is_err());
            assert!(start.elapsed() < Duration::from_secs(1));
            server.join().unwrap();
        }
    }
}
