use anyhow::{bail, ensure, Context, Result};
use std::{
    collections::BTreeSet,
    net::{Ipv4Addr, SocketAddr, TcpListener},
    sync::{Arc, Mutex},
    thread::JoinHandle,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::oneshot,
    task::JoinSet,
    time::timeout,
};

const MAX_CONNECTIONS: usize = 16;
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) fn destinations(value: &serde_json::Value) -> Result<BTreeSet<String>> {
    let Some(value) = value.get("networkDestinations") else {
        return Ok(BTreeSet::new());
    };
    let names = value
        .as_array()
        .context("networkDestinations must be a list of hostnames")?;
    ensure!(names.len() <= 16, "Specify at most 16 HTTPS destinations");
    names
        .iter()
        .map(|entry| {
            canonical_host(entry.as_str().context("Expected an HTTPS hostname")?)
                .context("Use an exact public HTTPS hostname, without a URL or port")
        })
        .collect()
}

fn canonical_host(host: &str) -> Option<String> {
    let labels: Vec<_> = host.split('.').collect();
    (host.len() <= 253
        && labels.len() >= 2
        && labels
            .last()?
            .bytes()
            .any(|byte| byte.is_ascii_alphabetic())
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        }))
    .then(|| host.to_ascii_lowercase())
}

fn public_address(ip: Ipv4Addr) -> bool {
    match ip.octets() {
        [0 | 10 | 127 | 224..=255, ..]
        | [100, 64..=127, ..]
        | [169, 254, ..]
        | [172, 16..=31, ..]
        | [192, 0 | 168, ..]
        | [192, 88, 99, _]
        | [198, 18 | 19, ..]
        | [198, 51, 100, _]
        | [203, 0, 113, _] => false,
        _ => true,
    }
}

pub(crate) struct CommandNetwork {
    port: u16,
    blocked: Arc<Mutex<BTreeSet<String>>>,
    shutdown: Option<oneshot::Sender<()>>,
    worker: Option<JoinHandle<()>>,
}

impl CommandNetwork {
    pub(crate) fn open(approved: BTreeSet<String>) -> Result<Self> {
        ensure!(!approved.is_empty(), "No approved HTTPS destinations");
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let (shutdown, mut stopped) = oneshot::channel();
        let approved = Arc::new(approved);
        let blocked = Arc::new(Mutex::new(BTreeSet::new()));
        let blocked_by_worker = blocked.clone();
        let worker = std::thread::Builder::new().name("gyro-command-network".into()).spawn(move || {
            runtime.block_on(async move {
                let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
                let mut connections = JoinSet::new();
                loop {
                    tokio::select! {
                        _ = &mut stopped => break,
                        _ = connections.join_next(), if !connections.is_empty() => {},
                        connection = listener.accept(), if connections.len() < MAX_CONNECTIONS => {
                            let Ok((client, _)) = connection else { break };
                            let approved = approved.clone();
                            let blocked = blocked_by_worker.clone();
                            connections.spawn(async move { let _ = relay(client, &approved, &blocked).await; });
                        }
                    }
                }
                connections.shutdown().await;
            });
        })?;
        Ok(Self {
            port,
            blocked,
            shutdown: Some(shutdown),
            worker: Some(worker),
        })
    }

    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    pub(crate) fn blocked_destinations(&self) -> Vec<String> {
        self.blocked
            .lock()
            .map_or_else(|_| Vec::new(), |hosts| hosts.iter().cloned().collect())
    }
}

impl Drop for CommandNetwork {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

async fn connect_request(client: &mut TcpStream) -> Result<String> {
    let mut header = Vec::new();
    // Stop at the end of the header without consuming any TLS tunnel bytes.
    loop {
        ensure!(header.len() < 8192, "Proxy request header is too large");
        header.push(client.read_u8().await?);
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let request = std::str::from_utf8(&header)?
        .lines()
        .next()
        .context("Expected a proxy request")?;
    let mut fields = request.split(' ');
    ensure!(
        fields.next() == Some("CONNECT"),
        "Only HTTPS CONNECT is supported"
    );
    let host = fields
        .next()
        .and_then(|target| target.strip_suffix(":443"))
        .and_then(canonical_host)
        .context("Expected a public HTTPS hostname on port 443")?;
    ensure!(
        matches!(fields.next(), Some("HTTP/1.0" | "HTTP/1.1")) && fields.next().is_none(),
        "Invalid proxy request"
    );
    Ok(host)
}

async fn relay(
    mut client: TcpStream,
    approved: &BTreeSet<String>,
    blocked: &Mutex<BTreeSet<String>>,
) -> Result<()> {
    let host = timeout(HEADER_TIMEOUT, connect_request(&mut client)).await??;
    if !approved.contains(&host) {
        if let Ok(mut entries) = blocked.lock() {
            if entries.len() < 32 {
                entries.insert(host);
            }
        }
        client
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await?;
        return Ok(());
    }
    let connection = timeout(HEADER_TIMEOUT, connect_public(&host)).await;
    let Ok(Ok(mut upstream)) = connection else {
        client
            .write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await?;
        return Ok(());
    };
    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;
    tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}

async fn connect_public(host: &str) -> Result<TcpStream> {
    // An explicit absolute DNS name avoids search-domain expansion. Connect to
    // the validated numeric result, so the connector never resolves it again.
    let absolute = format!("{host}.");
    let addresses = tokio::net::lookup_host((absolute.as_str(), 443)).await?;
    for address in addresses {
        if let SocketAddr::V4(address) = address {
            if public_address(*address.ip()) {
                if let Ok(stream) = TcpStream::connect(address).await {
                    return Ok(stream);
                }
            }
        }
    }
    bail!("No public IPv4 HTTPS endpoint is reachable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_an_unapproved_connect_and_reports_its_destination() {
        use std::io::{Read, Write};

        let allowed = destinations(&serde_json::json!({
            "networkDestinations": ["registry.npmjs.org"]
        }))
        .unwrap();
        let proxy = CommandNetwork::open(allowed).unwrap();
        let mut client = std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port())).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client
            .write_all(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 403"));
        assert_eq!(proxy.blocked_destinations(), ["example.com"]);
    }

    #[test]
    fn accepts_exact_hosts_and_rejects_local_targets_and_cidr_ranges() {
        assert_eq!(
            canonical_host("Registry.NPMJS.org").as_deref(),
            Some("registry.npmjs.org")
        );
        for value in [
            "*.npmjs.org",
            "https://npmjs.org",
            "localhost",
            "127.0.0.1",
            "npmjs.org:443",
            "npmjs.org/",
        ] {
            assert!(canonical_host(value).is_none(), "{value}");
        }
        for value in [
            "127.0.0.1",
            "10.0.0.5",
            "192.168.0.5",
            "169.254.169.254",
            "100.64.0.1",
            "203.0.113.1",
        ] {
            assert!(!public_address(value.parse().unwrap()), "{value}");
        }
        assert!(public_address("1.1.1.1".parse().unwrap()));
    }
}
