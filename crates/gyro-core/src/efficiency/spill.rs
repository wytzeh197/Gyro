//! Spill: retire oversized tool evidence into a stable address plus a head/tail preview.
//! Pure local computation — no model call, no extra round trip, no per-model price table.
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::SystemTime,
};

/// Head bytes kept inline, enough for the model to recognize which payload this was.
pub const SPILL_HEAD_BYTES: usize = 1_200;
/// Tail bytes kept inline; tool output usually ends with the line that matters.
pub const SPILL_TAIL_BYTES: usize = 600;
/// Text this short is never spilled: the preview would not pay for its own bookkeeping.
pub const SPILL_MIN_BYTES: usize = SPILL_HEAD_BYTES + SPILL_TAIL_BYTES + 400;
pub const SPILL_PREFIX: &str = "spill://";
const SLUG_LIMIT: usize = 24;

/// Whether `value` addresses a retired copy rather than a file in the workspace.
pub fn is_address(value: &str) -> bool {
    value.starts_with(SPILL_PREFIX)
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct Preview {
    /// Text to place in the message: unchanged when nothing was elided.
    pub text: String,
    /// Stable address of the full copy, empty when the text fits inline.
    pub address: String,
    pub original_bytes: usize,
    pub kept_bytes: usize,
}

impl Preview {
    pub fn spilled(&self) -> bool {
        !self.address.is_empty()
    }
    pub fn elided_bytes(&self) -> usize {
        self.original_bytes.saturating_sub(self.kept_bytes)
    }
}

/// FNV-1a: stable across restarts and re-reads, so an address never churns. Dependency-free on
/// purpose — a hash here is an identifier, not a security boundary.
pub fn digest(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

pub fn slug(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if out.len() >= SLUG_LIMIT {
            break;
        }
        let lowered = ch.to_ascii_lowercase();
        out.push(
            if lowered.is_ascii_alphanumeric() || lowered == '-' || lowered == '_' {
                lowered
            } else {
                '-'
            },
        );
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "unknown".to_owned()
    } else {
        trimmed.to_owned()
    }
}

pub fn address(capability: &str, tool: &str, text: &str) -> String {
    format!(
        "{SPILL_PREFIX}{}/{}/{}",
        slug(capability),
        slug(tool),
        digest(text.as_bytes())
    )
}

fn floor_bound(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_bound(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

/// Replace the middle of `text` with a pointer that names its exact size and address. The head and
/// tail are preserved on UTF-8 boundaries so the preview never splits a multi-byte character.
pub fn preview(capability: &str, tool: &str, text: &str) -> Preview {
    let original = text.len();
    if original < SPILL_MIN_BYTES {
        return Preview {
            text: text.to_owned(),
            address: String::new(),
            original_bytes: original,
            kept_bytes: original,
        };
    }
    let head = floor_bound(text, SPILL_HEAD_BYTES);
    let tail = ceil_bound(text, original - SPILL_TAIL_BYTES);
    let address = address(capability, tool, text);
    if tail <= head {
        return Preview {
            text: format!("[{original} bytes elided · {address} · re-read it if needed]"),
            address,
            original_bytes: original,
            kept_bytes: 0,
        };
    }
    let elided = tail.saturating_sub(head);
    Preview {
        text: format!(
            "{}\n\n[{elided} bytes elided · full copy at {address} · re-read only the range you need, not the whole file]\n\n{}",
            &text[..head],
            &text[tail..]
        ),
        address,
        original_bytes: original,
        kept_bytes: head + (original - tail),
    }
}

/// Retrieval hint built from the payload itself, so retirement never leaves the model without a
/// next step: the same tool can be re-issued against a narrow range.
pub fn retrieval_hint(data: &serde_json::Value) -> Option<String> {
    let object = data.as_object()?;
    let path = object.get("path").and_then(|value| value.as_str())?;
    let start = object.get("line").and_then(|value| value.as_u64());
    let end = object.get("endLine").and_then(|value| value.as_u64()).or(start);
    match (start, end) {
        (Some(start), Some(end)) => Some(format!("re-read path={path} line={start} endLine={end}")),
        _ => Some(format!("re-read path={path}")),
    }
}

/// Durable copy of spilled text. Deliberately a plain directory of files: readable with the tools
/// already available, with no index that can drift from the content.
#[derive(Clone, Debug)]
pub struct SpillStore {
    root: PathBuf,
}

impl SpillStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn path_for(&self, address: &str) -> PathBuf {
        self.root.join(format!("{}.txt", digest(address.as_bytes())))
    }
    /// Write the full copy atomically, so a crash never leaves a half-written spill behind.
    pub fn save(&self, address: &str, text: &str) -> io::Result<PathBuf> {
        fs::create_dir_all(&self.root)?;
        let path = self.path_for(address);
        let temp = path.with_extension("tmp");
        fs::write(&temp, text)?;
        restrict(&temp)?;
        fs::rename(&temp, &path)?;
        Ok(path)
    }
    pub fn load(&self, address: &str) -> io::Result<Option<String>> {
        match fs::read_to_string(self.path_for(address)) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
    /// Keep the `keep` most recently written spills; returns how many were removed.
    pub fn gc(&self, keep: usize) -> io::Result<usize> {
        let mut entries = Vec::new();
        let Ok(directory) = fs::read_dir(&self.root) else {
            return Ok(0);
        };
        for entry in directory.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("txt") {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            entries.push((modified, path));
        }
        if entries.len() <= keep {
            return Ok(0);
        }
        entries.sort_by(|left, right| right.0.cmp(&left.0));
        let mut removed = 0;
        for (_, path) in entries.into_iter().skip(keep) {
            if fs::remove_file(path).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// The store a session uses when no caller passed one: inside the app data directory, beside
    /// the rest of the per-user state. `GYRO_SPILL_DIR` overrides it, which is what tests and
    /// unusually constrained environments use. `None` only when the platform has no data directory.
    pub fn app_data() -> Option<Self> {
        if let Ok(dir) = std::env::var("GYRO_SPILL_DIR") {
            if !dir.is_empty() {
                return Some(Self::new(dir));
            }
        }
        Some(Self::new(dirs::data_dir()?.join("Gyro").join("spill")))
    }
}

/// How many spilled copies the store keeps before the oldest are swept.
const SPILL_KEEP: usize = 512;

/// A process-wide store, resolved once. Retirement runs on every provider call and must never fail
/// because a directory is missing, so this is best-effort and never surfaces an error.
fn session_store() -> Option<&'static SpillStore> {
    use std::sync::OnceLock;
    static STORE: OnceLock<Option<SpillStore>> = OnceLock::new();
    STORE.get_or_init(SpillStore::app_data).as_ref()
}

/// Put the full copy of a spilled value on disk, so the address quoted in its preview resolves.
/// Returns whether the copy is readable; `false` means the preview is all there is.
pub fn persist(address: &str, text: &str) -> bool {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static WRITES: AtomicUsize = AtomicUsize::new(0);
    let Some(store) = session_store() else {
        return false;
    };
    let saved = store.save(address, text).is_ok();
    // Sweep occasionally rather than on a timer: this is a cache, so dropping old copies is
    // expected, and a write-count trigger costs nothing on the hot path.
    if WRITES.fetch_add(1, Ordering::Relaxed) % 64 == 0 {
        let _ = store.gc(SPILL_KEEP);
    }
    saved
}

/// How much of a copy one read returns by default. Bounded because the whole reason a preview
/// quoted an address instead of the value is that the value was too expensive to carry; a reader
/// that always returned everything would undo the saving it exists to serve.
pub const SPILL_READ_WINDOW: usize = 8 * 1024;

/// One addressed window of a spilled copy. It carries its own address and byte range, so a
/// follow-up read is a copy of one number rather than arithmetic on the caller's side.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpillRead {
    pub address: String,
    pub text: String,
    /// Byte offset this window starts at, always on a character boundary.
    pub offset: usize,
    /// Size of the whole copy, not of this window.
    pub total_bytes: usize,
}

impl SpillRead {
    /// Whether the copy continues past this window.
    pub fn truncated(&self) -> bool {
        self.offset + self.text.len() < self.total_bytes
    }

    /// Where the next window starts, when there is one.
    pub fn next_offset(&self) -> Option<usize> {
        self.truncated()
            .then_some(self.offset + self.text.len())
    }

    /// Address-stamped readback. The header is what stops a window being mistaken for the whole
    /// copy, and what makes the next read a single number to copy rather than a guess.
    pub fn render(&self) -> String {
        let end = self.offset + self.text.len();
        let header = match self.next_offset() {
            Some(next) => format!(
                "{} · bytes {end} of {} · next offset={next}",
                self.address, self.total_bytes
            ),
            None => format!("{} · bytes {end} of {} · complete", self.address, self.total_bytes),
        };
        match self.text.is_empty() {
            true => header,
            false => format!("{header}\n{}", self.text),
        }
    }
}

/// Read a spilled copy through the address its preview quoted.
///
/// `Ok(None)` is the normal meaning of "there is no copy here": evicted by the sweep, or this
/// machine never had a data directory to write it to. The preview is then all there is, which is a
/// smaller loss than an error the caller has to distinguish from a bug.
pub fn read(address: &str) -> io::Result<Option<SpillRead>> {
    read_window(address, 0, SPILL_READ_WINDOW)
}

/// Read one window of a spilled copy, starting `offset` bytes in.
///
/// The file is loaded whole to answer this — local disk, no tokens — but only the window is
/// returned: an address lets a reader pay for the bytes it needs, not for the copy.
pub fn read_window(address: &str, offset: usize, limit: usize) -> io::Result<Option<SpillRead>> {
    check_address(address)?;
    let Some(store) = session_store() else {
        return Ok(None);
    };
    read_window_from(store, address, offset, limit)
}

fn read_window_from(
    store: &SpillStore,
    address: &str,
    offset: usize,
    limit: usize,
) -> io::Result<Option<SpillRead>> {
    let Some(text) = store.load(address)? else {
        return Ok(None);
    };
    let total_bytes = text.len();
    let start = floor_bound(&text, offset);
    let end = ceil_bound(&text, start.saturating_add(limit)).max(start);
    Ok(Some(SpillRead {
        address: address.to_owned(),
        text: text[start..end].to_owned(),
        offset: start,
        total_bytes,
    }))
}

/// The address is the only thing a reader supplies, so it is the only thing worth validating. The
/// copy itself is named by digest, so no address can be shaped to escape the store directory.
fn check_address(address: &str) -> io::Result<()> {
    let shaped = address
        .strip_prefix(SPILL_PREFIX)
        .map(|rest| rest.split('/').collect::<Vec<_>>())
        .is_some_and(|segments| segments.len() == 3 && segments.iter().all(|part| !part.is_empty()));
    match shaped {
        true => Ok(()),
        false => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("not a spill address: {address}"),
        )),
    }
}

#[cfg(unix)]
fn restrict(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn long_text() -> String {
        let mut text = String::new();
        for index in 0..400 {
            text.push_str(&format!("line {index}: some tool output that keeps going\n"));
        }
        text
    }

    fn scratch() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("gyro-spill-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn short_text_is_untouched() {
        let preview = preview("workspace-read", "read", "small payload");
        assert!(!preview.spilled());
        assert_eq!(preview.text, "small payload");
        assert_eq!(preview.elided_bytes(), 0);
    }

    #[test]
    fn long_text_keeps_head_and_tail_and_names_its_address() {
        let text = long_text();
        let preview = preview("workspace-read", "read", &text);
        assert!(preview.spilled());
        assert_eq!(preview.original_bytes, text.len());
        assert!(preview.kept_bytes < text.len());
        assert!(preview.elided_bytes() > 0);
        assert!(preview.text.starts_with("line 0:"));
        assert!(preview.text.contains("keeps going"));
        assert!(preview.text.contains(&preview.address));
        assert!(preview.text.len() < text.len());
    }

    #[test]
    fn address_is_stable_for_the_same_payload() {
        let text = long_text();
        let first = preview("workspace-read", "read", &text);
        let second = preview("workspace-read", "read", &text);
        assert_eq!(first.address, second.address);
        assert!(first.address.starts_with(SPILL_PREFIX));
        let different = preview("workspace-read", "read", &format!("{text}extra"));
        assert_ne!(first.address, different.address);
    }

    #[test]
    fn preview_never_splits_a_multibyte_character() {
        let text = "é".repeat(4_000);
        let preview = preview("workspace-read", "read", &text);
        assert!(preview.spilled());
        // The preview is a valid str by construction; the point is that slicing respected char
        // boundaries instead of panicking on a multi-byte character.
        assert!(preview.text.contains('é'));
        assert!(preview.text.contains(&preview.address));
        assert!(preview.kept_bytes < preview.original_bytes);
    }

    #[test]
    fn hint_points_at_a_narrow_reread() {
        let hint = retrieval_hint(&json!({"path": "src/lib.rs", "line": 10, "endLine": 40}));
        assert_eq!(
            hint.as_deref(),
            Some("re-read path=src/lib.rs line=10 endLine=40")
        );
        assert_eq!(
            retrieval_hint(&json!({"path": "src/lib.rs"})).as_deref(),
            Some("re-read path=src/lib.rs")
        );
        assert!(retrieval_hint(&json!({"summary": "no path"})).is_none());
    }

    #[test]
    fn store_round_trips_and_gc_keeps_the_newest() {
        let root = scratch();
        let store = SpillStore::new(&root);
        let text = long_text();
        let spill_address = address("workspace-read", "read", &text);
        let path = store.save(&spill_address, &text).expect("save spill");
        assert!(path.exists());
        assert_eq!(
            store.load(&spill_address).expect("load").as_deref(),
            Some(text.as_str())
        );
        assert!(store.load("spill://missing").expect("load").is_none());
        for index in 0..3 {
            let payload = format!("payload {index}");
            let other = address("workspace-read", "read", &payload);
            store.save(&other, &payload).expect("save spill");
        }
        let removed = store.gc(2).expect("gc");
        assert_eq!(removed, 2);
        assert_eq!(fs::read_dir(&root).expect("read dir").count(), 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_preview_address_reads_the_whole_copy_back_in_windows() {
        let root = scratch();
        let store = SpillStore::new(&root);
        let text = long_text();
        let spill_address = address("workspace-read", "read", &text);
        store.save(&spill_address, &text).expect("save spill");

        let first = read_window_from(&store, &spill_address, 0, 1_024)
            .expect("read")
            .expect("copy exists");
        assert_eq!(first.offset, 0);
        assert_eq!(first.total_bytes, text.len());
        assert!(first.truncated());
        assert!(text.starts_with(&first.text));

        let mut assembled = first.text.clone();
        let mut offset = first.next_offset().expect("more to read");
        while let Some(window) =
            read_window_from(&store, &spill_address, offset, 1_024).expect("read")
        {
            assert!(!window.text.is_empty(), "a window must make progress");
            assembled.push_str(&window.text);
            match window.next_offset() {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert_eq!(assembled, text);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_window_that_cuts_a_character_widens_to_the_boundary() {
        let root = scratch();
        let store = SpillStore::new(&root);
        let text = "é".repeat(64);
        let spill_address = address("workspace-read", "read", &text);
        store.save(&spill_address, &text).expect("save spill");

        // Three bytes in is the middle of the second `é`: the window must move to a boundary
        // rather than slice a character in half.
        let window = read_window_from(&store, &spill_address, 3, 4)
            .expect("read")
            .expect("copy exists");
        assert_eq!(window.offset, 2);
        assert_eq!(window.text, "éé");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_copy_is_absence_not_an_error() {
        let root = scratch();
        let store = SpillStore::new(&root);
        let spill_address = address("workspace-read", "read", &long_text());
        assert!(read_window_from(&store, &spill_address, 0, 64)
            .expect("read")
            .is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_read_that_names_something_other_than_a_spill_is_refused() {
        assert_eq!(
            read("src/lib.rs").expect_err("not a spill address").kind(),
            std::io::ErrorKind::InvalidInput
        );
        assert!(read("spill://only-two/parts").is_err());
        assert!(read("spill://a/b/").is_err());
        // A well-shaped address is not refused: absent is the store's answer, not an error.
        assert!(read(&format!("{SPILL_PREFIX}cap/tool/deadbeef00000000")).is_ok());
    }

    #[test]
    fn readback_says_where_the_next_window_starts() {
        let window = SpillRead {
            address: format!("{SPILL_PREFIX}cap/tool/deadbeef00000000"),
            text: "0123456789".into(),
            offset: 10,
            total_bytes: 40,
        };
        let rendered = window.render();
        assert!(rendered.starts_with(&format!("{SPILL_PREFIX}cap/tool/deadbeef00000000 · bytes 20 of 40")));
        assert!(rendered.contains("next offset=20"));
        assert!(rendered.ends_with("0123456789"));

        let complete = SpillRead {
            total_bytes: 20,
            ..window
        };
        assert_eq!(complete.next_offset(), None);
        let complete = complete.render();
        assert!(complete.contains("· complete"));
        assert!(!complete.contains("next offset"));
    }
}
