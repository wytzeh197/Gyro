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
    time::{Instant, SystemTime},
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

#[cfg(test)]
pub fn untracked_lines(path: &Path) -> io::Result<usize> {
    count_untracked_lines(path, None)
}

/// Stream with bounded memory, stopping between reads when the shared status
/// deadline expires. File size and file count alone do not make totals partial.
pub fn untracked_lines_before(path: &Path, deadline: Instant) -> io::Result<usize> {
    count_untracked_lines(path, Some(deadline))
}

fn check_deadline(deadline: Option<Instant>) -> io::Result<()> {
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Line count deadline expired",
        ));
    }
    Ok(())
}

fn count_untracked_lines(path: &Path, deadline: Option<Instant>) -> io::Result<usize> {
    check_deadline(deadline)?;
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
            check_deadline(deadline)?;
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            lines += buffer[..read].iter().filter(|b| **b == b'\n').count();
            last = Some(buffer[read - 1]);
        }
        lines + usize::from(last.is_some() && last != Some(b'\n'))
    };
    check_deadline(deadline)?;
    if before != fingerprint(&fs::symlink_metadata(path)?)? {
        return Err(io::Error::other("File changed while counting"));
    }
    let used = CLOCK.fetch_add(1, Ordering::Relaxed);
    let mut entries = cache();
    if !entries.contains_key(path) {
        evict_cold_half(&mut entries, |entry| entry.used);
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

fn evict_cold_half<V>(entries: &mut HashMap<PathBuf, V>, used: impl Fn(&V) -> u64) {
    if entries.len() < CACHE_CAPACITY {
        return;
    }
    let mut stamps: Vec<u64> = entries.values().map(&used).collect();
    let midpoint = stamps.len() / 2;
    let (_, cutoff, _) = stamps.select_nth_unstable(midpoint);
    let cutoff = *cutoff;
    entries.retain(|_, entry| used(entry) >= cutoff);
}

/// The file a Finder or iCloud conflict copy was made from: `name 2.ext`
/// sits next to `name.ext`, `Makefile 3` next to `Makefile`.
fn sync_duplicate_original(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    };
    let (base, copy) = stem.rsplit_once(' ')?;
    if base.is_empty() || copy.is_empty() || !copy.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(path.with_file_name(format!("{base}{extension}")))
}

struct DuplicateEntry {
    fingerprints: (Fingerprint, Fingerprint),
    duplicate: bool,
    used: u64,
}

static DUPLICATES: OnceLock<Mutex<HashMap<PathBuf, DuplicateEntry>>> = OnceLock::new();

fn duplicates() -> MutexGuard<'static, HashMap<PathBuf, DuplicateEntry>> {
    DUPLICATES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether an untracked file is a byte-identical Finder or iCloud conflict
/// copy of its neighbour. Syncing a repository through iCloud can duplicate
/// thousands of files at once; counting those copies as new lines inflated the
/// totals by hundreds of thousands, by a different amount on every refresh as
/// the deadline cut the count short.
pub fn is_sync_duplicate_before(path: &Path, deadline: Instant) -> io::Result<bool> {
    let Some(original) = sync_duplicate_original(path) else {
        return Ok(false);
    };
    let copy_metadata = fs::symlink_metadata(path)?;
    let Ok(original_metadata) = fs::symlink_metadata(&original) else {
        return Ok(false);
    };
    if !copy_metadata.is_file()
        || !original_metadata.is_file()
        || copy_metadata.len() != original_metadata.len()
    {
        return Ok(false);
    }
    let fingerprints = (
        fingerprint(&copy_metadata)?,
        fingerprint(&original_metadata)?,
    );
    if let Some(entry) = duplicates().get_mut(path) {
        if entry.fingerprints == fingerprints {
            entry.used = CLOCK.fetch_add(1, Ordering::Relaxed);
            return Ok(entry.duplicate);
        }
    }
    let duplicate = same_contents(path, &original, Some(deadline))?;
    if fingerprints
        != (
            fingerprint(&fs::symlink_metadata(path)?)?,
            fingerprint(&fs::symlink_metadata(&original)?)?,
        )
    {
        return Err(io::Error::other("File changed while comparing"));
    }
    let used = CLOCK.fetch_add(1, Ordering::Relaxed);
    let mut entries = duplicates();
    if !entries.contains_key(path) {
        evict_cold_half(&mut entries, |entry| entry.used);
    }
    entries.insert(
        path.to_path_buf(),
        DuplicateEntry {
            fingerprints,
            duplicate,
            used,
        },
    );
    Ok(duplicate)
}

fn same_contents(left: &Path, right: &Path, deadline: Option<Instant>) -> io::Result<bool> {
    let mut left = fs::File::open(left)?;
    let mut right = fs::File::open(right)?;
    let mut left_buffer = [0u8; 64 * 1024];
    let mut right_buffer = [0u8; 64 * 1024];
    loop {
        check_deadline(deadline)?;
        let read = left.read(&mut left_buffer)?;
        if read == 0 {
            return Ok(right.read(&mut right_buffer[..1])? == 0);
        }
        if right.read_exact(&mut right_buffer[..read]).is_err()
            || left_buffer[..read] != right_buffer[..read]
        {
            return Ok(false);
        }
    }
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
    fn expired_deadline_does_not_publish_or_reuse_a_count() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.txt");
        fs::write(&path, "one\n").unwrap();
        assert_eq!(untracked_lines(&path).unwrap(), 1);
        let error = untracked_lines_before(&path, Instant::now()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn identical_conflict_copies_are_sync_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        let write = |name: &str, contents: &str| {
            let path = dir.path().join(name);
            fs::write(&path, contents).unwrap();
            path
        };
        write("main.rs", "fn main() {}\n");
        write("Makefile", "all:\n");
        write(".gitignore", "target\n");
        write("schema.test.json", "{}\n");
        let copy = write("main 2.rs", "fn main() {}\n");
        assert!(is_sync_duplicate_before(&copy, deadline).unwrap());
        assert!(is_sync_duplicate_before(&write("Makefile 3", "all:\n"), deadline).unwrap());
        assert!(is_sync_duplicate_before(&write(".gitignore 2", "target\n"), deadline).unwrap());
        assert!(is_sync_duplicate_before(&write("schema.test 2.json", "{}\n"), deadline).unwrap());
        // Same size, different bytes: an edited copy is real new work.
        fs::write(&copy, "fn main() {]\n").unwrap();
        assert!(!is_sync_duplicate_before(&copy, deadline).unwrap());
        assert!(
            !is_sync_duplicate_before(&write("lib 2.rs", "pub fn x() {}\n"), deadline).unwrap()
        );
        assert!(
            !is_sync_duplicate_before(&write("main v2.rs", "fn main() {}\n"), deadline).unwrap()
        );
        assert!(
            !is_sync_duplicate_before(&write("main 2b.rs", "fn main() {}\n"), deadline).unwrap()
        );
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
