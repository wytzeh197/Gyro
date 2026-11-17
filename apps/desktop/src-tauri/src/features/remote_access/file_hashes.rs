//! Reuse hashes only for the same file identity and nanosecond change metadata.
//! Every mutation still requests a fresh Git status and metadata validation.
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Version {
    len: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}
impl Version {
    pub(super) fn of(meta: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            len: meta.len(),
            modified: meta.modified().ok(),
            #[cfg(unix)]
            identity: (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec()),
        }
    }
}
type Cache = HashMap<PathBuf, (Version, [u8; 32])>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
pub(super) fn digest(path: &Path) -> Result<[u8; 32], String> {
    digest_with(path, CACHE.get_or_init(Default::default)).map(|(hash, _)| hash)
}
fn digest_with(path: &Path, cache: &Mutex<Cache>) -> Result<([u8; 32], bool), String> {
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return Err("File changed while reading Git status".into());
    }
    let version = Version::of(&metadata);
    if let Some((old, hash)) = cache
        .lock()
        .map_err(|_| "Hash cache unavailable")?
        .get(path)
    {
        if old == &version {
            return Ok((*hash, false));
        }
    }
    let mut bytes = Vec::new();
    (&file)
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 4 * 1024 * 1024
        || Version::of(&file.metadata().map_err(|e| e.to_string())?) != version
    {
        return Err("File changed while reading Git status. Refresh before acting.".into());
    }
    let hash: [u8; 32] = Sha256::digest(&bytes).into();
    let mut entries = cache.lock().map_err(|_| "Hash cache unavailable")?;
    if entries.len() >= 4096 {
        entries.clear();
    }
    entries.insert(path.to_owned(), (version, hash));
    Ok((hash, true))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unchanged_files_hit_cache_but_same_size_edits_with_restored_mtime_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, "aaa").unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let cache = Mutex::new(Cache::new());
        let first = digest_with(&path, &cache).unwrap();
        assert!(first.1);
        assert!(!digest_with(&path, &cache).unwrap().1);
        std::fs::write(&path, "bbb").unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let second = digest_with(&path, &cache).unwrap();
        assert!(second.1);
        assert_ne!(first.0, second.0);
        std::fs::remove_file(&path).unwrap();
        assert!(digest_with(&path, &cache).is_err());
    }
}
