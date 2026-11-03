use super::{AuthError, StagingConfig};
use serde_json::Value;
use std::{io::Read, time::Duration};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Operation {
    Code,
    Verify,
    Refresh,
    User,
    Logout,
}
impl Operation {
    fn path(self) -> &'static str {
        match self {
            Self::Code => "/otp",
            Self::Verify => "/verify",
            Self::Refresh => "/token?grant_type=refresh_token",
            Self::User => "/user",
            Self::Logout => "/logout?scope=local",
        }
    }
}
pub(crate) trait Transport: Send + Sync {
    fn request(
        &self,
        operation: Operation,
        token: Option<&str>,
        body: Value,
    ) -> Result<Vec<u8>, AuthError>;
}
pub(super) struct HttpTransport {
    origin: String,
    public_key: String,
    agent: ureq::Agent,
}
impl HttpTransport {
    pub(super) fn new(config: &StagingConfig) -> Self {
        Self {
            origin: config.issuer(),
            public_key: config.publishable_key.clone(),
            agent: ureq::AgentBuilder::new()
                .redirects(0)
                .try_proxy_from_env(false)
                .timeout(Duration::from_secs(5))
                .timeout_connect(Duration::from_secs(2))
                .build(),
        }
    }
}
impl Transport for HttpTransport {
    fn request(
        &self,
        operation: Operation,
        token: Option<&str>,
        body: Value,
    ) -> Result<Vec<u8>, AuthError> {
        let mut req = self
            .agent
            .request(
                if operation == Operation::User {
                    "GET"
                } else {
                    "POST"
                },
                &format!("{}{}", self.origin, operation.path()),
            )
            .set("apikey", &self.public_key)
            .set("Accept", "application/json")
            .set("Cache-Control", "no-store");
        if let Some(token) = token {
            req = req.set("Authorization", &format!("Bearer {token}"));
        }
        let response = if operation == Operation::User {
            req.call()
        } else {
            req.send_json(body)
        };
        // Never include upstream bodies, URLs, addresses or credentials in errors.
        let response = response.map_err(|e| match e {
            ureq::Error::Status(429, _) => AuthError::RateLimited,
            ureq::Error::Status(400 | 401 | 403 | 404 | 422, _) => AuthError::Rejected,
            _ => AuthError::Unavailable,
        })?;
        read_response(response, operation)
    }
}
pub(super) fn read_response(
    response: ureq::Response,
    operation: Operation,
) -> Result<Vec<u8>, AuthError> {
    if operation == Operation::Logout {
        return if response.status() == 204 {
            Ok(vec![])
        } else {
            Err(AuthError::Protocol)
        };
    }
    if response.status() != 200
        || response.header("Content-Type").is_none_or(|v| {
            !v.split(';')
                .next()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
        })
    {
        return Err(AuthError::Protocol);
    }
    let mut bytes = vec![];
    response
        .into_reader()
        .take(32_769)
        .read_to_end(&mut bytes)
        .map_err(|_| AuthError::Unavailable)?;
    if bytes.len() > 32_768 {
        return Err(AuthError::Protocol);
    }
    Ok(bytes)
}
