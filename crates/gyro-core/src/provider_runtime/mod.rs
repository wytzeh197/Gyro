#![deny(clippy::wildcard_imports)]
//! Shared provider execution contracts and host services.
pub mod accounting;
pub mod advisory;
pub mod api_config;
pub mod attachments;
pub mod codex_client;
pub mod codex_home;
mod codex_startup;
pub mod codex_turn_completion;
pub mod file_patch_counts;
pub mod host;
pub mod limits;
pub mod native_args;
pub mod prompts;
pub mod runners;
pub mod support;
pub mod text;
pub mod types;

pub mod catalog;

pub mod recovery;
pub mod reliability;

pub mod tool_batch;

pub mod context;
pub mod identity;

pub mod registry;

#[cfg(test)]
mod advisory_transport_tests;
