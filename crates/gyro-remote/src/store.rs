use anyhow::{bail, Context, Result};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use uuid::Uuid;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub name: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            name: "This Mac".into(),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub role: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invitation {
    pub version: u8,
    pub host_id: String,
    pub name: String,
    pub secret: String,
    pub expires_at: u64,
    #[serde(default)]
    pub address: Option<iroh::EndpointAddr>,
}
/// Only roots already present in this Mac's sidebar are synchronized.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SidebarProject {
    pub path: PathBuf,
    pub name: String,
}
struct PendingInvite {
    hash: Vec<u8>,
    expires: u64,
}
pub enum Receipt {
    New,
    Complete(Value),
    Failed(String),
    Uncertain,
}
pub struct Store {
    db: Mutex<Connection>,
    invitation: Mutex<Option<PendingInvite>>,
}
impl Store {
    pub fn open(dir: &Path) -> Result<Self> {
        if dir.exists() && std::fs::symlink_metadata(dir)?.file_type().is_symlink() {
            bail!("Remote data directory is a symlink");
        }
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
        let path = dir.join("remote.sqlite");
        if path.exists() && std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
            bail!("Remote database is a symlink");
        }
        let db = Connection::open(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        db.execute_batch("pragma journal_mode=WAL; pragma synchronous=FULL;
          create table if not exists settings(id integer primary key check(id=1),value text not null);
          create table if not exists peers(id text primary key,name text not null,role text not null);
          create table if not exists pending(id text primary key,name text not null,expires integer not null);
          create table if not exists projects(id text primary key,name text not null,path text not null unique);
          create table if not exists scopes(session text primary key,project text not null,path text not null);
          create table if not exists receipts(peer text not null,id text not null,hash text not null,status text not null,value text,primary key(peer,id));
          create table if not exists submitted_turns(session text not null,turn text not null,primary key(session,turn));")?;
        Ok(Self {
            db: Mutex::new(db),
            invitation: Mutex::new(None),
        })
    }
    fn db(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| anyhow::anyhow!("Remote storage unavailable"))
    }
    pub fn settings(&self) -> Result<Settings> {
        let value: Option<String> = self
            .db()?
            .query_row("select value from settings where id=1", [], |r| r.get(0))
            .optional()?;
        value
            .map(|s| serde_json::from_str(&s).map_err(Into::into))
            .unwrap_or_else(|| Ok(Settings::default()))
    }
    pub fn save_settings(&self, value: &Settings) -> Result<()> {
        if value.name.trim().is_empty()
            || value.name.chars().count() > 80
            || value.name.chars().any(char::is_control)
        {
            bail!("Use a device name between 1 and 80 characters");
        }
        self.db()?.execute(
            "insert or replace into settings values(1,?1)",
            [serde_json::to_string(value)?],
        )?;
        if value.enabled {
            self.promote_approved_clients()?;
        }
        if !value.enabled {
            self.clear_invitation()?;
            self.db()?.execute("delete from pending", [])?;
        }
        Ok(())
    }
    // Legacy inbound client records have already passed local pairing approval.
    // A host-only record may still be awaiting approval, so never promote it here.
    pub fn promote_approved_clients(&self) -> Result<()> {
        self.db()?
            .execute("update peers set role='both' where role='client'", [])?;
        Ok(())
    }
    pub fn invitation_active(&self) -> Result<bool> {
        Ok(self
            .invitation
            .lock()
            .map_err(|_| anyhow::anyhow!("Pairing unavailable"))?
            .as_ref()
            .is_some_and(|invite| invite.expires > now()))
    }
    pub fn peers(&self) -> Result<Vec<Peer>> {
        let db = self.db()?;
        let mut q = db.prepare("select id,name,role from peers order by name")?;
        let rows = q
            .query_map([], |r| {
                Ok(Peer {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    role: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
    pub fn trusts(&self, peer: &str, role: &str) -> bool {
        self.peers().is_ok_and(|ps| {
            ps.iter()
                .any(|p| p.id == peer && (p.role == role || p.role == "both"))
        })
    }
    pub fn trust(&self, peer: &Peer) -> Result<()> {
        self.db()?.execute("insert into peers values(?1,?2,?3) on conflict(id) do update set name=excluded.name,role=case when peers.role=excluded.role then peers.role else 'both' end",params![peer.id,peer.name,peer.role])?;
        Ok(())
    }
    pub fn revoke(&self, id: &str) -> Result<()> {
        let db = self.db()?;
        db.execute("delete from peers where id=?1", [id])?;
        db.execute("delete from pending where id=?1", [id])?;
        Ok(())
    }
    pub fn invite(&self, host_id: String) -> Result<Invitation> {
        let settings = self.settings()?;
        if !settings.enabled {
            bail!("Enable remote access first");
        }
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        use base64::Engine;
        let secret = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let expires = now() + 300;
        *self
            .invitation
            .lock()
            .map_err(|_| anyhow::anyhow!("Pairing unavailable"))? = Some(PendingInvite {
            hash: Sha256::digest(secret.as_bytes()).to_vec(),
            expires,
        });
        self.db()?.execute("delete from pending", [])?;
        Ok(Invitation {
            version: 1,
            host_id,
            name: settings.name,
            secret,
            expires_at: expires,
            address: None,
        })
    }
    pub fn clear_invitation(&self) -> Result<()> {
        *self
            .invitation
            .lock()
            .map_err(|_| anyhow::anyhow!("Pairing unavailable"))? = None;
        self.db()?.execute("delete from pending", [])?;
        Ok(())
    }
    pub fn request_pair(&self, id: &str, name: &str, secret: &str) -> Result<()> {
        if name.trim().is_empty()
            || name.chars().count() > 80
            || name.chars().any(char::is_control)
            || secret.len() > 128
        {
            bail!("Invalid pairing request");
        }
        let mut invitation = self
            .invitation
            .lock()
            .map_err(|_| anyhow::anyhow!("Pairing unavailable"))?;
        let valid = invitation.as_ref().is_some_and(|i| {
            i.expires > now()
                && bool::from(
                    i.hash
                        .as_slice()
                        .ct_eq(Sha256::digest(secret.as_bytes()).as_slice()),
                )
        });
        if !valid {
            bail!("Invitation is invalid, expired or already used");
        }
        let expires = invitation.as_ref().unwrap().expires;
        self.db()?.execute(
            "insert or replace into pending values(?1,?2,?3)",
            params![id, name, expires],
        )?;
        *invitation = None;
        Ok(())
    }
    pub fn pending(&self) -> Result<Vec<Peer>> {
        let db = self.db()?;
        db.execute("delete from pending where expires<=?1", [now()])?;
        let mut q = db.prepare("select id,name from pending")?;
        let rows = q
            .query_map([], |r| {
                Ok(Peer {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    role: "client".into(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
    pub fn approve(&self, id: &str) -> Result<()> {
        let peer = self
            .pending()?
            .into_iter()
            .find(|p| p.id == id)
            .context("Pairing request expired")?;
        self.trust(&Peer {
            role: "both".into(),
            ..peer
        })?;
        self.db()?
            .execute("delete from pending where id=?1", [id])?;
        Ok(())
    }
    pub fn projects(&self) -> Result<Vec<Project>> {
        let db = self.db()?;
        let mut q = db.prepare("select id,name,path from projects order by name")?;
        let rows = q
            .query_map([], |r| {
                Ok(Project {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    path: PathBuf::from(r.get::<_, String>(2)?),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
    pub fn share(&self, path: &Path) -> Result<()> {
        let root = path.canonicalize()?;
        if !root.is_dir() || root.parent().is_none() {
            bail!("Choose a project folder");
        }
        let name = root
            .file_name()
            .context("Choose a project folder")?
            .to_string_lossy()
            .to_string();
        self.db()?.execute(
            "insert or ignore into projects values(?1,?2,?3)",
            params![Uuid::new_v4().to_string(), name, root.to_string_lossy()],
        )?;
        Ok(())
    }
    pub fn sync_projects(&self, projects: &[SidebarProject]) -> Result<()> {
        if projects.len() > 1024 {
            bail!("Too many sidebar projects");
        }
        let mut roots = Vec::new();
        for project in projects {
            // A disconnected disk must not block the remaining sidebar projects.
            let Ok(root) = project.path.canonicalize() else {
                continue;
            };
            if !root.is_dir() || root.parent().is_none() {
                continue;
            }
            let name = project.name.trim();
            if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
                bail!("Use a project name between 1 and 80 characters");
            }
            roots.push((root.to_string_lossy().into_owned(), name.to_owned()));
        }
        let mut db = self.db()?;
        let tx = db.transaction()?;
        let existing = {
            let mut q = tx.prepare("select id,path from projects")?;
            let rows = q
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (id, path) in existing {
            if !roots.iter().any(|(root, _)| root == &path) {
                tx.execute("delete from projects where id=?1", [id])?;
            }
        }
        for (path, name) in roots {
            tx.execute("insert into projects values(?1,?2,?3) on conflict(path) do update set name=excluded.name",
                params![Uuid::new_v4().to_string(),name,path])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn unshare(&self, id: &str) -> Result<()> {
        self.db()?
            .execute("delete from projects where id=?1", [id])?;
        Ok(())
    }
    pub fn project(&self, id: &str) -> Result<Project> {
        self.projects()?
            .into_iter()
            .find(|p| p.id == id)
            .context("Project is no longer shared")
    }
    pub fn scope(&self, session: &str, project: &str, path: &Path) -> Result<()> {
        self.project(project)?;
        let canonical = path.canonicalize()?;
        self.db()?.execute(
            "insert or replace into scopes values(?1,?2,?3)",
            params![session, project, canonical.to_string_lossy()],
        )?;
        Ok(())
    }
    pub fn authorizes(&self, session: &str, path: &Path) -> bool {
        let Ok(path) = path.canonicalize() else {
            return false;
        };
        if self
            .projects()
            .is_ok_and(|ps| ps.iter().any(|p| path.starts_with(&p.path)))
        {
            return true;
        }
        let Ok(db) = self.db() else { return false };
        db.query_row("select scopes.path from scopes join projects on scopes.project=projects.id where session=?1",[session],|r|r.get::<_,String>(0)).optional().ok().flatten().is_some_and(|p|Path::new(&p)==path)
    }
    pub fn belongs(&self, session: &str, path: &Path, project: &Project) -> bool {
        if path
            .canonicalize()
            .is_ok_and(|p| p.starts_with(&project.path))
        {
            return true;
        }
        let Ok(db) = self.db() else { return false };
        db.query_row(
            "select path from scopes where session=?1 and project=?2",
            params![session, project.id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .is_some_and(|p| {
            path.canonicalize()
                .is_ok_and(|canonical| Path::new(&p) == canonical)
        })
    }
    pub fn begin(&self, peer: &str, id: Uuid, operation: &Value) -> Result<Receipt> {
        let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(operation)?));
        let db = self.db()?;
        let old = db
            .query_row(
                "select hash,status,value from receipts where peer=?1 and id=?2",
                params![peer, id.to_string()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some((old_hash, status, value)) = old {
            if hash != old_hash {
                bail!("Request ID was reused for another operation")
            }
            return Ok(match status.as_str() {
                "done" => Receipt::Complete(serde_json::from_str(&value.unwrap_or("null".into()))?),
                "failed" => Receipt::Failed(value.unwrap_or_default()),
                _ => Receipt::Uncertain,
            });
        }
        db.execute(
            "insert into receipts values(?1,?2,?3,'started',null)",
            params![peer, id.to_string(), hash],
        )?;
        Ok(Receipt::New)
    }
    pub fn finish(&self, peer: &str, id: Uuid, result: &Result<Value, String>) -> Result<()> {
        let (status, value) = match result {
            Ok(v) => ("done", serde_json::to_string(v)?),
            Err(e) => ("failed", e.clone()),
        };
        self.db()?.execute(
            "update receipts set status=?3,value=?4 where peer=?1 and id=?2",
            params![peer, id.to_string(), status, value],
        )?;
        Ok(())
    }
    pub fn reserve_turn(&self, session: &str, turn: &str) -> Result<()> {
        let changed = self.db()?.execute(
            "insert or ignore into submitted_turns values(?1,?2)",
            params![session, turn],
        )?;
        if changed == 0 {
            bail!("This turn was already submitted. Refresh the session.")
        }
        Ok(())
    }
    pub fn request_status(&self, peer: &str, id: Uuid) -> Result<Value> {
        let row = self
            .db()?
            .query_row(
                "select status,value from receipts where peer=?1 and id=?2",
                params![peer, id.to_string()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        Ok(match row {
            Some((status, value)) => {
                serde_json::json!({"status":status,"value":if status=="done"{value.and_then(|v|serde_json::from_str::<Value>(&v).ok())}else{None}})
            }
            None => serde_json::json!({"status":"unknown"}),
        })
    }
    pub fn reconcile_interrupted_requests(&self) -> Result<()> {
        self.db()?.execute(
            "update receipts set status='uncertain' where status='started'",
            [],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invitations_are_single_use_and_require_explicit_approval() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path()).unwrap();
        s.save_settings(&Settings {
            enabled: true,
            name: "Host".into(),
        })
        .unwrap();
        let i = s.invite("h".into()).unwrap();
        assert!(s.invitation_active().unwrap());
        assert!(s.request_pair("a", "Client", "bad").is_err());
        s.request_pair("a", "Client", &i.secret).unwrap();
        assert!(!s.invitation_active().unwrap());
        assert!(!s.trusts("a", "client"));
        assert!(s.request_pair("b", "Other", &i.secret).is_err());
        s.approve("a").unwrap();
        assert!(s.trusts("a", "client"));
        assert!(s.trusts("a", "host"));
        s.revoke("a").unwrap();
        assert!(!s.trusts("a", "client"));
    }
    #[test]
    fn sidebar_sync_preserves_ids_and_revokes_removed_roots() {
        let d = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let removed = tempfile::tempdir().unwrap();
        let tree = tempfile::tempdir().unwrap();
        let s = Store::open(d.path()).unwrap();
        s.share(removed.path()).unwrap();
        let old = s.projects().unwrap().remove(0);
        s.scope("s", &old.id, tree.path()).unwrap();
        let input = [SidebarProject {
            path: root.path().into(),
            name: "Gyro".into(),
        }];
        s.sync_projects(&input).unwrap();
        let first = s.projects().unwrap().remove(0);
        assert!(!s.authorizes("s", tree.path()));
        s.sync_projects(&[SidebarProject {
            name: "Renamed".into(),
            ..input[0].clone()
        }])
        .unwrap();
        let renamed = s.projects().unwrap().remove(0);
        assert_eq!(first.id, renamed.id);
        assert_eq!(renamed.name, "Renamed");
        assert!(s.authorizes("local", root.path()));
        assert_eq!(s.projects().unwrap().len(), 1);
        s.sync_projects(&[]).unwrap();
        assert!(!s.authorizes("local", root.path()));
    }
    #[test]
    fn legacy_migration_promotes_only_locally_approved_clients() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path()).unwrap();
        s.trust(&Peer {
            id: "approved".into(),
            name: "Approved".into(),
            role: "client".into(),
        })
        .unwrap();
        s.trust(&Peer {
            id: "awaiting".into(),
            name: "Awaiting".into(),
            role: "host".into(),
        })
        .unwrap();
        s.promote_approved_clients().unwrap();
        assert!(s.trusts("approved", "host"));
        assert!(s.trusts("approved", "client"));
        assert!(!s.trusts("awaiting", "client"));
    }
    #[test]
    fn receipts_fence_replays_and_survive_reopen() {
        let d = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let op = serde_json::json!({"op":"write"});
        {
            let s = Store::open(d.path()).unwrap();
            assert!(matches!(s.begin("p", id, &op).unwrap(), Receipt::New));
            assert!(matches!(s.begin("p", id, &op).unwrap(), Receipt::Uncertain));
            s.finish("p", id, &Ok(Value::Bool(true))).unwrap();
        }
        let s = Store::open(d.path()).unwrap();
        assert!(matches!(
            s.begin("p", id, &op).unwrap(),
            Receipt::Complete(Value::Bool(true))
        ));
        assert!(s.begin("p", id, &Value::Null).is_err());
        assert!(matches!(s.begin("other", id, &op).unwrap(), Receipt::New));
    }
    #[test]
    fn removing_share_revokes_worktree_scope() {
        let d = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let tree = tempfile::tempdir().unwrap();
        let s = Store::open(d.path()).unwrap();
        s.share(root.path()).unwrap();
        let p = s.projects().unwrap().remove(0);
        s.scope("s", &p.id, tree.path()).unwrap();
        assert!(s.authorizes("s", tree.path()));
        s.unshare(&p.id).unwrap();
        assert!(!s.authorizes("s", tree.path()));
    }
}
