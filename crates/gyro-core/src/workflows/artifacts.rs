use crate::{
    paths::{ensure_private_directory, reject_unsafe_private_file},
    project_memory::confined_bytes,
    GyroPaths,
};
use anyhow::{ensure, Result};
use std::io::Write;
use uuid::Uuid;
fn directory(paths: &GyroPaths) -> Result<std::path::PathBuf> {
    paths.ensure()?;
    let directory = paths.base_dir.join("workflow-draft-outputs");
    ensure_private_directory(&directory)?;
    Ok(directory)
}
pub fn open_draft_partial(paths: &GyroPaths, id: Uuid) -> Result<std::fs::File> {
    let directory = directory(paths)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    Ok(options.open(directory.join(format!("{id}.partial")))?)
}
pub fn write_draft_output(paths: &GyroPaths, id: Uuid, text: &str) -> Result<()> {
    ensure!(
        text.len() <= 2 * 1024 * 1024,
        "extraction output exceeds its size limit"
    );
    let directory = directory(paths)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(directory.join(format!("{id}.txt")))?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    Ok(())
}
pub fn read_draft_output(paths: &GyroPaths, id: Uuid) -> Result<Option<String>> {
    let bytes = confined_bytes(
        &paths.base_dir,
        &format!("workflow-draft-outputs/{id}.txt"),
        2 * 1024 * 1024,
    )?;
    let bytes = if bytes.is_some() {
        bytes
    } else {
        confined_bytes(
            &paths.base_dir,
            &format!("workflow-draft-outputs/{id}.partial"),
            2 * 1024 * 1024 + 100,
        )?
    };
    bytes.map(String::from_utf8).transpose().map_err(Into::into)
}
pub fn remove_draft_partial(paths: &GyroPaths, id: Uuid) -> Result<()> {
    remove(paths, id, "partial")
}
fn remove(paths: &GyroPaths, id: Uuid, suffix: &str) -> Result<()> {
    let directory = directory(paths)?;
    let file = directory.join(format!("{id}.{suffix}"));
    reject_unsafe_private_file(&file)?;
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
pub fn delete_draft_output(paths: &GyroPaths, id: Uuid) -> Result<()> {
    remove(paths, id, "partial")?;
    remove(paths, id, "txt")
}
