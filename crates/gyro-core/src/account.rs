use crate::{
    config::{AccountOidcConfig, AccountSessionState, GyroConfig},
    keychain,
    paths::GyroPaths,
    run_command, CancellationToken, ExecutionRequest,
};
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::{Duration, Instant},
};
use url::{form_urlencoded, Url};

const TOKEN_ACCESS: &str = "access-token";
const TOKEN_REFRESH: &str = "refresh-token";
const TOKEN_ID: &str = "id-token";
const REMOTE_OIDC_DISABLED_MESSAGE: &str = "remote OIDC access is disabled until Gyro verifies ID token signatures against the issuer JWKS";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PkceFlow {
    pub state: String,
    pub nonce: String,
    pub verifier: String,
    pub challenge: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct OidcDiscovery {
    authorization_endpoint: String,
    token_endpoint: String,
}

#[derive(Clone, Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
struct IdTokenClaims {
    iss: String,
    sub: String,
    exp: i64,
    email: Option<String>,
    name: Option<String>,
    picture: Option<String>,
}

pub fn token_storage_key(kind: &str) -> String {
    format!("account:oidc:{kind}")
}

pub fn generate_pkce_flow() -> PkceFlow {
    let verifier = random_urlsafe(32);
    let state = random_urlsafe(24);
    let nonce = random_urlsafe(24);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    PkceFlow {
        state,
        nonce,
        verifier,
        challenge,
    }
}

pub fn stored_account_session(paths: &GyroPaths) -> Result<AccountSessionState> {
    let config = GyroConfig::load(paths)?;
    ensure_oidc_configured(&config.account_oidc)?;
    if is_local_device_access(&config.account_oidc) && config.account_session.signed_in {
        return Ok(config.account_session);
    }

    if config.account_session.signed_in
        && keychain::get_api_key(&token_storage_key(TOKEN_ID))?.is_some()
    {
        Ok(config.account_session)
    } else {
        Ok(AccountSessionState::default())
    }
}

pub fn start_account_login(paths: &GyroPaths) -> Result<AccountSessionState> {
    let config = GyroConfig::load(paths)?;
    let oidc = config.account_oidc.clone();
    ensure_oidc_configured(&oidc)?;

    if is_local_device_access(&oidc) {
        return authorize_local_device(paths);
    }

    let discovery = discover_oidc(&oidc)?;
    let listener = TcpListener::bind(loopback_bind_addr(&oidc)?)
        .context("bind local OAuth callback listener")?;
    let callback_port = listener.local_addr()?.port();
    let redirect_uri = loopback_redirect_uri(&oidc, callback_port)?;
    let flow = generate_pkce_flow();
    let authorize_url = authorize_url(&oidc, &discovery, &redirect_uri, &flow)?;

    open_system_browser(authorize_url.as_str())?;
    let callback = wait_for_callback(listener, &flow.state)?;
    let token_response = exchange_code(
        &discovery.token_endpoint,
        &oidc,
        &redirect_uri,
        &flow,
        &callback.code,
    )?;
    let id_token = token_response
        .id_token
        .as_deref()
        .ok_or_else(|| anyhow!("OIDC token response did not include an id_token"))?;
    let claims = validate_id_token_claims(id_token, &oidc, Some(&flow.nonce))?;
    store_tokens(&token_response, None)?;

    let session = session_from_claims(&claims, &token_response);
    GyroConfig::update(paths, |config| {
        config.account_session = session.clone();
        Ok(())
    })?;
    Ok(session)
}

pub fn refresh_account_session(paths: &GyroPaths) -> Result<AccountSessionState> {
    let config = GyroConfig::load(paths)?;
    let oidc = config.account_oidc.clone();
    ensure_oidc_configured(&oidc)?;

    if is_local_device_access(&oidc) {
        return Ok(config.account_session);
    }

    let Some(refresh_token) = keychain::get_api_key(&token_storage_key(TOKEN_REFRESH))? else {
        let session = AccountSessionState::default();
        GyroConfig::update(paths, |config| {
            config.account_session = session.clone();
            Ok(())
        })?;
        return Ok(session);
    };

    let discovery = discover_oidc(&oidc)?;
    let token_response = refresh_tokens(&discovery.token_endpoint, &oidc, &refresh_token)?;
    let id_token = token_response
        .id_token
        .as_deref()
        .ok_or_else(|| anyhow!("OIDC refresh response did not include an id_token"))?;
    let claims = validate_id_token_claims(id_token, &oidc, None)?;
    store_tokens(&token_response, Some(&refresh_token))?;

    let session = session_from_claims(&claims, &token_response);
    GyroConfig::update(paths, |config| {
        config.account_session = session.clone();
        Ok(())
    })?;
    Ok(session)
}

pub fn logout_account(paths: &GyroPaths) -> Result<AccountSessionState> {
    let config = GyroConfig::load(paths)?;
    if !is_local_device_access(&config.account_oidc) {
        for kind in [TOKEN_ACCESS, TOKEN_REFRESH, TOKEN_ID] {
            keychain::delete_api_key(&token_storage_key(kind))?;
        }
    }
    let session = AccountSessionState::default();
    GyroConfig::update(paths, |config| {
        config.account_session = session.clone();
        Ok(())
    })?;
    Ok(session)
}

fn ensure_oidc_configured(config: &AccountOidcConfig) -> Result<()> {
    if config.issuer_url.trim().is_empty()
        || config.client_id.trim().is_empty()
        || config.redirect_loopback_base.trim().is_empty()
    {
        bail!("Gyro local access is missing issuer, client ID, or loopback redirect config");
    }
    if is_local_device_access(config) {
        return Ok(());
    }

    validate_remote_oidc_security_assumptions(config)?;
    bail!(REMOTE_OIDC_DISABLED_MESSAGE)
}

fn is_local_device_access(config: &AccountOidcConfig) -> bool {
    config.issuer_url.trim_end_matches('/') == "local-device://gyro"
        && config.client_id == "gyro-local-device"
}

fn authorize_local_device(paths: &GyroPaths) -> Result<AccountSessionState> {
    let session = AccountSessionState {
        signed_in: true,
        user_id: Some("local-device".into()),
        email: None,
        name: Some("This Mac".into()),
        avatar_url: None,
        issuer: Some("local-device://gyro".into()),
        expires_at: Utc::now()
            .checked_add_signed(chrono::Duration::days(30))
            .map(|value| value.to_rfc3339()),
    };
    GyroConfig::update(paths, |config| {
        config.account_session = session.clone();
        Ok(())
    })?;
    Ok(session)
}

fn discover_oidc(config: &AccountOidcConfig) -> Result<OidcDiscovery> {
    let discovery_url = issuer_url(config)?.join(".well-known/openid-configuration")?;
    ureq::get(discovery_url.as_str())
        .call()
        .map_err(|error| anyhow!("OIDC discovery failed: {error}"))?
        .into_json()
        .context("parse OIDC discovery response")
}

fn authorize_url(
    config: &AccountOidcConfig,
    discovery: &OidcDiscovery,
    redirect_uri: &str,
    flow: &PkceFlow,
) -> Result<Url> {
    let mut url = secure_https_url(
        "OIDC authorization endpoint",
        &discovery.authorization_endpoint,
    )?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", &config.scopes.join(" "))
        .append_pair("state", &flow.state)
        .append_pair("nonce", &flow.nonce)
        .append_pair("code_challenge", &flow.challenge)
        .append_pair("code_challenge_method", "S256");
    Ok(url)
}

fn exchange_code(
    token_endpoint: &str,
    config: &AccountOidcConfig,
    redirect_uri: &str,
    flow: &PkceFlow,
    code: &str,
) -> Result<TokenResponse> {
    let body = form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "authorization_code")
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("code_verifier", &flow.verifier)
        .append_pair("code", code)
        .finish();
    post_token_request(token_endpoint, &body)
}

fn refresh_tokens(
    token_endpoint: &str,
    config: &AccountOidcConfig,
    refresh_token: &str,
) -> Result<TokenResponse> {
    let body = form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "refresh_token")
        .append_pair("client_id", &config.client_id)
        .append_pair("refresh_token", refresh_token)
        .finish();
    post_token_request(token_endpoint, &body)
}

fn post_token_request(token_endpoint: &str, body: &str) -> Result<TokenResponse> {
    let token_endpoint = secure_https_url("OIDC token endpoint", token_endpoint)?;
    ureq::post(token_endpoint.as_str())
        .set("content-type", "application/x-www-form-urlencoded")
        .send_string(body)
        .map_err(|error| anyhow!("OIDC token request failed: {error}"))?
        .into_json()
        .context("parse OIDC token response")
}

fn store_tokens(response: &TokenResponse, fallback_refresh_token: Option<&str>) -> Result<()> {
    if let Some(access_token) = response.access_token.as_deref() {
        keychain::set_api_key(&token_storage_key(TOKEN_ACCESS), access_token)?;
    }
    if let Some(id_token) = response.id_token.as_deref() {
        keychain::set_api_key(&token_storage_key(TOKEN_ID), id_token)?;
    }
    if let Some(refresh_token) = response.refresh_token.as_deref().or(fallback_refresh_token) {
        keychain::set_api_key(&token_storage_key(TOKEN_REFRESH), refresh_token)?;
    }
    Ok(())
}

fn validate_id_token_claims(
    id_token: &str,
    config: &AccountOidcConfig,
    expected_nonce: Option<&str>,
) -> Result<IdTokenClaims> {
    let _ = (id_token, config, expected_nonce);
    bail!(REMOTE_OIDC_DISABLED_MESSAGE)
}

fn session_from_claims(claims: &IdTokenClaims, response: &TokenResponse) -> AccountSessionState {
    let expires_at = response
        .expires_in
        .and_then(|expires_in| Utc::now().checked_add_signed(chrono::Duration::seconds(expires_in)))
        .or_else(|| chrono::DateTime::from_timestamp(claims.exp, 0))
        .map(|value| value.to_rfc3339());

    AccountSessionState {
        signed_in: true,
        user_id: Some(claims.sub.clone()),
        email: claims.email.clone(),
        name: claims.name.clone(),
        avatar_url: claims.picture.clone(),
        issuer: Some(claims.iss.clone()),
        expires_at,
    }
}

fn wait_for_callback(listener: TcpListener, expected_state: &str) -> Result<OAuthCallback> {
    listener.set_nonblocking(true)?;
    listener
        .set_ttl(64)
        .context("configure OAuth callback listener")?;
    let started_at = Instant::now();
    let (mut stream, _) = loop {
        match listener.accept() {
            Ok(value) => break value,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if started_at.elapsed() > Duration::from_secs(120) {
                    bail!("timed out waiting for browser sign-in callback");
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error).context("wait for OAuth callback from browser"),
        }
    };
    stream.set_read_timeout(Some(Duration::from_secs(120)))?;
    let mut buffer = [0_u8; 8192];
    let count = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..count]);
    let callback = parse_callback_request(&request, expected_state);
    let response = match &callback {
        Ok(_) => {
            "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\n\r\n<html><body><h1>Gyro sign-in complete</h1><p>You can return to Gyro.</p></body></html>"
        }
        Err(_) => {
            "HTTP/1.1 400 Bad Request\r\ncontent-type: text/html; charset=utf-8\r\n\r\n<html><body><h1>Gyro sign-in failed</h1><p>You can close this tab and try again.</p></body></html>"
        }
    };
    let _ = stream.write_all(response.as_bytes());
    callback
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OAuthCallback {
    code: String,
}

fn parse_callback_request(request: &str, expected_state: &str) -> Result<OAuthCallback> {
    let first_line = request
        .lines()
        .next()
        .ok_or_else(|| anyhow!("OAuth callback request was empty"))?;
    let path = first_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| anyhow!("OAuth callback request was malformed"))?;
    let url = Url::parse(&format!("http://127.0.0.1{path}"))?;
    let params = url.query_pairs().collect::<Vec<_>>();
    let state = params
        .iter()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.to_string())
        .ok_or_else(|| anyhow!("OAuth callback was missing state"))?;
    if state != expected_state {
        bail!("OAuth callback state did not match login request");
    }
    if let Some(error) = params
        .iter()
        .find(|(key, _)| key == "error")
        .map(|(_, value)| value.to_string())
    {
        bail!("OAuth provider returned error: {error}");
    }
    let code = params
        .iter()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.to_string())
        .ok_or_else(|| anyhow!("OAuth callback was missing authorization code"))?;
    Ok(OAuthCallback { code })
}

fn loopback_bind_addr(config: &AccountOidcConfig) -> Result<String> {
    let url = validate_loopback_redirect_base(&config.redirect_loopback_base)?;
    let host = url
        .host_str()
        .filter(|host| *host == "127.0.0.1" || *host == "localhost")
        .ok_or_else(|| anyhow!("OAuth loopback redirect must use 127.0.0.1 or localhost"))?;
    Ok(format!("{host}:0"))
}

fn loopback_redirect_uri(config: &AccountOidcConfig, port: u16) -> Result<String> {
    let mut url = validate_loopback_redirect_base(&config.redirect_loopback_base)?;
    url.set_port(Some(port))
        .map_err(|_| anyhow!("OAuth loopback redirect base cannot use this port"))?;
    url.set_path("callback");
    Ok(url.to_string())
}

fn issuer_url(config: &AccountOidcConfig) -> Result<Url> {
    let mut url = secure_https_url("OIDC issuer", &config.issuer_url)?;
    if url.query().is_some() {
        bail!("OIDC issuer URL cannot include a query");
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

fn validate_remote_oidc_security_assumptions(config: &AccountOidcConfig) -> Result<()> {
    issuer_url(config)?;
    validate_loopback_redirect_base(&config.redirect_loopback_base)?;
    Ok(())
}

fn secure_https_url(label: &str, value: &str) -> Result<Url> {
    let url = Url::parse(value).with_context(|| format!("parse {label}"))?;
    if url.scheme() != "https" || url.host_str().is_none() {
        bail!("{label} must use HTTPS and include a host");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("{label} cannot include user information");
    }
    if url.fragment().is_some() {
        bail!("{label} cannot include a fragment");
    }
    Ok(url)
}

fn validate_loopback_redirect_base(value: &str) -> Result<Url> {
    let url = Url::parse(value).context("parse OAuth loopback redirect base")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("OAuth loopback redirect base must use http or https");
    }
    let loopback_host = url
        .host_str()
        .is_some_and(|host| host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost"));
    if !loopback_host {
        bail!("OAuth loopback redirect must use 127.0.0.1 or localhost");
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("OAuth loopback redirect base cannot include credentials, a query, or a fragment");
    }
    if !matches!(url.path(), "" | "/") {
        bail!("OAuth loopback redirect base cannot include a path");
    }
    Ok(url)
}

fn open_system_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "windows")]
    let program = "explorer.exe";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";

    let mut request = ExecutionRequest::new(program);
    request.args.push(url.into());
    request.timeout = Duration::from_secs(15);
    request.max_stdout_chars = 4 * 1024;
    request.max_stderr_chars = 8 * 1024;
    let outcome = run_command(request, CancellationToken::default(), |_| {})
        .context("open system browser for Gyro access")?;
    if outcome.succeeded() {
        Ok(())
    } else {
        bail!("open browser command ended with {:?}", outcome.termination)
    }
}

fn random_urlsafe(byte_count: usize) -> String {
    let mut bytes = vec![0_u8; byte_count];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_oidc_config() -> AccountOidcConfig {
        AccountOidcConfig {
            issuer_url: "https://auth.example.com/".into(),
            client_id: "gyro-test".into(),
            redirect_loopback_base: "http://127.0.0.1".into(),
            scopes: vec!["openid".into(), "profile".into(), "email".into()],
        }
    }

    fn unsigned_id_token(payload: serde_json::Value) -> String {
        format!(
            "{}.{}.",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
        )
    }

    #[test]
    fn pkce_flow_has_s256_challenge_and_state() {
        let flow = generate_pkce_flow();
        assert!(flow.verifier.len() >= 43);
        assert!(flow.state.len() >= 32);
        assert_ne!(flow.state, flow.nonce);
        assert_eq!(
            flow.challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(flow.verifier.as_bytes()))
        );
    }

    #[test]
    fn callback_parser_requires_matching_state() {
        let request = "GET /callback?code=abc&state=expected HTTP/1.1\r\n\r\n";
        assert_eq!(
            parse_callback_request(request, "expected").unwrap(),
            OAuthCallback { code: "abc".into() }
        );
        assert!(parse_callback_request(request, "different").is_err());
    }

    #[test]
    fn token_storage_names_are_account_scoped() {
        assert_eq!(
            token_storage_key("refresh-token"),
            "account:oidc:refresh-token"
        );
    }

    #[test]
    fn local_device_access_does_not_require_keychain_tokens() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let session = start_account_login(&paths).unwrap();
        assert!(session.signed_in);
        assert_eq!(session.issuer.as_deref(), Some("local-device://gyro"));

        let stored = stored_account_session(&paths).unwrap();
        assert!(stored.signed_in);

        let refreshed = refresh_account_session(&paths).unwrap();
        assert!(refreshed.signed_in);

        let logged_out = logout_account(&paths).unwrap();
        assert!(!logged_out.signed_in);
    }

    #[test]
    fn unsigned_and_tampered_id_tokens_are_rejected() {
        let payload = serde_json::json!({
            "iss": "https://auth.example.com/",
            "sub": "user_123",
            "aud": "gyro-test",
            "exp": Utc::now().timestamp() + 60,
            "nonce": "nonce-1"
        });
        let unsigned = unsigned_id_token(payload.clone());
        let error =
            validate_id_token_claims(&unsigned, &test_oidc_config(), Some("nonce-1")).unwrap_err();
        assert!(error.to_string().contains("issuer JWKS"));

        let signed_shape_with_invalid_signature = format!(
            "{}.{}.tampered-signature",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","kid":"test"}"#),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
        );
        let error = validate_id_token_claims(
            &signed_shape_with_invalid_signature,
            &test_oidc_config(),
            Some("nonce-1"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("issuer JWKS"));
    }

    #[test]
    fn remote_oidc_session_login_and_refresh_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let paths = GyroPaths::from_base_dir(temp.path().join("Gyro"));
        let mut config = GyroConfig {
            account_oidc: test_oidc_config(),
            ..GyroConfig::default()
        };
        config.account_session.signed_in = true;
        config.account_session.user_id = Some("unverified-user".into());
        config.save(&paths).unwrap();

        for result in [
            stored_account_session(&paths),
            start_account_login(&paths),
            refresh_account_session(&paths),
        ] {
            let error = result.unwrap_err();
            assert!(error.to_string().contains("issuer JWKS"));
        }
    }

    #[test]
    fn remote_oidc_requires_https_and_a_strict_loopback_redirect() {
        let mut config = test_oidc_config();
        config.issuer_url = "http://auth.example.com".into();
        let error = ensure_oidc_configured(&config).unwrap_err();
        assert!(error.to_string().contains("must use HTTPS"));

        config.issuer_url = "https://auth.example.com".into();
        config.redirect_loopback_base = "http://localhost.evil.example".into();
        let error = ensure_oidc_configured(&config).unwrap_err();
        assert!(error.to_string().contains("127.0.0.1 or localhost"));
    }
}
