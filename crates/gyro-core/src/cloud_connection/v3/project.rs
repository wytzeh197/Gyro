use super::{Error, MAGIC, MAX_FILES, MAX_MANIFEST, MAX_PAYLOAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::{
    fs::{OpenOptionsExt, PermissionsExt},
    io::{AsRawFd, FromRawFd},
};
use std::{
    collections::{BTreeSet, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub executable: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub files: Vec<Entry>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub ticket: Uuid,
    pub files: Vec<Entry>,
    pub excluded: Vec<String>,
    pub sensitive_findings: Vec<String>,
    pub payload_bytes: u64,
    pub git_history_included: bool,
}
pub struct Selection {
    pub preview: Preview,
    root: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prepared {
    pub id: Uuid,
    pub size: u64,
    pub sha256: String,
    pub manifest_sha256: String,
    pub files: usize,
}

pub fn path_key(path: &str) -> String {
    path.nfkc()
        .flat_map(char::to_uppercase)
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .nfkc()
        .collect()
}
pub fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.starts_with('/')
        && !path
            .chars()
            .any(|c| c.is_control() || c == '\\' || c == ':')
        && path.split('/').all(|p| {
            !p.is_empty()
                && p != "."
                && p != ".."
                && ![
                    ".git",
                    ".gyro",
                    ".codex",
                    ".claude",
                    ".ssh",
                    ".aws",
                    ".gnupg",
                    ".gemini",
                    ".env",
                    ".npmrc",
                    ".netrc",
                    ".pypirc",
                    ".git-credentials",
                    "credentials",
                    "credentials.json",
                    "secrets.json",
                    ".kube",
                    ".docker",
                ]
                .contains(&path_key(p).as_str())
                && !path_key(p).starts_with(".env.")
                && !p.ends_with('.')
                && !p.ends_with(' ')
        })
}
pub fn validate(manifest: &Manifest) -> Result<(), Error> {
    if manifest.format != "gyro-project-v1"
        || manifest.files.len() > MAX_FILES
        || serde_json::to_vec(manifest)?.len() > MAX_MANIFEST
    {
        return Err(Error::Limit);
    }
    let mut files = HashSet::new();
    let mut dirs = HashSet::new();
    let mut total = 0u64;
    for entry in &manifest.files {
        if !safe_path(&entry.path)
            || entry.sha256.len() != 64
            || !entry
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Path);
        }
        let key = path_key(&entry.path);
        if files.contains(&key) || dirs.contains(&key) {
            return Err(Error::Path);
        }
        let parts: Vec<_> = key.split('/').collect();
        for n in 1..parts.len() {
            let dir = parts[..n].join("/");
            if files.contains(&dir) {
                return Err(Error::Path);
            }
            dirs.insert(dir);
        }
        files.insert(key);
        total = total.checked_add(entry.size).ok_or(Error::Limit)?;
    }
    if total > MAX_PAYLOAD {
        return Err(Error::Limit);
    }
    Ok(())
}
fn excluded(path: &str) -> bool {
    path.split('/').any(|p| {
        matches!(
            path_key(p).as_str(),
            ".git"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".next"
                | ".nuxt"
                | ".cache"
                | "__pycache__"
                | ".venv"
                | "venv"
                | ".turbo"
                | ".gradle"
                | ".idea"
                | ".ds_store"
                | ".ssh"
                | ".aws"
                | ".gnupg"
        )
    }) || {
        let p = path_key(path.rsplit('/').next().unwrap_or(""));
        p == ".env"
            || p.starts_with(".env.")
            || p == "credentials"
            || p == "credentials.json"
            || p == "secrets.json"
            || p == ".npmrc"
            || p == ".netrc"
            || p.ends_with(".pem")
            || p.ends_with(".key")
            || p.starts_with("id_rsa")
            || p.starts_with("id_ed25519")
    }
}
/// Open every component relative to a trusted native directory; never follow a link.
#[cfg(unix)]
fn open_relative(root: &Path, path: &str) -> Result<File, Error> {
    use std::ffi::CString;
    if !safe_path(path) {
        return Err(Error::Path);
    }
    let mut current = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)?;
    let parts: Vec<_> = path.split('/').collect();
    for (n, p) in parts.iter().enumerate() {
        let name = CString::new(*p).map_err(|_| Error::Path)?;
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if n + 1 < parts.len() {
                libc::O_DIRECTORY
            } else {
                libc::O_NONBLOCK
            };
        let fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(Error::Changed);
        }
        current = unsafe { File::from_raw_fd(fd) };
    }
    if !current.metadata()?.is_file() {
        return Err(Error::Path);
    }
    Ok(current)
}
#[cfg(not(unix))]
fn open_relative(_root: &Path, _path: &str) -> Result<File, Error> {
    Err(Error::Path)
}
fn digest(file: &mut File) -> Result<(u64, String, bool), Error> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(Error::Path);
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut size = 0u64;
    let mut sensitive = false;
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > MAX_PAYLOAD {
            return Err(Error::Limit);
        }
        hash.update(&buffer[..n]);
        // Conservative screening, never a claim that every secret is detected.
        let text = String::from_utf8_lossy(&buffer[..n]);
        sensitive |= text.contains("-----BEGIN PRIVATE KEY-----")
            || text.contains("-----BEGIN RSA PRIVATE KEY-----")
            || text.contains("AWS_SECRET_ACCESS_KEY=")
            || text.contains("OPENAI_API_KEY=")
            || text.contains("ANTHROPIC_API_KEY=");
    }
    if size != metadata.len() {
        return Err(Error::Changed);
    }
    Ok((size, format!("{:x}", hash.finalize()), sensitive))
}
fn scan(root: &Path) -> Result<(Manifest, Vec<String>, Vec<String>), Error> {
    let mut pending = vec![PathBuf::new()];
    let mut paths = BTreeSet::new();
    let mut skipped = Vec::new();
    let mut inspected = 0;
    while let Some(dir) = pending.pop() {
        for item in fs::read_dir(root.join(&dir))? {
            let item = item?;
            inspected += 1;
            if inspected > 100_000 {
                return Err(Error::Limit);
            }
            let relative = dir.join(item.file_name());
            let path = relative
                .to_str()
                .ok_or(Error::Path)?
                .replace(std::path::MAIN_SEPARATOR, "/");
            if excluded(&path)
                || path.split('/').any(|p| {
                    [
                        ".gyro",
                        ".codex",
                        ".claude",
                        ".gemini",
                        ".env",
                        ".npmrc",
                        ".netrc",
                        ".pypirc",
                        ".git-credentials",
                        "credentials",
                        "credentials.json",
                        "secrets.json",
                        ".kube",
                        ".docker",
                    ]
                    .contains(&path_key(p).as_str())
                })
            {
                skipped.push(path);
                continue;
            }
            if !safe_path(&path) {
                return Err(Error::Path);
            }
            let kind = item.file_type()?;
            if kind.is_symlink() {
                skipped.push(path);
                continue;
            }
            if kind.is_dir() {
                pending.push(relative);
            } else if kind.is_file() {
                paths.insert(path);
                if paths.len() > MAX_FILES {
                    return Err(Error::Limit);
                }
            } else {
                skipped.push(path);
            }
        }
    }
    let mut files = Vec::new();
    let mut sensitive = Vec::new();
    let mut total = 0u64;
    for path in paths {
        let mut file = open_relative(root, &path)?;
        let (size, sha256, found) = digest(&mut file)?;
        total = total.checked_add(size).ok_or(Error::Limit)?;
        if total > MAX_PAYLOAD {
            return Err(Error::Limit);
        }
        if found {
            sensitive.push(path.clone());
        }
        #[cfg(unix)]
        let executable = file.metadata()?.permissions().mode() & 0o111 != 0;
        #[cfg(not(unix))]
        let executable = false;
        files.push(Entry {
            path,
            size,
            sha256,
            executable,
        });
    }
    let m = Manifest {
        format: "gyro-project-v1".into(),
        files,
    };
    validate(&m)?;
    skipped.sort();
    Ok((m, skipped, sensitive))
}
pub fn preview(root: &Path) -> Result<Selection, Error> {
    if fs::symlink_metadata(root)?.file_type().is_symlink() {
        return Err(Error::Path);
    }
    let root = fs::canonicalize(root)?;
    if !root.is_dir() {
        return Err(Error::Path);
    }
    let (manifest, excluded, sensitive_findings) = scan(&root)?;
    let payload_bytes = 16
        + serde_json::to_vec(&manifest)?.len() as u64
        + manifest.files.iter().map(|e| e.size).sum::<u64>();
    if payload_bytes > MAX_PAYLOAD {
        return Err(Error::Limit);
    }
    Ok(Selection {
        root,
        preview: Preview {
            ticket: Uuid::new_v4(),
            files: manifest.files,
            excluded,
            sensitive_findings,
            payload_bytes,
            git_history_included: false,
        },
    })
}
pub fn private_dir(path: &Path) -> Result<(), Error> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(Error::Path);
    }
    Ok(())
}
pub fn prepare(selection: &Selection, spool: &Path) -> Result<Prepared, Error> {
    private_dir(spool)?;
    let (manifest, excluded, findings) = scan(&selection.root)?;
    if manifest.files != selection.preview.files
        || excluded != selection.preview.excluded
        || findings != selection.preview.sensitive_findings
    {
        return Err(Error::Changed);
    }
    let encoded = serde_json::to_vec(&manifest)?;
    let id = Uuid::new_v4();
    let path = spool.join(format!("{id}.pack"));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let mut out = options.open(&path)?;
        let mut hash = Sha256::new();
        let mut length = 0u64;
        let mut write = |bytes: &[u8]| -> Result<(), Error> {
            length += bytes.len() as u64;
            if length > MAX_PAYLOAD {
                return Err(Error::Limit);
            }
            out.write_all(bytes)?;
            hash.update(bytes);
            Ok(())
        };
        write(MAGIC)?;
        write(&(encoded.len() as u64).to_be_bytes())?;
        write(&encoded)?;
        for entry in &manifest.files {
            let mut input = open_relative(&selection.root, &entry.path)?;
            let mut buffer = [0u8; 65536];
            let mut file_hash = Sha256::new();
            let mut count = 0;
            loop {
                let n = input.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                count += n as u64;
                if count > entry.size {
                    return Err(Error::Changed);
                }
                file_hash.update(&buffer[..n]);
                write(&buffer[..n])?;
            }
            if count != entry.size || format!("{:x}", file_hash.finalize()) != entry.sha256 {
                return Err(Error::Changed);
            }
        }
        out.sync_all()?;
        let (after, after_excluded, after_findings) = scan(&selection.root)?;
        if after != manifest || after_excluded != excluded || after_findings != findings {
            return Err(Error::Changed);
        }
        Ok(Prepared {
            id,
            size: length,
            sha256: format!("{:x}", hash.finalize()),
            manifest_sha256: format!("{:x}", Sha256::digest(&encoded)),
            files: manifest.files.len(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}
/// Restore only our working-file format. It cannot encode links, devices, owners,
/// extended attributes, approval policy or autorun instructions.
pub fn restore(pack: &Path, expected: &Prepared, destination: &Path) -> Result<(), Error> {
    if destination.exists() {
        return Err(Error::Destination);
    }
    let mut input = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(pack)?;
    if input.metadata()?.len() != expected.size || expected.size > MAX_PAYLOAD {
        return Err(Error::Integrity);
    }
    let mut header = [0u8; 16];
    input.read_exact(&mut header)?;
    if &header[..8] != MAGIC {
        return Err(Error::Integrity);
    }
    let n = u64::from_be_bytes(header[8..].try_into().map_err(|_| Error::Integrity)?) as usize;
    if n == 0 || n > MAX_MANIFEST {
        return Err(Error::Limit);
    }
    let mut encoded = vec![0; n];
    input.read_exact(&mut encoded)?;
    if format!("{:x}", Sha256::digest(&encoded)) != expected.manifest_sha256 {
        return Err(Error::Integrity);
    }
    let manifest: Manifest = serde_json::from_slice(&encoded)?;
    validate(&manifest)?;
    let declared = 16 + n as u64 + manifest.files.iter().map(|e| e.size).sum::<u64>();
    if declared != expected.size {
        return Err(Error::Integrity);
    }
    fs::create_dir(destination).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            Error::Destination
        } else {
            Error::Io(e)
        }
    })?;
    #[cfg(unix)]
    fs::set_permissions(destination, fs::Permissions::from_mode(0o700))?;
    let marker = destination.join(".gyro-restore-incomplete");
    let marker_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)?;
    drop(marker_file);
    let mut hash = Sha256::new();
    hash.update(header);
    hash.update(&encoded);
    for entry in &manifest.files {
        if entry.path == ".gyro-restore-incomplete" {
            return Err(Error::Path);
        }
        let path = destination.join(&entry.path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let mut out = options.open(&path)?;
        let mut remain = entry.size;
        let mut file_hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        while remain > 0 {
            let n = usize::try_from(remain.min(buffer.len() as u64)).map_err(|_| Error::Limit)?;
            input.read_exact(&mut buffer[..n])?;
            out.write_all(&buffer[..n])?;
            file_hash.update(&buffer[..n]);
            hash.update(&buffer[..n]);
            remain -= n as u64;
        }
        if format!("{:x}", file_hash.finalize()) != entry.sha256 {
            return Err(Error::Integrity);
        }
        out.sync_all()?;
        #[cfg(unix)]
        fs::set_permissions(
            &path,
            fs::Permissions::from_mode(if entry.executable { 0o700 } else { 0o600 }),
        )?;
    }
    if format!("{:x}", hash.finalize()) != expected.sha256 {
        return Err(Error::Integrity);
    }
    let mut tail = [0];
    if input.read(&mut tail)? != 0 {
        return Err(Error::Integrity);
    }
    fs::remove_file(marker)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_excludes_secrets_detects_changes_and_restores_without_overwrite() {
        let source = tempfile::tempdir().unwrap();
        fs::write(source.path().join("hello.txt"), "hello").unwrap();
        fs::write(source.path().join(".env"), "secret").unwrap();
        fs::create_dir(source.path().join(".git")).unwrap();
        let selection = preview(source.path()).unwrap();
        assert_eq!(selection.preview.files.len(), 1);
        let spool = tempfile::tempdir().unwrap();
        let prepared = prepare(&selection, spool.path()).unwrap();
        let target = spool.path().join("restored");
        restore(
            &spool.path().join(format!("{}.pack", prepared.id)),
            &prepared,
            &target,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(target.join("hello.txt")).unwrap(),
            "hello"
        );
        assert!(!target.join(".env").exists());
        assert!(matches!(
            restore(
                &spool.path().join(format!("{}.pack", prepared.id)),
                &prepared,
                &target
            ),
            Err(Error::Destination)
        ));
        fs::write(source.path().join("hello.txt"), "changed").unwrap();
        assert!(matches!(
            prepare(&selection, spool.path()),
            Err(Error::Changed)
        ));
    }
    #[test]
    fn malicious_manifest_paths_and_collisions_rejected() {
        for paths in [
            vec!["../bad"],
            vec!["/bad"],
            vec![".GIT/config"],
            vec!["A", "a"],
            vec!["a", "a/b"],
            vec!["é", "e\u{301}"],
            vec!["ß", "SS"],
        ] {
            let manifest = Manifest {
                format: "gyro-project-v1".into(),
                files: paths
                    .into_iter()
                    .map(|path| Entry {
                        path: path.into(),
                        size: 0,
                        sha256: format!("{:x}", Sha256::digest([])),
                        executable: false,
                    })
                    .collect(),
            };
            assert!(validate(&manifest).is_err());
        }
    }
    #[test]
    fn symlink_is_never_followed() {
        let source = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/etc/passwd", source.path().join("link")).unwrap();
        let s = preview(source.path()).unwrap();
        assert!(s.preview.files.is_empty());
        assert!(s.preview.excluded.contains(&"link".to_string()));
    }
}
