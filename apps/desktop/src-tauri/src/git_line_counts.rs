//! Exact untracked text line counts with bounded memory and metadata caching.
use std::{
    collections::HashMap,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

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
static CACHE: OnceLock<Mutex<HashMap<PathBuf, (Fingerprint, usize)>>> = OnceLock::new();

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
    let cache = CACHE.get_or_init(Default::default);
    if let Some((cached, count)) = cache.lock().unwrap().get(path) {
        if *cached == before {
            return Ok(*count);
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
    let mut entries = cache.lock().unwrap();
    if entries.len() >= 4096 {
        entries.clear();
    }
    entries.insert(path.to_path_buf(), (before, count));
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
}
