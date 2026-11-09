//! Scheduled automations: the Tauri commands, the in-process scheduler, and
//! the pieces one run is made of.

#![deny(clippy::wildcard_imports)]

pub(crate) mod commands;
pub(crate) mod execution;
pub(crate) mod runtime;
pub(crate) mod scheduler;
