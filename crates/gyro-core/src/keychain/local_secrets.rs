//! Legacy credential file and cross-process migration lock. On macOS new
//! credentials go to Keychain; a legacy entry is removed only after verification.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "secrets.json";
const LOCK_NAME: &str = "secrets.lock";
const STORE_VERSION: u32 = 1;
#[allow(dead_code)]
const MAX_ACCOUNT_BYTES: usize = 4096;
#[allow(dead_code)]
const MAX_SECRET_BYTES: usize = 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
struct Store {
    version: u32,
    entries: BTreeMap<String, String>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            entries: BTreeMap::new(),
        }
    }
}

#[allow(dead_code)]
pub(super) fn get(account: &str) -> Result<Option<String>> {
    let dir = data_dir()?;
    with_store(&dir, false, |store| Ok(store.entries.get(account).cloned()))
}

#[allow(dead_code)]
pub(super) fn set(account: &str, value: &str) -> Result<()> {
    validate(account, value)?;
    let dir = data_dir()?;
    with_store(&dir, true, |store| {
        store.entries.insert(account.to_string(), value.to_string());
        Ok(())
    })
}

#[allow(dead_code)]
pub(super) fn migrate_all(write_verified: impl Fn(&str, &str) -> Result<()>) -> Result<()> {
    let dir = data_dir()?;
    // Do not create or rewrite a legacy file on every ordinary startup/read.
    if !dir.join(FILE_NAME).exists() {
        return Ok(());
    }
    with_store(&dir, true, |store| {
        for (account, value) in &store.entries {
            write_verified(account, value)?;
        }
        store.entries.clear();
        Ok(())
    })
}

/// Resolve and insert once under the same cross-process store lock.
pub(super) fn get_or_insert_with(
    account: &str,
    create: impl FnOnce() -> Result<String>,
) -> Result<String> {
    let dir = data_dir()?;
    get_or_insert_at(&dir, account, create)
}
#[allow(dead_code)]
fn get_or_insert_at(
    dir: &Path,
    account: &str,
    create: impl FnOnce() -> Result<String>,
) -> Result<String> {
    with_store(dir, true, |store| {
        if let Some(value) = store.entries.get(account) {
            return Ok(value.clone());
        }
        let value = create()?;
        validate(account, &value)?;
        store.entries.insert(account.into(), value.clone());
        Ok(value)
    })
}

#[allow(dead_code)]
pub(super) fn delete(account: &str) -> Result<()> {
    let dir = data_dir()?;
    with_store(&dir, true, |store| {
        store.entries.remove(account);
        Ok(())
    })
}

#[allow(dead_code)]
fn data_dir() -> Result<PathBuf> {
    Ok(crate::paths::GyroPaths::for_current_user()?.base_dir)
}

#[allow(dead_code)]
pub(super) fn validate(account: &str, value: &str) -> Result<()> {
    if account.is_empty()
        || account.len() > MAX_ACCOUNT_BYTES
        || account.contains('\0')
        || value.is_empty()
        || value.len() > MAX_SECRET_BYTES
        || value.contains('\0')
    {
        bail!("invalid saved credential");
    }
    Ok(())
}

/// Keep creation, migration and deletion serialized across Gyro processes.
/// The callback must verify durable secure storage before returning success.
#[allow(dead_code)]
pub(super) fn secure_transaction<T>(
    account: &str,
    body: impl FnOnce(Option<&str>) -> Result<T>,
) -> Result<T> {
    secure_transaction_at(&data_dir()?, account, body)
}

fn secure_transaction_at<T>(
    dir: &Path,
    account: &str,
    body: impl FnOnce(Option<&str>) -> Result<T>,
) -> Result<T> {
    with_store(dir, true, |store| {
        let result = body(store.entries.get(account).map(String::as_str))?;
        store.entries.remove(account);
        Ok(result)
    })
}

fn with_store<T>(
    dir: &Path,
    write_back: bool,
    body: impl FnOnce(&mut Store) -> Result<T>,
) -> Result<T> {
    crate::paths::ensure_private_directory(dir)?;
    let lock_path = dir.join(LOCK_NAME);
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)
        .with_context(|| format!("open {}", lock_path.display()))?;
    crate::paths::secure_private_file(&lock_path)?;
    lock_exclusive(&lock)?;
    let path = dir.join(FILE_NAME);
    let mut store = read_store(&path)?;
    let previous = store.entries.clone();
    let result = body(&mut store)?;
    if write_back && store.entries != previous {
        write_store(&path, &store)?;
    }
    Ok(result)
}

fn read_store(path: &Path) -> Result<Store> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Store::default());
        }
        Err(error) => {
            return Err(error).with_context(|| format!("inspect {}", path.display()));
        }
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            bail!("saved secrets on this Mac could not be read");
        }
        Ok(_) => {}
    }
    crate::paths::secure_private_file(path)?;
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    if bytes.is_empty() {
        return Ok(Store::default());
    }
    let store: Store = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow!("saved secrets on this Mac could not be read"))?;
    if store.version != STORE_VERSION {
        bail!("saved secrets on this Mac could not be read");
    }
    Ok(store)
}

fn write_store(path: &Path, store: &Store) -> Result<()> {
    let parent = path.parent().context("secrets directory")?;
    let temporary = parent.join(format!("{FILE_NAME}.tmp"));
    let _ = fs::remove_file(&temporary);
    let mut file = create_private(&temporary)?;
    let bytes = serde_json::to_vec(store).context("encode saved secrets")?;
    file.write_all(&bytes)
        .with_context(|| format!("write {}", temporary.display()))?;
    file.sync_all()
        .with_context(|| format!("flush {}", temporary.display()))?;
    drop(file);
    fs::rename(&temporary, path).with_context(|| format!("replace {}", path.display()))?;
    crate::paths::secure_private_file(path)?;
    Ok(())
}

fn create_private(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .with_context(|| format!("create {}", path.display()))
}

fn lock_exclusive(file: &File) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            bail!("could not lock saved secrets");
        }
    }
    #[cfg(not(unix))]
    {
        let _ = file;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_migration_keeps_plaintext_until_verified_and_never_reimports_deleted_keys() {
        let dir = tempfile::tempdir().unwrap();
        get_or_insert_at(dir.path(), "key", || Ok("original".into())).unwrap();
        assert!(secure_transaction_at(dir.path(), "key", |_| -> Result<()> {
            bail!("Keychain unavailable")
        })
        .is_err());
        let mut secure = None;
        secure_transaction_at(dir.path(), "key", |plain| {
            assert_eq!(plain, Some("original"));
            secure = plain.map(str::to_owned);
            Ok(())
        })
        .unwrap();
        assert!(!fs::read_to_string(dir.path().join(FILE_NAME))
            .unwrap()
            .contains("original"));
        secure_transaction_at(dir.path(), "key", |plain| {
            assert!(plain.is_none());
            secure = None;
            Ok(())
        })
        .unwrap();
        secure_transaction_at(dir.path(), "key", |plain| {
            assert!(plain.is_none() && secure.is_none());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn identity_creation_is_atomic_and_failed_migration_does_not_replace_it() {
        let dir = tempfile::tempdir().unwrap();
        assert!(get_or_insert_at(dir.path(), "identity", || anyhow::bail!(
            "legacy key locked"
        ))
        .is_err());
        assert!(!dir.path().join(FILE_NAME).exists());
        assert_eq!(
            get_or_insert_at(dir.path(), "identity", || Ok("original".into())).unwrap(),
            "original"
        );
        assert_eq!(
            get_or_insert_at(dir.path(), "identity", || panic!("must preserve identity")).unwrap(),
            "original"
        );
    }

    #[test]
    fn saved_keys_stay_in_a_private_file_and_survive_a_second_write() {
        let dir = tempfile::tempdir().unwrap();
        with_store(dir.path(), true, |store| {
            store
                .entries
                .insert("provider:deepseek".into(), "first-secret".into());
            Ok(())
        })
        .unwrap();
        with_store(dir.path(), true, |store| {
            store
                .entries
                .insert("provider:mistral".into(), "second-secret".into());
            Ok(())
        })
        .unwrap();

        let path = dir.path().join(FILE_NAME);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(file_mode & 0o777, 0o600);
            let directory_mode = fs::metadata(dir.path()).unwrap().permissions().mode();
            assert_eq!(directory_mode & 0o777, 0o700);
        }
        let stored = with_store(dir.path(), false, |store| Ok(store.entries.clone())).unwrap();
        assert_eq!(
            stored.get("provider:deepseek").map(String::as_str),
            Some("first-secret")
        );
        assert_eq!(
            stored.get("provider:mistral").map(String::as_str),
            Some("second-secret")
        );
    }

    #[test]
    fn a_removed_key_leaves_the_others_in_place() {
        let dir = tempfile::tempdir().unwrap();
        with_store(dir.path(), true, |store| {
            store.entries.insert("keep".into(), "stay".into());
            store.entries.insert("drop".into(), "go".into());
            Ok(())
        })
        .unwrap();
        with_store(dir.path(), true, |store| {
            store.entries.remove("drop");
            Ok(())
        })
        .unwrap();
        let stored = with_store(dir.path(), false, |store| Ok(store.entries.clone())).unwrap();
        assert_eq!(stored.get("keep").map(String::as_str), Some("stay"));
        assert!(!stored.contains_key("drop"));
    }

    #[test]
    fn unreadable_or_linked_files_do_not_echo_their_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, b"secret-fixture-not-json").unwrap();
        let error = with_store(dir.path(), false, |_| Ok(())).unwrap_err();
        assert!(!error.to_string().contains("secret-fixture"));

        let linked = tempfile::tempdir().unwrap();
        let outside = linked.path().join("outside");
        fs::write(&outside, "outside-secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, linked.path().join(FILE_NAME)).unwrap();
        #[cfg(unix)]
        {
            let error = with_store(linked.path(), true, |store| {
                store.entries.insert("a".into(), "b".into());
                Ok(())
            })
            .unwrap_err();
            assert!(!error.to_string().contains("outside-secret"));
            assert_eq!(fs::read_to_string(&outside).unwrap(), "outside-secret");
        }

        let versioned = tempfile::tempdir().unwrap();
        fs::write(
            versioned.path().join(FILE_NAME),
            br#"{"version":2,"entries":{"a":"hidden-secret"}}"#,
        )
        .unwrap();
        let error = with_store(versioned.path(), false, |_| Ok(())).unwrap_err();
        assert!(!error.to_string().contains("hidden-secret"));
    }
}
