//! Persistent local upload intent. No reusable credentials or service authority are stored.
use super::Error;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub struct LocalState {
    path: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub request_id: Uuid,
    pub object_id: Uuid,
    pub account_id: Uuid,
    pub kind: String,
    #[serde(default)]
    pub filename: Option<String>,
    pub base_revision_id: Option<Uuid>,
    pub upload_id: Option<Uuid>,
    pub next_chunk: u32,
    pub payload: Vec<u8>,
}
impl LocalState {
    pub fn production() -> Result<Self, Error> {
        Self::for_namespace("cloud-production-v2")
    }
    pub(super) fn for_namespace(namespace: &str) -> Result<Self, Error> {
        if namespace != "cloud-production-v2"
            && !namespace
                .strip_prefix("cloud-staging-v2/")
                .is_some_and(|scope| {
                    scope.len() == 64 && scope.bytes().all(|c| c.is_ascii_hexdigit())
                })
        {
            return Err(Error::Input);
        }
        let p = crate::paths::GyroPaths::for_current_user().map_err(|_| Error::Storage)?;
        Ok(Self {
            path: p.base_dir.join(namespace).join("outbox.sqlite3"),
        })
    }
    pub fn at(path: PathBuf) -> Self {
        Self { path }
    }
    fn open(&self) -> Result<Connection, Error> {
        let parent = self.path.parent().ok_or(Error::Storage)?;
        crate::paths::ensure_private_directory(parent).map_err(|_| Error::Storage)?;
        crate::paths::reject_unsafe_private_file(&self.path).map_err(|_| Error::Storage)?;
        let c = Connection::open(&self.path).map_err(|_| Error::Storage)?;
        crate::paths::secure_private_file(&self.path).map_err(|_| Error::Storage)?;
        c.busy_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| Error::Storage)?;
        c.execute_batch("PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS local_preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cloud_outbox(request_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,record BLOB NOT NULL); CREATE TABLE IF NOT EXISTS cloud_local_mapping(source_key TEXT PRIMARY KEY,object_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cloud_object_cache(account_id TEXT NOT NULL,object_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(account_id,object_id)); CREATE TABLE IF NOT EXISTS cloud_heads(account_id TEXT NOT NULL,object_id TEXT NOT NULL,revision_id TEXT NOT NULL,PRIMARY KEY(account_id,object_id));").map_err(|_|Error::Storage)?;
        Ok(c)
    }
    pub fn device_id(&self) -> Result<Uuid, Error> {
        let c = self.open()?;
        let raw: Option<String> = c
            .query_row(
                "SELECT value FROM local_preferences WHERE key='device-id'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| Error::Storage)?;
        if let Some(v) = raw {
            return Uuid::parse_str(&v).map_err(|_| Error::Storage);
        }
        let id = Uuid::new_v4();
        c.execute(
            "INSERT OR IGNORE INTO local_preferences(key,value) VALUES('device-id',?1)",
            [id.to_string()],
        )
        .map_err(|_| Error::Storage)?;
        let value: String = c
            .query_row(
                "SELECT value FROM local_preferences WHERE key='device-id'",
                [],
                |r| r.get(0),
            )
            .map_err(|_| Error::Storage)?;
        Uuid::parse_str(&value).map_err(|_| Error::Storage)
    }
    pub fn object_for_local(&self, source: &str) -> Result<Uuid, Error> {
        let c = self.open()?;
        let id = Uuid::new_v4();
        c.execute(
            "INSERT OR IGNORE INTO cloud_local_mapping(source_key,object_id) VALUES(?1,?2)",
            params![source, id.to_string()],
        )
        .map_err(|_| Error::Storage)?;
        let raw: String = c
            .query_row(
                "SELECT object_id FROM cloud_local_mapping WHERE source_key=?1",
                [source],
                |r| r.get(0),
            )
            .map_err(|_| Error::Storage)?;
        Uuid::parse_str(&raw).map_err(|_| Error::Storage)
    }
    pub fn put(&self, pending: &Pending) -> Result<(), Error> {
        if pending.payload.len() > 50 * 1024 * 1024 {
            return Err(Error::Limited);
        }
        let c = self.open()?;
        let bytes = serde_json::to_vec(pending).map_err(|_| Error::Input)?;
        c.execute("INSERT INTO cloud_outbox(request_id,account_id,record) VALUES(?1,?2,?3) ON CONFLICT(request_id) DO UPDATE SET record=excluded.record WHERE cloud_outbox.account_id=excluded.account_id",params![pending.request_id.to_string(),pending.account_id.to_string(),bytes]).map_err(|_|Error::Storage)?;
        Ok(())
    }
    pub fn list(&self, account: Uuid) -> Result<Vec<Pending>, Error> {
        let c = self.open()?;
        let mut stmt = c
            .prepare(
                "SELECT record FROM cloud_outbox WHERE account_id=?1 ORDER BY request_id LIMIT 100",
            )
            .map_err(|_| Error::Storage)?;
        let rows = stmt
            .query_map([account.to_string()], |r| r.get::<_, Vec<u8>>(0))
            .map_err(|_| Error::Storage)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(
                serde_json::from_slice(&row.map_err(|_| Error::Storage)?)
                    .map_err(|_| Error::Storage)?,
            );
        }
        Ok(out)
    }
    pub fn remove(&self, account: Uuid, request: Uuid) -> Result<(), Error> {
        self.open()?
            .execute(
                "DELETE FROM cloud_outbox WHERE request_id=?1 AND account_id=?2",
                params![request.to_string(), account.to_string()],
            )
            .map_err(|_| Error::Storage)?;
        Ok(())
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn remember_job(&self, account: Uuid, key: Uuid) -> Result<(), Error> {
        self.open()?.execute("INSERT INTO local_preferences(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("job:{account}"),key.to_string()]).map_err(|_|Error::Storage)?;
        Ok(())
    }
    pub fn claim_daily_memory(&self, account: Uuid, project: Uuid) -> Result<bool, Error> {
        let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let changed=self.open()?.execute("INSERT INTO local_preferences(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE local_preferences.value<>excluded.value",params![format!("memory-day:{account}:{project}"),date]).map_err(|_|Error::Storage)?;
        Ok(changed == 1)
    }
    pub fn last_job(&self, account: Uuid) -> Result<Option<Uuid>, Error> {
        let value: Option<String> = self
            .open()?
            .query_row(
                "SELECT value FROM local_preferences WHERE key=?1",
                [format!("job:{account}")],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| Error::Storage)?;
        value
            .map(|v| Uuid::parse_str(&v).map_err(|_| Error::Storage))
            .transpose()
    }
    pub fn cursor(&self, account: Uuid) -> Result<String, Error> {
        self.open()?
            .query_row(
                "SELECT value FROM local_preferences WHERE key=?1",
                [format!("changes:{account}")],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| Error::Storage)
            .map(|v| v.unwrap_or_else(|| "0".into()))
    }
    pub fn head(&self, account: Uuid, object: Uuid) -> Result<Option<Uuid>, Error> {
        let raw: Option<String> = self
            .open()?
            .query_row(
                "SELECT revision_id FROM cloud_heads WHERE account_id=?1 AND object_id=?2",
                params![account.to_string(), object.to_string()],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| Error::Storage)?;
        raw.map(|v| Uuid::parse_str(&v).map_err(|_| Error::Storage))
            .transpose()
    }
    pub fn record_head(&self, account: Uuid, object: Uuid, revision: Uuid) -> Result<(), Error> {
        self.open()?.execute("INSERT INTO cloud_heads(account_id,object_id,revision_id) VALUES(?1,?2,?3) ON CONFLICT(account_id,object_id) DO UPDATE SET revision_id=excluded.revision_id",params![account.to_string(),object.to_string(),revision.to_string()]).map_err(|_|Error::Storage)?;
        Ok(())
    }
    pub fn apply_changes(&self, account: Uuid, response: &serde_json::Value) -> Result<(), Error> {
        let mut c = self.open()?;
        let tx = c.transaction().map_err(|_| Error::Storage)?;
        let items = response["items"].as_array().ok_or(Error::Protocol)?;
        for item in items {
            let object = item["objectId"]
                .as_str()
                .and_then(|s| Uuid::parse_str(s).ok())
                .ok_or(Error::Protocol)?;
            if !item["deletedAt"].is_null() {
                tx.execute(
                    "DELETE FROM cloud_object_cache WHERE account_id=?1 AND object_id=?2",
                    params![account.to_string(), object.to_string()],
                )
                .map_err(|_| Error::Storage)?;
            } else {
                tx.execute("INSERT INTO cloud_object_cache(account_id,object_id,record) VALUES(?1,?2,?3) ON CONFLICT(account_id,object_id) DO UPDATE SET record=excluded.record",params![account.to_string(),object.to_string(),item.to_string()]).map_err(|_|Error::Storage)?;
                if let Some(head) = item["headRevisionId"].as_str() {
                    Uuid::parse_str(head).map_err(|_| Error::Protocol)?;
                    tx.execute("INSERT INTO cloud_heads(account_id,object_id,revision_id) VALUES(?1,?2,?3) ON CONFLICT(account_id,object_id) DO UPDATE SET revision_id=excluded.revision_id",params![account.to_string(),object.to_string(),head]).map_err(|_|Error::Storage)?;
                }
            }
        }
        let cursor = response["changeCursor"].as_str().ok_or(Error::Protocol)?;
        if cursor.is_empty() || cursor.len() > 24 || !cursor.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Error::Protocol);
        }
        tx.execute("INSERT INTO local_preferences(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("changes:{account}"),cursor]).map_err(|_|Error::Storage)?;
        tx.commit().map_err(|_| Error::Storage)
    }
    pub fn cached_objects(&self, account: Uuid) -> Result<Vec<serde_json::Value>, Error> {
        let c = self.open()?;
        let mut stmt=c.prepare("SELECT record FROM cloud_object_cache WHERE account_id=?1 ORDER BY object_id LIMIT 10000").map_err(|_|Error::Storage)?;
        let rows = stmt
            .query_map([account.to_string()], |r| r.get::<_, String>(0))
            .map_err(|_| Error::Storage)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(
                serde_json::from_str(&r.map_err(|_| Error::Storage)?)
                    .map_err(|_| Error::Storage)?,
            );
        }
        Ok(out)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delta_tombstones_and_cursors_survive_restart_without_cross_account_state() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("cloud/outbox.sqlite3");
        let a = LocalState::at(path.clone());
        let account = Uuid::new_v4();
        let object = Uuid::new_v4();
        let revision = Uuid::new_v4();
        a.apply_changes(account,&serde_json::json!({"items":[{"objectId":object,"headRevisionId":revision,"deletedAt":null,"kind":"chat"}],"changeCursor":"1"})).unwrap();
        let b = LocalState::at(path);
        assert_eq!(b.cached_objects(account).unwrap().len(), 1);
        assert_eq!(b.cursor(account).unwrap(), "1");
        assert_eq!(b.cursor(Uuid::new_v4()).unwrap(), "0");
        b.apply_changes(account,&serde_json::json!({"items":[{"objectId":object,"deletedAt":"2026-11-02T12:00:00Z"}],"changeCursor":"2"})).unwrap();
        assert!(b.cached_objects(account).unwrap().is_empty());
        assert_eq!(b.cursor(account).unwrap(), "2");
    }
    #[test]
    fn device_and_outbox_survive_restart_without_cross_account_upload() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("cloud/outbox.sqlite3");
        let a = LocalState::at(path.clone());
        let device = a.device_id().unwrap();
        let account = Uuid::new_v4();
        let p = Pending {
            request_id: Uuid::new_v4(),
            object_id: Uuid::new_v4(),
            account_id: account,
            kind: "chat".into(),
            filename: None,
            base_revision_id: None,
            upload_id: None,
            next_chunk: 0,
            payload: b"selected content".to_vec(),
        };
        a.put(&p).unwrap();
        let b = LocalState::at(path);
        assert_eq!(b.device_id().unwrap(), device);
        assert_eq!(b.list(account).unwrap().len(), 1);
        assert!(b.list(Uuid::new_v4()).unwrap().is_empty());
        b.remove(Uuid::new_v4(), p.request_id).unwrap();
        assert_eq!(b.list(account).unwrap().len(), 1);
        b.remove(account, p.request_id).unwrap();
        assert!(b.list(account).unwrap().is_empty());
    }
}
