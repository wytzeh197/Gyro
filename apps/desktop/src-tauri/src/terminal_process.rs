//! PTY-backed terminal panes: spawn, observe, write, resize and stop.
//!
//! The pane map lock only guards the map itself. Each pane has its own lock,
//! and its PTY writer has another, so a write blocked on a full PTY input queue
//! (a large paste into a program that is not reading stdin) never stalls other
//! panes, `stop` on the stuck pane, model terminal waits, or the quit drain.
//! Spawning (which can run `git` to resolve the working directory) and
//! terminating also happen outside the map lock.
use super::*;

pub(crate) struct TerminalProcess {
    request: TerminalPaneRequest,
    working_directory: Option<PathBuf>,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send>,
    output: Arc<Mutex<TerminalOutputBuffer>>,
    status: String,
    exit_code: Option<i32>,
    cols: u16,
    rows: u16,
    terminated: bool,
}

pub(crate) type TerminalPane = Arc<Mutex<TerminalProcess>>;

#[derive(Default)]
pub(crate) struct TerminalOutputBuffer {
    pub(crate) bytes: VecDeque<u8>,
    pub(crate) revision: u64,
    reader_finished: bool,
}

impl Drop for TerminalProcess {
    fn drop(&mut self) {
        terminate_terminal_process(self);
    }
}

/// A pane's state stays usable after a panic elsewhere; terminating or reading
/// it must never be refused because of an unrelated poisoned guard.
fn lock_pane(pane: &TerminalPane) -> std::sync::MutexGuard<'_, TerminalProcess> {
    pane.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Terminates a pane that has already left the map. Quit runs these in parallel.
pub(crate) fn terminate_terminal_pane(pane: &TerminalPane) {
    terminate_terminal_process(&mut lock_pane(pane));
}

impl TerminalProcessManager {
    fn lock_panes(
        &self,
    ) -> anyhow::Result<std::sync::MutexGuard<'_, HashMap<String, TerminalPane>>> {
        self.processes
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal process manager lock poisoned"))
    }

    fn pane(&self, pane_id: &str) -> anyhow::Result<TerminalPane> {
        self.lock_panes()?
            .get(pane_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("terminal pane not found"))
    }

    fn with_pane<T>(
        &self,
        pane_id: &str,
        action: impl FnOnce(&mut TerminalProcess) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let pane = self.pane(pane_id)?;
        let mut process = lock_pane(&pane);
        action(&mut process)
    }

    pub(crate) fn create(
        &self,
        request: TerminalPaneRequest,
    ) -> anyhow::Result<TerminalPaneSnapshot> {
        let at_limit = |panes: &HashMap<String, TerminalPane>, pane_id: &str| {
            !panes.contains_key(pane_id) && panes.len() >= MAX_TERMINAL_PROCESSES
        };
        if at_limit(&*self.lock_panes()?, &request.pane_id) {
            anyhow::bail!("terminal process limit reached; close a terminal pane first");
        }
        // Resolving the working directory can run git for seconds; never hold
        // the pane map while doing it.
        let mut process = spawn_terminal_process(request)?;
        let snapshot = snapshot_terminal_process(&mut process, None);
        let pane_id = process.request.pane_id.clone();
        let replaced = {
            let mut panes = self.lock_panes()?;
            if at_limit(&*panes, &pane_id) {
                drop(panes);
                drop(process);
                anyhow::bail!("terminal process limit reached; close a terminal pane first");
            }
            panes.insert(pane_id, Arc::new(Mutex::new(process)))
        };
        if let Some(replaced) = replaced {
            terminate_terminal_pane(&replaced);
        }
        Ok(snapshot)
    }

    pub(crate) fn write(&self, pane_id: &str, input: &str) -> anyhow::Result<TerminalPaneSnapshot> {
        let pane = self.pane(pane_id)?;
        let writer = {
            let process = lock_pane(&pane);
            if process.status == "done" || process.status == "failed" {
                anyhow::bail!("terminal pane stdin is closed");
            }
            Arc::clone(&process.writer)
        };
        // The write can block until the program drains its input queue. Only
        // this pane's writer lock is held while it does.
        {
            let mut writer = writer
                .lock()
                .map_err(|_| anyhow::anyhow!("terminal pane writer lock poisoned"))?;
            writer.write_all(input.as_bytes())?;
            writer.flush()?;
        }
        let mut process = lock_pane(&pane);
        Ok(snapshot_terminal_process(&mut process, None))
    }

    pub(crate) fn read(
        &self,
        pane_id: &str,
        known_output_revision: Option<u64>,
    ) -> anyhow::Result<TerminalPaneSnapshot> {
        self.with_pane(pane_id, |process| {
            Ok(snapshot_terminal_process(process, known_output_revision))
        })
    }

    /// Status for a poll loop. Output is copied only when `include_output`, so
    /// a long wait does not copy the whole scrollback on every tick.
    pub(crate) fn observe(
        &self,
        pane_id: &str,
        include_output: bool,
    ) -> anyhow::Result<TerminalPaneSnapshot> {
        self.with_pane(pane_id, |process| {
            let known_output_revision = (!include_output)
                .then(|| process.output.lock().map(|output| output.revision).ok())
                .flatten();
            Ok(snapshot_terminal_process(process, known_output_revision))
        })
    }

    pub(crate) fn resize(
        &self,
        pane_id: &str,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<TerminalPaneSnapshot> {
        self.with_pane(pane_id, |process| {
            process.cols = cols;
            process.rows = rows;
            process.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
            Ok(snapshot_terminal_process(process, None))
        })
    }

    pub(crate) fn has_foreground_job(&self, pane_id: &str) -> anyhow::Result<bool> {
        self.with_pane(pane_id, |process| {
            let snapshot = snapshot_terminal_process(process, None);
            if snapshot.status != "running" {
                return Ok(false);
            }
            Ok(snapshot.has_foreground_job.unwrap_or(true))
        })
    }

    pub(crate) fn stop(&self, pane_id: &str) -> anyhow::Result<TerminalPaneSnapshot> {
        self.with_pane(pane_id, |process| {
            terminate_terminal_process(process);
            process.status = "failed".into();
            Ok(snapshot_terminal_process(process, None))
        })
    }

    /// Closes a pane, returning the governed session it held so the caller can
    /// retire its approval authority.
    pub(crate) fn close(&self, pane_id: &str) -> anyhow::Result<Option<String>> {
        let pane = self
            .lock_panes()?
            .remove(pane_id)
            .ok_or_else(|| anyhow::anyhow!("terminal pane not found"))?;
        let mut process = lock_pane(&pane);
        let governed_session = process
            .request
            .governance
            .as_ref()
            .map(|governance| governance.session_id.clone());
        terminate_terminal_process(&mut process);
        Ok(governed_session)
    }

    /// Removes every pane without terminating it, so quit can stop them in
    /// parallel under one deadline.
    pub(crate) fn take_all(&self) -> Vec<TerminalPane> {
        self.processes
            .lock()
            .map(|mut panes| panes.drain().map(|(_, pane)| pane).collect())
            .unwrap_or_default()
    }

    /// The governed session a live pane currently holds, if any.
    pub(crate) fn governed_session(&self, pane_id: &str) -> Option<String> {
        let pane = self.pane(pane_id).ok()?;
        let process = lock_pane(&pane);
        process
            .request
            .governance
            .as_ref()
            .map(|governance| governance.session_id.clone())
    }

    /// The shell pid and launch directory, for resolving a pane's live cwd.
    pub(crate) fn process_directory(
        &self,
        pane_id: &str,
    ) -> anyhow::Result<(Option<u32>, Option<PathBuf>)> {
        self.with_pane(pane_id, |process| {
            Ok((
                process.child.process_id(),
                process.working_directory.clone(),
            ))
        })
    }

    /// Relaunches with the same request (and governance). The replacement is
    /// spawned first and the old process is terminated once it is swapped out.
    pub(crate) fn restart(&self, pane_id: &str) -> anyhow::Result<TerminalPaneSnapshot> {
        let request = self.with_pane(pane_id, |process| Ok(process.request.clone()))?;
        self.create(request)
    }

    pub(crate) fn restore(&self) -> anyhow::Result<Vec<TerminalPaneSnapshot>> {
        let panes = self.lock_panes()?.values().cloned().collect::<Vec<_>>();
        Ok(panes
            .iter()
            .map(|pane| snapshot_terminal_process(&mut lock_pane(pane), None))
            .collect())
    }
}

fn spawn_terminal_process(request: TerminalPaneRequest) -> anyhow::Result<TerminalProcess> {
    if request.command.trim().is_empty() {
        anyhow::bail!("terminal command cannot be empty");
    }

    let cwd = resolve_terminal_cwd(&request)?;
    let cols = request.cols.unwrap_or(120);
    let rows = request.rows.unwrap_or(32);
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let command_path = terminal_command_path(&request.command);
    let mut command = CommandBuilder::new(command_path.as_str());
    command.args(request.args.iter().map(String::as_str));
    if let Some(governance) = request.governance.as_ref() {
        command.args(governance.args.iter().map(String::as_str));
    }
    if let Some(cwd) = cwd.as_ref() {
        command.cwd(cwd);
    }
    configure_terminal_environment(&mut command);
    if let Some(governance) = request.governance.as_ref() {
        for (name, value) in &governance.env {
            command.env(name, value);
        }
    }
    if !command_path.contains('/') {
        command.env("PATH", augmented_gui_path());
    }

    let child = pair.slave.spawn_command(command)?;
    let output = Arc::new(Mutex::new(TerminalOutputBuffer::default()));
    let reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    spawn_terminal_reader(reader, Arc::clone(&output));
    drop(pair.slave);

    Ok(TerminalProcess {
        request,
        working_directory: cwd,
        master: pair.master,
        writer: Arc::new(Mutex::new(writer)),
        child,
        output,
        status: "running".into(),
        exit_code: None,
        cols,
        rows,
        terminated: false,
    })
}

fn terminate_terminal_process(process: &mut TerminalProcess) {
    if process.terminated {
        return;
    }
    #[cfg(unix)]
    let process_groups = {
        let shell_group = process.child.process_id().map(|pid| pid as i32);
        let foreground_group = process.master.process_group_leader();
        let mut groups = [foreground_group, shell_group]
            .into_iter()
            .flatten()
            .filter(|group| *group > 1)
            .collect::<Vec<_>>();
        groups.sort_unstable();
        groups.dedup();
        for group in &groups {
            // PTY jobs can outlive their shell. Signal both the current
            // foreground job and the shell process group before reaping.
            unsafe {
                libc::kill(-*group, libc::SIGHUP);
                libc::kill(-*group, libc::SIGTERM);
            }
        }
        groups
    };
    let _ = process.child.kill();
    #[cfg(unix)]
    {
        std::thread::sleep(Duration::from_millis(25));
        for group in process_groups {
            unsafe {
                if libc::kill(-group, 0) == 0 {
                    libc::kill(-group, libc::SIGKILL);
                }
            }
        }
    }
    if let Ok(status) = process.child.wait() {
        process.exit_code = Some(status.exit_code() as i32);
        process.terminated = true;
    }
}

pub(crate) fn configure_terminal_environment(command: &mut CommandBuilder) {
    command.env_remove("NO_COLOR");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Gyro");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    command.env("CLICOLOR", "1");
    command.env("CLICOLOR_FORCE", "1");
    command.env("FORCE_COLOR", "1");
}

pub(crate) fn resolve_terminal_cwd(
    request: &TerminalPaneRequest,
) -> anyhow::Result<Option<PathBuf>> {
    if request.working_directory.as_deref() == Some("Home") {
        return Ok(Some(user_home_directory()?));
    }
    let workspace = request
        .workspace_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .map(|path| path.canonicalize())
        .transpose()?;
    let Some(mut workspace) = workspace else {
        return Ok(Some(user_home_directory()?));
    };
    // A folder picker or split explicitly selected this path, including worktrees.
    if request.working_directory.as_deref() == Some("Exact workspace") {
        return Ok(Some(workspace));
    }
    if request.workspace_mode.as_deref() != Some("worktree") {
        workspace = terminal_local_workspace(&workspace).unwrap_or(workspace);
    }

    let Some(working_directory) = request.working_directory.as_deref() else {
        return Ok(Some(workspace));
    };
    if working_directory.trim().is_empty() || working_directory == "Workspace" {
        return Ok(Some(workspace));
    }

    let candidate = Path::new(working_directory);
    gyro_core::security::assert_path_inside_workspace(&workspace, candidate).map(Some)
}

fn terminal_local_workspace(workspace: &Path) -> anyhow::Result<PathBuf> {
    let mut top_level_command = git_command();
    top_level_command
        .arg("-C")
        .arg(workspace)
        .args(["rev-parse", "--show-toplevel"]);
    let top_level_output = run_bounded_command(
        &top_level_command,
        Duration::from_secs(10),
        None,
        64 * 1024,
        64 * 1024,
    )?;
    if !top_level_output.succeeded() || top_level_output.stdout_truncated {
        return Ok(workspace.to_path_buf());
    }
    let git_top_level = PathBuf::from(top_level_output.stdout.trim()).canonicalize()?;

    let mut common_dir_command = git_command();
    common_dir_command.arg("-C").arg(workspace).args([
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ]);
    let common_dir_output = run_bounded_command(
        &common_dir_command,
        Duration::from_secs(10),
        None,
        64 * 1024,
        64 * 1024,
    )?;
    if !common_dir_output.succeeded() || common_dir_output.stdout_truncated {
        return Ok(workspace.to_path_buf());
    }
    let git_common_dir = PathBuf::from(common_dir_output.stdout.trim());
    let Some(repo_root) = git_common_dir.parent() else {
        return Ok(workspace.to_path_buf());
    };
    let repo_root = repo_root.canonicalize()?;
    if repo_root != git_top_level {
        return Ok(repo_root);
    }
    Ok(workspace.to_path_buf())
}

fn spawn_terminal_reader<R>(reader: R, output: Arc<Mutex<TerminalOutputBuffer>>)
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut chunk = [0; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => append_terminal_output(&output, &chunk[..count]),
                Err(_) => break,
            }
        }
        if let Ok(mut output) = output.lock() {
            output.reader_finished = true;
        }
    });
}

pub(crate) fn append_terminal_output(output: &Arc<Mutex<TerminalOutputBuffer>>, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let Ok(mut output) = output.lock() else {
        return;
    };
    output.revision = output.revision.wrapping_add(1).max(1);
    if bytes.len() >= MAX_TERMINAL_OUTPUT_BYTES {
        output.bytes.clear();
        output.bytes.extend(
            bytes[bytes.len() - MAX_TERMINAL_OUTPUT_BYTES..]
                .iter()
                .copied(),
        );
        return;
    }
    let overflow = output
        .bytes
        .len()
        .saturating_add(bytes.len())
        .saturating_sub(MAX_TERMINAL_OUTPUT_BYTES);
    if overflow > 0 {
        output.bytes.drain(..overflow);
    }
    output.bytes.extend(bytes.iter().copied());
}

fn snapshot_terminal_process(
    process: &mut TerminalProcess,
    known_output_revision: Option<u64>,
) -> TerminalPaneSnapshot {
    match process.child.try_wait() {
        Ok(Some(status)) => {
            process.exit_code = Some(status.exit_code() as i32);
            process.terminated = true;
            process.status = if status.success() {
                "done".into()
            } else {
                "failed".into()
            };
        }
        Ok(None) => {
            if process.status != "failed" {
                process.status = "running".into();
            }
        }
        Err(_) => {
            process.status = "failed".into();
        }
    }

    let (output, output_revision, output_complete) = process
        .output
        .lock()
        .map(|value| {
            let (output, revision) = snapshot_terminal_output(&value, known_output_revision);
            (output, revision, value.reader_finished)
        })
        .unwrap_or((None, 0, false));
    let has_foreground_job = terminal_process_has_foreground_job(process);
    TerminalPaneSnapshot {
        pane_id: process.request.pane_id.clone(),
        title: process.request.title.clone(),
        profile_id: process.request.profile_id.clone(),
        command: std::iter::once(process.request.command.as_str())
            .chain(process.request.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        output,
        output_revision,
        output_complete,
        status: process.status.clone(),
        has_foreground_job,
        exit_code: process.exit_code,
        workspace_path: process.request.workspace_path.clone(),
        working_directory: process
            .working_directory
            .as_ref()
            .map(|path| path.display().to_string()),
        cols: process.cols,
        rows: process.rows,
        governed_session_id: process
            .request
            .governance
            .as_ref()
            .map(|governance| governance.session_id.clone()),
        governed_provider_id: process
            .request
            .governance
            .as_ref()
            .map(|governance| governance.provider_id.clone()),
    }
}

fn terminal_process_has_foreground_job(process: &TerminalProcess) -> Option<bool> {
    if process.status != "running" {
        return Some(false);
    }

    #[cfg(unix)]
    {
        let shell_pid = process.child.process_id().map(|pid| pid as i32);
        let foreground_pid = process.master.process_group_leader();
        match (shell_pid, foreground_pid) {
            (Some(shell_pid), Some(foreground_pid)) => Some(foreground_pid != shell_pid),
            _ => None,
        }
    }

    #[cfg(not(unix))]
    Some(true)
}

pub(crate) fn snapshot_terminal_output(
    output: &TerminalOutputBuffer,
    known_output_revision: Option<u64>,
) -> (Option<String>, u64) {
    let text = (known_output_revision != Some(output.revision))
        .then(|| terminal_output_text(&output.bytes));
    (text, output.revision)
}

fn terminal_output_text(output: &VecDeque<u8>) -> String {
    let (first, second) = output.as_slices();
    if second.is_empty() {
        return String::from_utf8_lossy(first).into_owned();
    }
    let mut bytes = Vec::with_capacity(output.len());
    bytes.extend_from_slice(first);
    bytes.extend_from_slice(second);
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(manager: &TerminalProcessManager, pane_id: &str, script: &str) {
        manager
            .create(TerminalPaneRequest {
                pane_id: pane_id.into(),
                title: "Shell".into(),
                command: "sh".into(),
                args: vec!["-c".into(), script.into()],
                ..Default::default()
            })
            .unwrap();
    }

    fn wait_for_output(manager: &TerminalProcessManager, pane_id: &str, expected: &str) {
        let ready = (0..100).any(|_| {
            let output = manager.read(pane_id, None).unwrap().output;
            let ready = output.unwrap_or_default().contains(expected);
            if !ready {
                std::thread::sleep(Duration::from_millis(20));
            }
            ready
        });
        assert!(ready, "{pane_id} never printed {expected}");
    }

    /// Runs `action` on another thread and fails, instead of hanging the suite,
    /// if it does not finish in time.
    fn within<T: Send + 'static>(label: &str, action: impl FnOnce() -> T + Send + 'static) -> T {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(action());
        });
        receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_else(|_| panic!("{label} blocked behind a stalled terminal write"))
    }

    #[cfg(unix)]
    #[test]
    fn stalled_pane_write_blocks_neither_other_panes_nor_stop() {
        let manager = TerminalProcessManager::default();
        // Raw mode with a program that never reads stdin: the PTY input queue
        // fills and the master write blocks, as with a large paste.
        start(
            &manager,
            "stalled",
            "stty raw -echo; printf ready; exec sleep 30",
        );
        start(&manager, "other", "printf other-ready; exec sleep 30");
        wait_for_output(&manager, "stalled", "ready");
        wait_for_output(&manager, "other", "other-ready");

        let writer_manager = manager.clone();
        let (written, write_finished) = mpsc::channel();
        std::thread::spawn(move || {
            let result = writer_manager.write("stalled", &"x".repeat(256 * 1024));
            let _ = written.send(result.is_ok());
        });
        assert!(
            write_finished
                .recv_timeout(Duration::from_millis(300))
                .is_err(),
            "the paste should be stuck on a full PTY input queue"
        );

        let other = manager.clone();
        within("another pane", move || {
            other.read("other", None).unwrap();
            other.resize("other", 100, 30).unwrap();
            other.write("other", "input\n").unwrap();
            other.observe("other", false).unwrap();
            other.restore().unwrap();
        });
        let stalled = manager.clone();
        within("reading the stalled pane", move || {
            stalled.read("stalled", None).unwrap()
        });
        let stalled = manager.clone();
        let stopped = within("stopping the stalled pane", move || {
            stalled.stop("stalled").unwrap()
        });
        assert_eq!(stopped.status, "failed");
        let closing = manager.clone();
        within("closing every pane", move || {
            closing.close("stalled").unwrap();
            closing.close("other").unwrap();
        });
    }

    #[test]
    fn create_replaces_a_pane_and_restart_keeps_it_listed() {
        let manager = TerminalProcessManager::default();
        start(&manager, "pane", "printf first; exec sleep 30");
        wait_for_output(&manager, "pane", "first");
        let first = Arc::clone(&manager.pane("pane").unwrap());

        start(&manager, "pane", "printf second; exec sleep 30");
        assert!(
            lock_pane(&first).terminated,
            "the replaced process is reaped"
        );
        assert_eq!(manager.restore().unwrap().len(), 1);
        wait_for_output(&manager, "pane", "second");

        let before_restart = manager.pane("pane").unwrap();
        let restarted = manager.restart("pane").unwrap();
        assert_eq!(restarted.status, "running");
        assert!(lock_pane(&before_restart).terminated);
        assert!(!Arc::ptr_eq(
            &before_restart,
            &manager.pane("pane").unwrap()
        ));
        manager.close("pane").unwrap();
    }

    #[test]
    fn observe_skips_output_until_asked() {
        let manager = TerminalProcessManager::default();
        start(&manager, "observe", "printf observed; exec sleep 30");
        wait_for_output(&manager, "observe", "observed");
        let polled = manager.observe("observe", false).unwrap();
        assert!(polled.output.is_none());
        assert_eq!(polled.status, "running");
        let full = manager.observe("observe", true).unwrap();
        assert!(full.output.unwrap_or_default().contains("observed"));
        assert_eq!(full.output_revision, polled.output_revision);
        manager.close("observe").unwrap();
    }

    #[test]
    fn take_all_empties_the_manager_for_parallel_shutdown() {
        let manager = TerminalProcessManager::default();
        start(&manager, "a", "exec sleep 30");
        start(&manager, "b", "exec sleep 30");
        let panes = manager.take_all();
        assert_eq!(panes.len(), 2);
        assert!(manager.restore().unwrap().is_empty());
        let workers = panes
            .into_iter()
            .map(|pane| std::thread::spawn(move || terminate_terminal_pane(&pane)))
            .collect::<Vec<_>>();
        workers
            .into_iter()
            .for_each(|worker| worker.join().unwrap());
    }
}
