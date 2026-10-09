//! Crash cleanup for provider children. Main binaries enable the helper before
//! starting their runtime; library embedders must supply that same entrypoint.
use std::{
    fs::File,
    process::{Child, Command},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

static ENABLED: AtomicBool = AtomicBool::new(false);
pub fn enable_crash_cleanup() {
    ENABLED.store(true, Ordering::Relaxed);
}
pub fn crash_cleanup_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}
pub fn run_crash_helper() -> Option<i32> {
    #[cfg(target_os = "macos")]
    return macos::run_entrypoint();
    #[cfg(not(target_os = "macos"))]
    None
}

pub struct GuardedChild {
    child: Child,
    #[cfg(target_os = "macos")]
    watchdog: Option<(Arc<macos::Watchdog>, u64)>,
}
impl std::ops::Deref for GuardedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}
impl std::ops::DerefMut for GuardedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}
impl Drop for GuardedChild {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some((watchdog, generation)) = self.watchdog.take() {
            if watchdog
                .release(self.child.id() as i32, generation)
                .is_err()
                && self.child.try_wait().ok().flatten().is_none()
            {
                crate::execution::terminate_process_group(&mut self.child);
            }
            let _ = self.child.wait();
        }
    }
}

pub fn spawn_guarded(command: &mut Command) -> std::io::Result<GuardedChild> {
    #[cfg(target_os = "macos")]
    if ENABLED.load(Ordering::Relaxed) {
        let owner = OWNER_SCOPE
            .with(|slot| slot.borrow().clone())
            .unwrap_or_else(ProcessOwner::unleased);
        return spawn_with_owner(command, &owner);
    }
    Ok(GuardedChild {
        child: command.spawn()?,
        #[cfg(target_os = "macos")]
        watchdog: None,
    })
}

/// Persistent app services outlive a model turn. Give them independent crash
/// cleanup without retaining the triggering turn's lease or command registry.
pub fn spawn_service(command: &mut Command) -> std::io::Result<GuardedChild> {
    spawn_service_with_cleanup(command, crash_cleanup_enabled())
}
fn spawn_service_with_cleanup(
    command: &mut Command,
    enabled: bool,
) -> std::io::Result<GuardedChild> {
    let scope = ProcessLeaseScope::unleased();
    #[cfg(target_os = "macos")]
    if enabled {
        return spawn_with_owner(command, &scope.owner());
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (scope, enabled);
    Ok(GuardedChild {
        child: command.spawn()?,
        #[cfg(target_os = "macos")]
        watchdog: None,
    })
}
#[cfg(target_os = "macos")]
fn spawn_with_owner(command: &mut Command, owner: &ProcessOwner) -> std::io::Result<GuardedChild> {
    let watchdog = owner.watchdog()?;
    let (child, generation) = watchdog.spawn(command)?;
    Ok(GuardedChild {
        child,
        watchdog: Some((watchdog, generation)),
    })
}

/// Shared by a model runner and its authenticated capability worker threads.
/// Each owner lazily starts one watchdog, retaining the same lease through all
/// registrations; separate runs never share helpers or lock ownership.
#[derive(Clone)]
pub struct ProcessOwner(Arc<OwnerState>);
struct OwnerState {
    lease: Option<Arc<File>>,
    #[cfg(target_os = "macos")]
    watchdog: std::sync::Mutex<Option<Arc<macos::Watchdog>>>,
}
impl ProcessOwner {
    fn unleased() -> Self {
        Self::new(None)
    }
    fn new(lease: Option<Arc<File>>) -> Self {
        Self(Arc::new(OwnerState {
            lease,
            #[cfg(target_os = "macos")]
            watchdog: std::sync::Mutex::new(None),
        }))
    }
    pub fn enter(&self) -> ProcessLeaseScope {
        let previous = OWNER_SCOPE.with(|slot| slot.replace(Some(self.clone())));
        ProcessLeaseScope {
            previous,
            owner: self.clone(),
            _thread: std::marker::PhantomData,
        }
    }
    #[cfg(target_os = "macos")]
    fn watchdog(&self) -> std::io::Result<Arc<macos::Watchdog>> {
        let mut slot = self
            .0
            .watchdog
            .lock()
            .map_err(|_| std::io::Error::other("process watchdog state unavailable"))?;
        if slot.is_none() {
            *slot = Some(macos::Watchdog::start(self.0.lease.as_deref())?);
        }
        Ok(slot.as_ref().unwrap().clone())
    }
}
thread_local! {
    static OWNER_SCOPE: std::cell::RefCell<Option<ProcessOwner>> = const { std::cell::RefCell::new(None) };
}
pub struct ProcessLeaseScope {
    previous: Option<ProcessOwner>,
    owner: ProcessOwner,
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}
impl ProcessLeaseScope {
    pub fn bind(file: &File) -> std::io::Result<Self> {
        Ok(ProcessOwner::new(Some(Arc::new(file.try_clone()?))).enter())
    }
    pub fn unleased() -> Self {
        ProcessOwner::unleased().enter()
    }
    pub fn owner(&self) -> ProcessOwner {
        self.owner.clone()
    }
}
impl Drop for ProcessLeaseScope {
    fn drop(&mut self) {
        OWNER_SCOPE.with(|slot| {
            slot.replace(self.previous.take());
        });
    }
}
#[cfg(target_os = "macos")]
mod macos;
