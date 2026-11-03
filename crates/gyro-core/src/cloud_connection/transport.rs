use super::CloudError;
use serde_json::Value;
use std::{io::Read, time::Duration};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Subscribe,
    Restore,
    Snapshot,
    CompleteCheckout,
    CancelRenewal,
    Expire,
    ManagedRequest,
    Revoke,
}
impl Operation {
    fn path(self) -> &'static str {
        match self {
            Self::Subscribe => "/mock/subscribe",
            Self::Restore => "/mock/restore",
            Self::Snapshot => "/v1/account/snapshot",
            Self::CompleteCheckout => "/mock/checkout/complete",
            Self::CancelRenewal => "/mock/subscription/cancel",
            Self::Expire => "/mock/subscription/expire",
            Self::ManagedRequest => "/mock/managed-request",
            Self::Revoke => "/v1/session/revoke",
        }
    }
}
pub trait Transport: Send + Sync {
    fn request(
        &self,
        operation: Operation,
        token: Option<&str>,
        body: Value,
    ) -> Result<Vec<u8>, CloudError>;
}

/// Only the debug constructor can produce a loopback transport. There is no
/// production endpoint, arbitrary URL, redirect, proxy or credential option.
pub struct LoopbackTransport {
    origin: String,
    agent: ureq::Agent,
}
impl LoopbackTransport {
    pub fn debug_port(port: u16) -> Result<Self, CloudError> {
        if !cfg!(debug_assertions) || port < 1024 {
            return Err(CloudError::NotConfigured);
        }
        Ok(Self {
            origin: format!("http://127.0.0.1:{port}"),
            agent: ureq::AgentBuilder::new()
                .redirects(0)
                .try_proxy_from_env(false)
                .timeout(Duration::from_secs(5))
                .timeout_connect(Duration::from_secs(2))
                .build(),
        })
    }
}
impl Transport for LoopbackTransport {
    fn request(
        &self,
        operation: Operation,
        token: Option<&str>,
        body: Value,
    ) -> Result<Vec<u8>, CloudError> {
        let mut request = self.agent.request(
            if operation == Operation::Snapshot {
                "GET"
            } else {
                "POST"
            },
            &format!("{}{}", self.origin, operation.path()),
        );
        request = request
            .set("Accept", "application/json")
            .set("Cache-Control", "no-store");
        if let Some(token) = token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        let response = if operation == Operation::Snapshot {
            request.call()
        } else {
            request.send_json(body)
        };
        let response = response.map_err(|e| match e {
            ureq::Error::Status(401, _) => CloudError::Authentication,
            ureq::Error::Status(404, _) if operation == Operation::Restore => {
                CloudError::MissingAccount
            }
            _ => CloudError::Unavailable,
        })?;
        if !(200..300).contains(&response.status())
            || response
                .header("Content-Type")
                .is_none_or(|s| !s.starts_with("application/json"))
            || response.header("Cache-Control") != Some("no-store")
        {
            return Err(CloudError::Protocol);
        }
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(32_769)
            .read_to_end(&mut bytes)
            .map_err(|_| CloudError::Unavailable)?;
        if bytes.len() > 32_768 {
            return Err(CloudError::Protocol);
        }
        Ok(bytes)
    }
}
