use super::stream;
use crate::{transport::Handler, RemoteEvent};
use anyhow::{bail, Context, Result};
use std::{
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    net::{UnixListener, UnixStream},
    sync::broadcast,
    task::{JoinHandle, JoinSet},
};

pub struct Server {
    task: JoinHandle<()>,
    path: PathBuf,
    inode: u64,
}
impl Server {
    pub async fn bind(
        path: &Path,
        handler: Handler,
        events: broadcast::Sender<RemoteEvent>,
        cleanup: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Result<Self> {
        let directory = path.parent().context("Missing SSH socket directory")?;
        let metadata = std::fs::symlink_metadata(directory)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.permissions().mode() & 0o077 != 0
        {
            bail!("SSH socket directory must be private");
        }
        let uid = metadata.uid();
        if let Ok(existing) = std::fs::symlink_metadata(path) {
            if !existing.file_type().is_socket() || existing.uid() != uid {
                bail!("Invalid existing SSH socket");
            }
            if UnixStream::connect(path).await.is_ok() {
                bail!("Another Gyro instance owns the SSH socket");
            }
            std::fs::remove_file(path)?;
        }
        let listener = UnixListener::bind(path).context("Could not bind SSH service socket")?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let inode = std::fs::symlink_metadata(path)?.ino();
        let task = tokio::spawn(async move {
            let mut clients = JoinSet::new();
            let active = Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
            let slots = Arc::new(tokio::sync::Semaphore::new(16));
            loop {
                tokio::select! {
                    incoming=listener.accept()=> {
                        let Ok((stream,_))=incoming else{break;};
                        // SSH logs in as this macOS account; netcat reaches this socket
                        // as that account. Never trust a client-supplied user identity.
                        if !stream.peer_cred().is_ok_and(|cred|cred.uid()==uid){continue;}
                        let Ok(permit)=slots.clone().try_acquire_owned() else{continue;};
                        let handler=handler.clone();let events=events.clone();let cleanup=cleanup.clone();let active=active.clone();
                        clients.spawn(async move {let _permit=permit;let _=stream::serve(stream,handler,events,cleanup,active).await;});
                    }
                    _=clients.join_next(), if !clients.is_empty()=>{}
                }
            }
        });
        Ok(Self {
            task,
            path: path.into(),
            inode,
        })
    }
    pub fn close(&self) {
        self.task.abort();
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.close();
        if std::fs::symlink_metadata(&self.path)
            .is_ok_and(|m| m.ino() == self.inode && m.file_type().is_socket())
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
