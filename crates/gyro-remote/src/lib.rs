//! Opt-in device networking. No provider credentials or execution engine live here.
pub mod control;
pub mod live_events;
pub mod protocol;
pub mod store;
pub mod transport;
pub use protocol::{Operation, RemoteEvent, Request, Response, ALPN};
