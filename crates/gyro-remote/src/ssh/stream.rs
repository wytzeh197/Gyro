//! Multiplexed requests and live events over an authenticated SSH byte stream.
use crate::{
    transport::{read_frame, write_frame, Handler},
    Operation, RemoteEvent, Request, Response,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{broadcast, mpsc, oneshot, Mutex},
    task::{JoinHandle, JoinSet},
};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Handshake {
    pub version: u32,
    pub client_id: Uuid,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum Frame {
    Response(Response),
    Event(RemoteEvent),
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
enum ClientFrame {
    Request(Request),
    Unwatch(Uuid),
}
type Pending = Arc<Mutex<HashMap<Uuid, oneshot::Sender<Response>>>>;

pub struct Client {
    writer: Mutex<Box<dyn AsyncWrite + Unpin + Send>>,
    pending: Pending,
    events: broadcast::Sender<RemoteEvent>,
    closed: Arc<AtomicBool>,
    reader: JoinHandle<()>,
    shutdown: tokio::sync::watch::Sender<bool>,
}
impl Client {
    pub async fn open<R, W>(mut reader: R, mut writer: W, client_id: Uuid) -> Result<Arc<Self>>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        write_frame(
            &mut writer,
            &Handshake {
                version: 1,
                client_id,
            },
        )
        .await?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(256);
        let closed = Arc::new(AtomicBool::new(false));
        let (shutdown, _) = tokio::sync::watch::channel(false);
        let shutdown_reader = shutdown.clone();
        let p = pending.clone();
        let e = events.clone();
        let c = closed.clone();
        let task = tokio::spawn(async move {
            while let Ok(frame) = read_frame::<Frame, _>(&mut reader).await {
                match frame {
                    Frame::Response(response) => {
                        if let Some(sender) = p.lock().await.remove(&response.id) {
                            let _ = sender.send(response);
                        }
                    }
                    Frame::Event(event) => {
                        let _ = e.send(event);
                    }
                }
            }
            c.store(true, Ordering::SeqCst);
            shutdown_reader.send_replace(true);
            p.lock().await.clear();
            let _ = e.send(RemoteEvent {
                session_id: String::new(),
                topic: "resync".into(),
                payload: serde_json::json!({"streamClosed":true}),
            });
        });
        Ok(Arc::new(Self {
            writer: Mutex::new(Box::new(writer)),
            pending,
            events,
            closed,
            reader: task,
            shutdown,
        }))
    }
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.shutdown.send_replace(true);
        let _ = self.events.send(RemoteEvent {
            session_id: String::new(),
            topic: "resync".into(),
            payload: serde_json::json!({"streamClosed":true}),
        });
        self.reader.abort();
    }
    pub async fn request(&self, request: Request) -> Result<Response> {
        if self.is_closed() {
            bail!("SSH connection closed. Reconnect to the host.");
        }
        let mut shutdown = self.shutdown.subscribe();
        let id = request.id;
        let (send, receive) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if pending.len() >= 16 {
                bail!("Too many simultaneous SSH requests");
            }
            if pending.contains_key(&id) {
                bail!("This request is already in flight");
            }
            pending.insert(id, send);
        }
        let result = tokio::time::timeout(Duration::from_secs(90), async {
            tokio::select! {
                _ = shutdown.wait_for(|closed| *closed) => bail!("SSH connection closed; refresh before retrying an action"),
                result = async {
                    write_frame(&mut *self.writer.lock().await, &ClientFrame::Request(request)).await?;
                    receive.await.context("SSH connection closed; refresh before retrying an action")
                } => result,
            }
        })
        .await
        .context("SSH request timed out; its outcome may be uncertain. Refresh before retrying.")
        .and_then(|r| r);
        self.pending.lock().await.remove(&id);
        if result.is_err() {
            self.close();
        }
        result
    }
    pub async fn watch(
        self: &Arc<Self>,
        request: Request,
        callback: Arc<dyn Fn(RemoteEvent) + Send + Sync>,
    ) -> Result<JoinHandle<()>> {
        let session = request
            .operation
            .session_id()
            .context("Missing watch session")?
            .to_string();
        let mut events = self.events.subscribe();
        let watch_id = request.id;
        self.request(request)
            .await?
            .into_result()
            .map_err(anyhow::Error::msg)?;
        struct Unwatch(std::sync::Weak<Client>, Uuid);
        impl Drop for Unwatch {
            fn drop(&mut self) {
                if let Some(client) = self.0.upgrade() {
                    let id = self.1;
                    if let Ok(handle) = tokio::runtime::Handle::try_current() {
                        handle.spawn(async move {
                            let _ = client.unwatch(id).await;
                        });
                    }
                }
            }
        }
        let guard = Unwatch(Arc::downgrade(self), watch_id);
        Ok(tokio::spawn(async move {
            let _guard = guard;
            loop {
                match events.recv().await {
                    Ok(event)
                        if event.session_id == session
                            || (event.session_id.is_empty()
                                && event.topic == "resync"
                                && event.payload.get("streamClosed").and_then(|v| v.as_bool())
                                    == Some(true)) =>
                    {
                        let closed = event.topic == "resync"
                            && event.payload.get("streamClosed").and_then(|v| v.as_bool())
                                == Some(true);
                        callback(RemoteEvent {
                            session_id: session.clone(),
                            ..event
                        });
                        if closed {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => callback(RemoteEvent {
                        session_id: session.clone(),
                        topic: "resync".into(),
                        payload: serde_json::Value::Null,
                    }),
                    Err(_) => break,
                }
            }
        }))
    }
    async fn unwatch(&self, id: Uuid) -> Result<()> {
        if self.is_closed() {
            return Ok(());
        }
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            write_frame(&mut *self.writer.lock().await, &ClientFrame::Unwatch(id)).await
        })
        .await;
        match result {
            Ok(Ok(())) => Ok(()),
            _ => {
                self.close();
                bail!("SSH watch cancellation failed")
            }
        }
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.close();
    }
}

/// The caller must authenticate the local Unix peer before entering this protocol.
pub async fn serve<S>(
    stream: S,
    handler: Handler,
    events: broadcast::Sender<RemoteEvent>,
    cleanup: Arc<dyn Fn(&str) + Send + Sync>,
    active: Arc<std::sync::Mutex<HashMap<String, usize>>>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let handshake: Handshake =
        tokio::time::timeout(Duration::from_secs(10), read_frame(&mut reader)).await??;
    if handshake.version != 1 {
        bail!("Unsupported SSH protocol version");
    }
    // This namespace can never be an Iroh identity. Only this authenticated
    // same-user Unix socket may supply it to the normal host operation handler.
    let peer = format!("ssh:{}", handshake.client_id);
    *active
        .lock()
        .map_err(|_| anyhow::anyhow!("SSH admission unavailable"))?
        .entry(peer.clone())
        .or_default() += 1;
    struct Cleanup(
        String,
        Arc<dyn Fn(&str) + Send + Sync>,
        Arc<std::sync::Mutex<HashMap<String, usize>>>,
    );
    impl Drop for Cleanup {
        fn drop(&mut self) {
            if let Ok(mut active) = self.2.lock() {
                if let Some(count) = active.get_mut(&self.0) {
                    *count -= 1;
                    if *count > 0 {
                        return;
                    }
                }
                active.remove(&self.0);
                (self.1)(&self.0);
            }
        }
    }
    let _cleanup = Cleanup(peer.clone(), cleanup, active);
    let (out, mut outgoing) = mpsc::channel::<Frame>(32);
    let watched = Arc::new(Mutex::new(None::<Request>));
    let mut tasks = JoinSet::new();
    tasks.spawn(async move {
        while let Some(frame) = outgoing.recv().await {
            write_frame(&mut writer, &frame).await?;
        }
        Ok::<_, anyhow::Error>(())
    });
    let watch = watched.clone();
    let watch_out = out.clone();
    let watch_handler = handler.clone();
    let watch_peer = peer.clone();
    let mut receiver = events.subscribe();
    tasks.spawn(async move {
        loop {
            let event = receiver.recv().await;
            let mut watch = watch.lock().await;
            let Some(request) = watch.as_ref() else { continue; };
            let session = request.operation.session_id().unwrap_or_default();
            let relevant = match &event { Ok(e) => e.session_id == session || e.topic == "revoked", Err(_) => true };
            if !relevant { continue; }
            let revoked = matches!(&event, Ok(e) if e.topic == "scopeRevoked" || (e.topic == "revoked" && e.payload.as_str() == Some(&watch_peer)));
            if revoked || watch_handler(watch_peer.clone(), request.clone()).await.error.is_some() {
                watch_out.send(Frame::Event(RemoteEvent { session_id:session.into(), topic:"resync".into(), payload:serde_json::json!({"streamClosed":true}) })).await?;
                *watch = None; continue;
            }
            match event {
                Ok(e) if e.session_id == session => watch_out.send(Frame::Event(e)).await?,
                Ok(_) => {},
                Err(broadcast::error::RecvError::Lagged(_)) => watch_out.send(Frame::Event(RemoteEvent { session_id:session.into(), topic:"resync".into(), payload:serde_json::Value::Null })).await?,
                Err(_) => break,
            }
        }
        Ok::<_, anyhow::Error>(())
    });
    let limits = Arc::new(tokio::sync::Semaphore::new(16));
    let work = async {
        loop {
            let frame: ClientFrame = tokio::select! {
                request = read_frame(&mut reader) => request?,
                completed = tasks.join_next(), if !tasks.is_empty() => { if let Some(result) = completed { result??; } continue; }
            };
            let request = match frame {
                ClientFrame::Request(request) => request,
                ClientFrame::Unwatch(id) => {
                    let mut current = watched.lock().await;
                    if current.as_ref().is_some_and(|r| r.id == id) {
                        *current = None;
                    }
                    continue;
                }
            };
            let Ok(permit) = limits.clone().try_acquire_owned() else {
                out.send(Frame::Response(Response::result(
                    request.id,
                    Err("Host is busy; try again".into()),
                )))
                .await?;
                continue;
            };
            // Register watches before their acknowledgement, so events cannot fall
            // into a subscription gap. Handler admission still gates delivery.
            if matches!(request.operation, Operation::Watch { .. }) {
                *watched.lock().await = Some(request.clone());
            }
            let handler = handler.clone();
            let peer = peer.clone();
            let out = out.clone();
            tasks.spawn(async move {
                let _permit = permit;
                let response = handler(peer, request).await;
                let id = response.id;
                let frame = Frame::Response(response);
                if serde_json::to_vec(&frame)?.len() > crate::protocol::MAX_FRAME {
                    out.send(Frame::Response(Response::result(id, Err("Remote response exceeds its size limit. Open a smaller history page or file.".into())))).await?;
                } else { out.send(frame).await?; }
                Ok::<_, anyhow::Error>(())
            });
            // Reap completed work so a long-lived SSH session stays bounded.
            while let Some(result) = tasks.try_join_next() {
                result??;
            }
        }
        #[allow(unreachable_code)]
        Ok::<_, anyhow::Error>(())
    };
    work.await
}
