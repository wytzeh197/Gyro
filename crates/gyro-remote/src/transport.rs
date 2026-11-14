use crate::{protocol::MAX_FRAME, Operation, RemoteEvent, Request, Response, ALPN};
use anyhow::{bail, Context, Result};
use iroh::{
    endpoint::{presets, Connection, RecvStream, SendStream},
    Endpoint, EndpointId, SecretKey,
};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{broadcast, Mutex, OwnedSemaphorePermit, Semaphore},
};

pub type Handler =
    Arc<dyn Fn(String, Request) -> Pin<Box<dyn Future<Output = Response> + Send>> + Send + Sync>;
/// Decides whether an authenticated remote identity is a paired device.
pub type TrustCheck = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// mDNS service label, so Macs on one network find each other without internet or relays.
const LAN_SERVICE: &str = "gyro-remote";
/// Concurrent QUIC handshakes. Held only while handshaking, never for a connection's lifetime.
const HANDSHAKES: usize = 32;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Connections from paired devices. Their liveness comes from QUIC keep-alives.
const TRUSTED_CONNECTIONS: usize = 64;
const TRUSTED_STREAMS: usize = 16;
/// Unpaired identities may only pair. They get a few short-lived slots so they can never
/// starve paired devices.
const GUEST_CONNECTIONS: usize = 4;
const GUEST_STREAMS: usize = 2;
const GUEST_IDLE: Duration = Duration::from_secs(20);
/// Slightly longer than an invitation's validity, so a pending pair can finish.
const GUEST_LIFETIME: Duration = Duration::from_secs(6 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

struct Admission {
    trust: std::sync::RwLock<Option<TrustCheck>>,
    handshakes: Arc<Semaphore>,
    trusted: Arc<Semaphore>,
    guests: Arc<Semaphore>,
    inbound: std::sync::Mutex<HashMap<String, Vec<Connection>>>,
}
impl Admission {
    fn trusts(&self, peer: &str) -> bool {
        match self.trust.read().ok().and_then(|t| t.clone()) {
            Some(check) => check(peer),
            // Without a policy (tests, tools) every authenticated identity is admitted.
            None => true,
        }
    }
    fn track(&self, peer: &str, c: &Connection) {
        if let Ok(mut inbound) = self.inbound.lock() {
            let list = inbound.entry(peer.into()).or_default();
            list.retain(|c| c.close_reason().is_none());
            list.push(c.clone());
        }
    }
    fn untrack(&self, peer: &str, c: &Connection) {
        if let Ok(mut inbound) = self.inbound.lock() {
            if let Some(list) = inbound.get_mut(peer) {
                list.retain(|x| x.stable_id() != c.stable_id() && x.close_reason().is_none());
                if list.is_empty() {
                    inbound.remove(peer);
                }
            }
        }
    }
}

pub struct Node {
    endpoint: Endpoint,
    connections: Mutex<HashMap<String, Connection>>,
    dialing: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    addresses: Mutex<HashMap<String, iroh::EndpointAddr>>,
    admission: Arc<Admission>,
    pub events: broadcast::Sender<RemoteEvent>,
}
impl Node {
    /// An isolated loopback endpoint for deterministic integration checks.
    pub async fn bind_loopback(secret: [u8; 32], handler: Handler) -> Result<Arc<Self>> {
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::from_bytes(&secret))
            .alpns(vec![ALPN.to_vec()])
            .bind_addr("127.0.0.1:0")?
            .bind()
            .await?;
        Self::from_endpoint(endpoint, handler)
    }
    /// Direct UDP first (LAN via mDNS, internet via hole punching and port mapping); the
    /// public relays only carry traffic when no direct path exists, and stay end-to-end
    /// encrypted.
    pub async fn bind(secret: [u8; 32], handler: Handler) -> Result<Arc<Self>> {
        let endpoint = Endpoint::builder(presets::N0)
            .secret_key(SecretKey::from_bytes(&secret))
            .alpns(vec![ALPN.to_vec()])
            .address_lookup(
                iroh_mdns_address_lookup::MdnsAddressLookup::builder().service_name(LAN_SERVICE),
            )
            .bind()
            .await?;
        Self::from_endpoint(endpoint, handler)
    }
    fn from_endpoint(endpoint: Endpoint, handler: Handler) -> Result<Arc<Self>> {
        let (events, _) = broadcast::channel(256);
        let admission = Arc::new(Admission {
            trust: std::sync::RwLock::new(None),
            handshakes: Arc::new(Semaphore::new(HANDSHAKES)),
            trusted: Arc::new(Semaphore::new(TRUSTED_CONNECTIONS)),
            guests: Arc::new(Semaphore::new(GUEST_CONNECTIONS)),
            inbound: std::sync::Mutex::new(HashMap::new()),
        });
        let node = Arc::new(Self {
            endpoint,
            connections: Mutex::new(HashMap::new()),
            dialing: Mutex::new(HashMap::new()),
            addresses: Mutex::new(HashMap::new()),
            admission: admission.clone(),
            events,
        });
        let endpoint = node.endpoint.clone();
        let events = node.events.clone();
        tokio::spawn(async move {
            while let Some(incoming) = endpoint.accept().await {
                let Ok(handshake) = admission.handshakes.clone().try_acquire_owned() else {
                    incoming.refuse();
                    continue;
                };
                let handler = handler.clone();
                let admission = admission.clone();
                let events = events.clone();
                tokio::spawn(async move {
                    let connection = {
                        let _handshake = handshake;
                        match tokio::time::timeout(HANDSHAKE_TIMEOUT, incoming).await {
                            Ok(Ok(c)) => c,
                            _ => return,
                        }
                    };
                    let peer = connection.remote_id().to_string();
                    let trusted = admission.trusts(&peer);
                    let pool = if trusted { &admission.trusted } else { &admission.guests };
                    let Ok(permit) = pool.clone().try_acquire_owned() else {
                        connection.close(2u32.into(), b"host busy");
                        return;
                    };
                    serve(connection, peer, trusted, permit, handler, admission, events).await;
                });
            }
        });
        Ok(node)
    }
    /// Installs the host's pairing policy. Unpaired identities are limited to pairing slots.
    pub fn set_trust(&self, check: TrustCheck) {
        if let Ok(mut trust) = self.admission.trust.write() {
            *trust = Some(check);
        }
    }
    pub fn id(&self) -> String {
        self.endpoint.id().to_string()
    }
    pub fn address(&self) -> iroh::EndpointAddr {
        let mut addr = self.endpoint.addr();
        for socket in self
            .endpoint
            .bound_sockets()
            .into_iter()
            .filter(|a| a.ip().is_loopback())
        {
            addr = addr.with_ip_addr(socket);
        }
        addr
    }
    pub async fn remember(&self, peer: &str, address: iroh::EndpointAddr) -> Result<()> {
        if address.id.to_string() != peer {
            bail!("Invitation address identity does not match the host")
        }
        let mut addresses = self.addresses.lock().await;
        if addresses.len() >= 16 && !addresses.contains_key(peer) {
            // Hints only speed up the first dial; lookup still finds evicted hosts.
            if let Some(evict) = addresses.keys().next().cloned() {
                addresses.remove(&evict);
            }
        }
        addresses.insert(peer.into(), address);
        Ok(())
    }
    async fn cached(&self, peer: &str) -> Option<Connection> {
        self.connections
            .lock()
            .await
            .get(peer)
            .filter(|c| c.close_reason().is_none())
            .cloned()
    }
    async fn connection(&self, peer: &str) -> Result<Connection> {
        if let Some(c) = self.cached(peer).await {
            return Ok(c);
        }
        // One dial per host; other hosts and cached connections never wait on it.
        let gate = self
            .dialing
            .lock()
            .await
            .entry(peer.into())
            .or_default()
            .clone();
        let _dial = gate.lock().await;
        if let Some(c) = self.cached(peer).await {
            return Ok(c);
        }
        {
            let mut connections = self.connections.lock().await;
            connections.retain(|_, c| c.close_reason().is_none());
            if connections.len() >= 16 {
                bail!("Too many connected devices")
            }
        }
        let id: EndpointId = peer.parse().context("Invalid device identity")?;
        let address = self
            .addresses
            .lock()
            .await
            .get(peer)
            .cloned()
            .unwrap_or_else(|| iroh::EndpointAddr::new(id));
        let c = tokio::time::timeout(CONNECT_TIMEOUT, self.endpoint.connect(address, ALPN))
            .await
            .context("Host connection timed out")??;
        self.connections
            .lock()
            .await
            .insert(peer.into(), c.clone());
        Ok(c)
    }
    async fn evict(&self, peer: &str, stale: &Connection) {
        let mut connections = self.connections.lock().await;
        if connections
            .get(peer)
            .is_some_and(|c| c.stable_id() == stale.stable_id())
        {
            connections.remove(peer);
        }
    }
    /// Opens a stream, redialing once when the cached connection died (sleep, network
    /// change, host restart). Nothing has been sent yet, so the retry cannot duplicate work.
    async fn open(&self, peer: &str) -> Result<(SendStream, RecvStream)> {
        let c = self.connection(peer).await?;
        match c.open_bi().await {
            Ok(streams) => Ok(streams),
            Err(_) => {
                self.evict(peer, &c).await;
                Ok(self.connection(peer).await?.open_bi().await?)
            }
        }
    }
    pub async fn request(&self, peer: &str, request: Request) -> Result<Response> {
        tokio::time::timeout(REQUEST_TIMEOUT, async {
            let c = self.connection(peer).await?;
            match exchange(&c, &request).await {
                Err(_) if c.close_reason().is_some() => {
                    // The connection died under us (sleep, network change, host restart).
                    // Resending the same request id is safe: the host fences mutations by id
                    // and replays a finished result instead of running it twice.
                    self.evict(peer, &c).await;
                    exchange(&self.connection(peer).await?, &request).await
                }
                result => result,
            }
        })
        .await
        .context(
            "Remote request timed out; its outcome may be uncertain. Refresh before retrying.",
        )?
    }
    pub async fn watch(
        &self,
        peer: &str,
        request: Request,
        callback: Arc<dyn Fn(RemoteEvent) + Send + Sync>,
    ) -> Result<tokio::task::JoinHandle<()>> {
        let (mut send, mut recv) = self.open(peer).await?;
        write_frame(&mut send, &request).await?;
        send.finish()?;
        let initial: Response =
            tokio::time::timeout(Duration::from_secs(20), read_frame(&mut recv)).await??;
        initial.into_result().map_err(anyhow::Error::msg)?;
        let session_id = request
            .operation
            .session_id()
            .unwrap_or_default()
            .to_string();
        Ok(tokio::spawn(async move {
            while let Ok(event) = read_frame::<RemoteEvent, _>(&mut recv).await {
                callback(event)
            }
            callback(RemoteEvent {
                session_id,
                topic: "resync".into(),
                payload: serde_json::json!({"streamClosed":true}),
            });
        }))
    }
    /// Closes every connection with this device, in both directions.
    pub async fn disconnect(&self, peer: &str) {
        if let Some(c) = self.connections.lock().await.remove(peer) {
            c.close(0u32.into(), b"device disconnected")
        }
        let inbound = self
            .admission
            .inbound
            .lock()
            .ok()
            .and_then(|mut i| i.remove(peer))
            .unwrap_or_default();
        for c in inbound {
            c.close(0u32.into(), b"device disconnected")
        }
    }
    pub async fn close(&self) {
        self.endpoint.close().await
    }
    pub fn generate_secret() -> [u8; 32] {
        SecretKey::generate().to_bytes()
    }
}
async fn exchange(c: &Connection, request: &Request) -> Result<Response> {
    let (mut send, mut recv) = c.open_bi().await?;
    write_frame(&mut send, request).await?;
    send.finish()?;
    let response: Response = read_frame(&mut recv).await?;
    if response.id != request.id {
        bail!("Mismatched response identity")
    }
    Ok(response)
}
async fn serve(
    c: Connection,
    peer: String,
    mut trusted: bool,
    mut permit: OwnedSemaphorePermit,
    handler: Handler,
    admission: Arc<Admission>,
    events: broadcast::Sender<RemoteEvent>,
) {
    admission.track(&peer, &c);
    let started = Instant::now();
    let mut limits = Arc::new(Semaphore::new(if trusted {
        TRUSTED_STREAMS
    } else {
        GUEST_STREAMS
    }));
    loop {
        let next = if trusted {
            // QUIC keep-alives and idle timeouts end dead connections; a quiet paired
            // device keeps its watch stream instead of being cut every two minutes.
            c.accept_bi().await.ok()
        } else {
            let left = GUEST_LIFETIME.saturating_sub(started.elapsed());
            tokio::time::timeout(GUEST_IDLE.min(left), c.accept_bi())
                .await
                .ok()
                .and_then(|r| r.ok())
        };
        let Some((mut send, mut recv)) = next else {
            break;
        };
        if !trusted && admission.trusts(&peer) {
            // Approved while connected: move to a paired slot without reconnecting.
            if let Ok(upgraded) = admission.trusted.clone().try_acquire_owned() {
                permit = upgraded;
                trusted = true;
                limits = Arc::new(Semaphore::new(TRUSTED_STREAMS));
            }
        }
        let Ok(stream) = limits.clone().try_acquire_owned() else {
            let _ = send.reset(1u32.into());
            continue;
        };
        let handler = handler.clone();
        let peer = peer.clone();
        let events = events.clone();
        let connection = c.clone();
        tokio::spawn(async move {
            let _stream = stream;
            let Ok(Ok(request)) =
                tokio::time::timeout(Duration::from_secs(15), read_frame::<Request, _>(&mut recv))
                    .await
            else {
                return;
            };
            let watched = if let Operation::Watch { session_id } = &request.operation {
                Some(session_id.clone())
            } else {
                None
            };
            let mut receiver = events.subscribe();
            let watch_request = watched.as_ref().map(|_| request.clone());
            let response = handler(peer.clone(), request).await;
            let success = response.error.is_none();
            if write_frame(&mut send, &response).await.is_err() {
                let _=write_frame(&mut send,&Response::result(response.id,Err("Remote response exceeds its size limit. Open a smaller history page or file.".into()))).await;
                return;
            }
            if let Some(session) = watched.filter(|_| success) {
                let watch_request = watch_request.unwrap();
                loop {
                    // A quiet subscription must release its slot on cancellation,
                    // without waiting for another event in this session.
                    let event = tokio::select! {
                        biased;
                        _ = connection.closed() => break,
                        _ = send.stopped() => break,
                        event = receiver.recv() => event,
                    };
                    match event {
                        Ok(event) if event.session_id == session => {
                            if event.topic == "scopeRevoked" {
                                break;
                            }
                            // Reuse Watch admission, which has no mutation/control
                            // side effects. Revocation broadcasts can be lost when
                            // the receiver lags; current authorization is authoritative.
                            if handler(peer.clone(), watch_request.clone())
                                .await
                                .error
                                .is_some()
                            {
                                break;
                            }
                            if write_frame(&mut send, &event).await.is_err() {
                                break;
                            }
                        }
                        Ok(event)
                            if event.topic == "revoked"
                                && event.payload.as_str() == Some(&peer) =>
                        {
                            break
                        }
                        Ok(_) => {}
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            if handler(peer.clone(), watch_request.clone())
                                .await
                                .error
                                .is_some()
                            {
                                break;
                            }
                            if write_frame(
                                &mut send,
                                &RemoteEvent {
                                    session_id: session.clone(),
                                    topic: "resync".into(),
                                    payload: serde_json::Value::Null,
                                },
                            )
                            .await
                            .is_err()
                            {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
            let _ = send.finish();
        });
    }
    drop(permit);
    admission.untrack(&peer, &c);
    c.close(0u32.into(), b"connection closed");
}
pub async fn read_frame<T: DeserializeOwned, R: AsyncRead + Unpin>(reader: &mut R) -> Result<T> {
    let len = reader.read_u32().await? as usize;
    if len > MAX_FRAME {
        bail!("Remote frame exceeds limit")
    }
    let mut bytes = vec![0; len];
    reader.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}
pub async fn write_frame<T: Serialize, W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &T,
) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_FRAME {
        bail!("Remote frame exceeds limit")
    }
    writer.write_u32(bytes.len() as u32).await?;
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn assert_no_watch_receivers(host: &Node) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while host.events.receiver_count() != 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("canceled/disconnected watches must release their server stream slots");
    }

    async fn watch_pair() -> (Arc<Node>, Arc<Node>) {
        let handler: Handler = Arc::new(|_, request| {
            Box::pin(async move { Response::result(request.id, Ok(serde_json::Value::Null)) })
        });
        let host = Node::bind_loopback(Node::generate_secret(), handler.clone())
            .await
            .unwrap();
        let client = Node::bind_loopback(Node::generate_secret(), handler)
            .await
            .unwrap();
        client.remember(&host.id(), host.address()).await.unwrap();
        (host, client)
    }

    fn watch_request(session: &str) -> Request {
        Request {
            id: uuid::Uuid::new_v4(),
            lease: None,
            operation: Operation::Watch {
                session_id: session.into(),
            },
        }
    }

    #[tokio::test]
    async fn canceled_quiet_watches_release_slots_without_session_events() {
        let (host, client) = watch_pair().await;
        // More switches than the connection's stream limit, with no provider events
        // to accidentally clean up the old watches.
        for i in 0..TRUSTED_STREAMS * 2 {
            let watch = client
                .watch(
                    &host.id(),
                    watch_request(&format!("quiet-{i}")),
                    Arc::new(|_| {}),
                )
                .await
                .unwrap();
            watch.abort();
            let _ = watch.await;
            assert_no_watch_receivers(&host).await;
        }
        client
            .request(
                &host.id(),
                Request {
                    id: uuid::Uuid::new_v4(),
                    lease: None,
                    operation: Operation::Hello,
                },
            )
            .await
            .unwrap()
            .into_result()
            .unwrap();
        client.close().await;
        host.close().await;
    }

    #[tokio::test]
    async fn disconnected_quiet_watches_release_slots_without_session_events() {
        let (host, client) = watch_pair().await;
        let watch = client
            .watch(&host.id(), watch_request("quiet"), Arc::new(|_| {}))
            .await
            .unwrap();
        client.disconnect(&host.id()).await;
        assert_no_watch_receivers(&host).await;
        tokio::time::timeout(Duration::from_secs(2), watch)
            .await
            .unwrap()
            .unwrap();
        client.close().await;
        host.close().await;
    }

    #[tokio::test]
    async fn watch_rechecks_authorization_even_when_revocation_event_is_lost() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let allowed = Arc::new(AtomicBool::new(true));
        let flag = allowed.clone();
        let handler: Handler = Arc::new(move |_, request| {
            let allowed = flag.load(Ordering::SeqCst);
            Box::pin(async move {
                Response::result(
                    request.id,
                    if allowed {
                        Ok(serde_json::Value::Null)
                    } else {
                        Err("Scope revoked".into())
                    },
                )
            })
        });
        let host = Node::bind_loopback(Node::generate_secret(), handler.clone())
            .await
            .unwrap();
        let client = Node::bind_loopback(Node::generate_secret(), handler)
            .await
            .unwrap();
        client.remember(&host.id(), host.address()).await.unwrap();
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let watch = client
            .watch(
                &host.id(),
                watch_request("s"),
                Arc::new(move |event| {
                    let _ = sender.send(event);
                }),
            )
            .await
            .unwrap();
        host.events
            .send(RemoteEvent {
                session_id: "s".into(),
                topic: "provider".into(),
                payload: serde_json::json!("allowed"),
            })
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                .await
                .unwrap()
                .unwrap()
                .payload,
            "allowed"
        );
        allowed.store(false, Ordering::SeqCst);
        // This test uses the current-thread runtime: overflow the broadcast before
        // yielding so the scopeRevoked event is definitely lost to this receiver.
        host.events
            .send(RemoteEvent {
                session_id: "s".into(),
                topic: "scopeRevoked".into(),
                payload: serde_json::Value::Null,
            })
            .unwrap();
        for _ in 0..512 {
            host.events
                .send(RemoteEvent {
                    session_id: "s".into(),
                    topic: "provider".into(),
                    payload: serde_json::json!("forbidden"),
                })
                .unwrap();
        }
        let closed = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closed.topic, "resync");
        assert_eq!(
            closed.payload["streamClosed"], true,
            "revoked watches must close, not send a resync or provider payload"
        );
        assert_no_watch_receivers(&host).await;
        watch.await.unwrap();
        client.close().await;
        host.close().await;
    }

    #[tokio::test]
    async fn oversized_frames_reject_before_allocation() {
        let mut bytes = ((MAX_FRAME + 1) as u32).to_be_bytes().as_slice().to_vec();
        assert!(read_frame::<Request, _>(&mut bytes.as_slice())
            .await
            .is_err());
        bytes.clear();
    }
    #[tokio::test]
    async fn two_authenticated_endpoints_exchange_requests_and_streams() {
        let host_handler: Handler = Arc::new(|peer, request| {
            Box::pin(
                async move { Response::result(request.id, Ok(serde_json::json!({"peer":peer}))) },
            )
        });
        let host = Node::bind_loopback(Node::generate_secret(), host_handler.clone())
            .await
            .unwrap();
        let client = Node::bind_loopback(Node::generate_secret(), host_handler)
            .await
            .unwrap();
        client.remember(&host.id(), host.address()).await.unwrap();
        let response = client
            .request(
                &host.id(),
                Request {
                    id: uuid::Uuid::new_v4(),
                    lease: None,
                    operation: Operation::Hello,
                },
            )
            .await
            .unwrap()
            .into_result()
            .unwrap();
        assert_eq!(response["peer"], client.id());
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let watch = client
            .watch(
                &host.id(),
                Request {
                    id: uuid::Uuid::new_v4(),
                    lease: None,
                    operation: Operation::Watch {
                        session_id: "s".into(),
                    },
                },
                Arc::new(move |e| {
                    let _ = sender.send(e);
                }),
            )
            .await
            .unwrap();
        host.events
            .send(RemoteEvent {
                session_id: "other".into(),
                topic: "refresh".into(),
                payload: serde_json::Value::Null,
            })
            .unwrap();
        host.events
            .send(RemoteEvent {
                session_id: "s".into(),
                topic: "refresh".into(),
                payload: serde_json::json!("scoped"),
            })
            .unwrap();
        let event = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.session_id, "s");
        watch.abort();
        client.close().await;
        host.close().await;
    }
    #[tokio::test]
    async fn guests_are_promoted_and_clients_redial_dropped_connections() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let handler: Handler = Arc::new(|peer, request| {
            Box::pin(
                async move { Response::result(request.id, Ok(serde_json::json!({"peer":peer}))) },
            )
        });
        let host = Node::bind_loopback(Node::generate_secret(), handler.clone())
            .await
            .unwrap();
        let approved = Arc::new(AtomicBool::new(false));
        let flag = approved.clone();
        host.set_trust(Arc::new(move |_| flag.load(Ordering::SeqCst)));
        let client = Node::bind_loopback(Node::generate_secret(), handler)
            .await
            .unwrap();
        client.remember(&host.id(), host.address()).await.unwrap();
        let hello = || Request {
            id: uuid::Uuid::new_v4(),
            lease: None,
            operation: Operation::Hello,
        };
        // An unpaired identity still reaches the handler, which only lets it pair.
        client.request(&host.id(), hello()).await.unwrap();
        assert_eq!(host.admission.guests.available_permits(), GUEST_CONNECTIONS - 1);
        approved.store(true, Ordering::SeqCst);
        client.request(&host.id(), hello()).await.unwrap();
        assert_eq!(host.admission.guests.available_permits(), GUEST_CONNECTIONS);
        assert_eq!(
            host.admission.trusted.available_permits(),
            TRUSTED_CONNECTIONS - 1
        );
        // Revocation closes inbound connections too; the next request redials.
        host.disconnect(&client.id()).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let response = client
            .request(&host.id(), hello())
            .await
            .unwrap()
            .into_result()
            .unwrap();
        assert_eq!(response["peer"], client.id());
        client.close().await;
        host.close().await;
    }
    #[tokio::test]
    async fn encrypted_requests_work_with_all_direct_transports_disabled() {
        use iroh_relay::server::{RelayConfig, Server, ServerConfig};
        let mut config = ServerConfig::default();
        config.relay = Some(RelayConfig::new(
            "127.0.0.1:0".parse::<std::net::SocketAddr>().unwrap(),
        ));
        let relay = Server::spawn(config).await.unwrap();
        let url: iroh::RelayUrl = format!("http://{}", relay.http_addr().unwrap())
            .parse()
            .unwrap();
        let handler: Handler = Arc::new(|peer, request| {
            Box::pin(
                async move { Response::result(request.id, Ok(serde_json::json!({"peer":peer}))) },
            )
        });
        let build = || {
            Endpoint::builder(presets::Minimal)
                .secret_key(SecretKey::generate())
                .alpns(vec![ALPN.to_vec()])
                .relay_mode(iroh::RelayMode::Custom(iroh::RelayMap::from_iter([
                    url.clone()
                ])))
                .clear_ip_transports()
        };
        let host = Node::from_endpoint(build().bind().await.unwrap(), handler.clone()).unwrap();
        let client = Node::from_endpoint(build().bind().await.unwrap(), handler).unwrap();
        client
            .remember(
                &host.id(),
                iroh::EndpointAddr::new(host.endpoint.id()).with_relay_url(url),
            )
            .await
            .unwrap();
        let result = client
            .request(
                &host.id(),
                Request {
                    id: uuid::Uuid::new_v4(),
                    lease: None,
                    operation: Operation::Hello,
                },
            )
            .await
            .unwrap()
            .into_result()
            .unwrap();
        assert_eq!(result["peer"], client.id());
        client.close().await;
        host.close().await;
        relay.shutdown().await.unwrap();
    }
}
