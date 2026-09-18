//! Exact untracked text line counts with bounded memory and metadata caching.
use std::{
    collections::HashMap,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard, OnceLock,
    },
    time::SystemTime,
};

/// Entries the cache holds before it evicts. A source-control refresh over a
/// repo with more untracked files than this used to clear the whole map, so the
/// next refresh re-read every file from disk; eviction now keeps the recently
/// used half instead.
const CACHE_CAPACITY: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Fingerprint {
    len: u64,
    modified: SystemTime,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}
fn fingerprint(metadata: &fs::Metadata) -> io::Result<Fingerprint> {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(Fingerprint {
        len: metadata.len(),
        modified: metadata.modified()?,
        #[cfg(unix)]
        identity: (
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        ),
    })
}
struct Entry {
    fingerprint: Fingerprint,
    lines: usize,
    /// Monotonic stamp of the last hit, used to pick eviction victims.
    used: u64,
}

static CACHE: OnceLock<Mutex<HashMap<PathBuf, Entry>>> = OnceLock::new();
static CLOCK: AtomicU64 = AtomicU64::new(0);

/// A panic in one caller must not turn every later line count into a panic of
/// its own, and a stale count is already impossible here because each entry is
/// revalidated against the file fingerprint before it is trusted.
fn cache() -> MutexGuard<'static, HashMap<PathBuf, Entry>> {
    CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn untracked_lines(path: &Path) -> io::Result<usize> {
    let metadata = fs::symlink_metadata(path)?;
    // Git stores a symlink's target as its content; do not follow it outside the repo.
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(path)?;
        let bytes = target.as_os_str().as_encoded_bytes();
        return Ok(bytes.iter().filter(|b| **b == b'\n').count()
            + usize::from(!bytes.is_empty() && bytes.last() != Some(&b'\n')));
    }
    if !metadata.is_file() {
        return Err(io::Error::other("Not a regular file"));
    }
    let before = fingerprint(&metadata)?;
    if let Some(entry) = cache().get_mut(path) {
        if entry.fingerprint == before {
            entry.used = CLOCK.fetch_add(1, Ordering::Relaxed);
            return Ok(entry.lines);
        }
    }
    let mut file = fs::File::open(path)?;
    // Match Git's normal binary heuristic: NUL in the first 8000 bytes.
    let mut prefix = Vec::with_capacity(8000);
    file.by_ref().take(8000).read_to_end(&mut prefix)?;
    let count = if prefix.contains(&0) {
        0
    } else {
        let mut lines = prefix.iter().filter(|b| **b == b'\n').count();
        let mut last = prefix.last().copied();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            lines += buffer[..read].iter().filter(|b| **b == b'\n').count();
            last = Some(buffer[read - 1]);
        }
        lines + usize::from(last.is_some() && last != Some(b'\n'))
    };
    if before != fingerprint(&fs::symlink_metadata(path)?)? {
        return Err(io::Error::other("File changed while counting"));
    }
    let used = CLOCK.fetch_add(1, Ordering::Relaxed);
    let mut entries = cache();
    if entries.len() >= CACHE_CAPACITY && !entries.contains_key(path) {
        let mut stamps: Vec<u64> = entries.values().map(|entry| entry.used).collect();
        let midpoint = stamps.len() / 2;
        let (_, cutoff, _) = stamps.select_nth_unstable(midpoint);
        let cutoff = *cutoff;
        entries.retain(|_, entry| entry.used >= cutoff);
    }
    entries.insert(
        path.to_path_buf(),
        Entry {
            fingerprint: before,
            lines: count,
            used,
        },
    );
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_counts_stream_large_files_and_invalidate_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.txt");
        fs::write(&path, "a\n".repeat(9 * 1024 * 1024)).unwrap();
        assert_eq!(untracked_lines(&path).unwrap(), 9 * 1024 * 1024);
        assert_eq!(untracked_lines(&path).unwrap(), 9 * 1024 * 1024);
        fs::write(&path, "one\ntwo").unwrap();
        assert_eq!(untracked_lines(&path).unwrap(), 2);
        fs::write(&path, "one\n\0two").unwrap();
        assert_eq!(untracked_lines(&path).unwrap(), 0);
        fs::write(&path, "").unwrap();
        assert_eq!(untracked_lines(&path).unwrap(), 0);
    }

    #[test]
    fn eviction_keeps_the_recently_used_half() {
        // Repos with more untracked files than the cache holds used to clear the
        // whole map, so the next source-control refresh re-read every file from
        // disk. Eviction must retain the hot set instead.
        cache().clear();
        let dir = tempfile::tempdir().unwrap();
        let hot = dir.path().join("hot.txt");
        fs::write(&hot, "one\ntwo\n").unwrap();
        assert_eq!(untracked_lines(&hot).unwrap(), 2);

        for index in 0..CACHE_CAPACITY {
            let path = dir.path().join(format!("cold-{index}.txt"));
            fs::write(&path, "x\n").unwrap();
            assert_eq!(untracked_lines(&path).unwrap(), 1);
            // Keep the hot entry the most recently used one throughout.
            assert_eq!(untracked_lines(&hot).unwrap(), 2);
        }

        let entries = cache();
        assert!(
            entries.len() <= CACHE_CAPACITY,
            "cache grew past its capacity: {}",
            entries.len()
        );
        assert!(
            entries.len() > CACHE_CAPACITY / 4,
            "eviction cleared too much, leaving {} entries",
            entries.len()
        );
        assert!(
            entries.contains_key(&hot),
            "the most recently used entry was evicted"
        );
    }
}
