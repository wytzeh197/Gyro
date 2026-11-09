use anyhow::{anyhow, bail, ensure, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, AeadCore, OsRng, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use gyro_core::{
    paths::GyroPaths,
    sessions::{SessionEventKind, SessionStore},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use url::Url;
use uuid::Uuid;

const MAX_CIPHER: usize = 16 * 1024 * 1024;
const MAX_ARCHIVE: usize = 64 * 1024 * 1024;
const VERSION: u8 = 1;
type Key = [u8; 32];

#[derive(Default)]
struct State {
    login: Option<Login>,
    pending: Option<Key>,
}

struct Login {
    account: String,
    token: String,
}

static STATE: Mutex<State> = Mutex::new(State {
    login: None,
    pending: None,
});

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Archive {
    version: u8,
    title: String,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    model: Option<String>,
    messages: Vec<Message>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    kind: MessageKind,
    text: String,
    timestamp: chrono::DateTime<chrono::Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum MessageKind {
    User,
    Assistant,
    Tool,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    id: Uuid,
    etag: String,
    title: String,
    digest: String,
    #[serde(
        default,
        rename = "uploadedAt",
        skip_serializing_if = "Option::is_none"
    )]
    uploaded_at: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Page {
    items: Vec<Entry>,
    cursor: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Receipt {
    etag: String,
    archive_digest: String,
}

#[derive(Serialize, Deserialize)]
struct PendingUpload {
    expected: Option<String>,
    archive_digest: String,
    title: String,
}

fn read_pending(path: &Path) -> Option<(PendingUpload, Vec<u8>)> {
    let mut reader = BufReader::new(std::fs::File::open(path).ok()?);
    let mut metadata = String::new();
    (&mut reader).take(4096).read_line(&mut metadata).ok()?;
    if !metadata.ends_with('\n') {
        return None;
    }
    let metadata = serde_json::from_str(&metadata).ok()?;
    let mut payload = Vec::new();
    reader
        .take(MAX_CIPHER as u64 + 1)
        .read_to_end(&mut payload)
        .ok()?;
    (42..=MAX_CIPHER)
        .contains(&payload.len())
        .then_some((metadata, payload))
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Action {
    Status,
    SendCode {
        email: String,
    },
    SignIn {
        email: String,
        proof: String,
    },
    SignUp {
        name: String,
        email: String,
        password: String,
    },
    PasswordSignIn {
        email: String,
        password: String,
    },
    SendPasswordReset {
        email: String,
    },
    ResetPassword {
        email: String,
        proof: String,
        password: String,
    },
    ChangePassword {
        password: String,
    },
    ResendConfirmation {
        email: String,
    },
    SignOut,
    UpdateProfile {
        display_name: String,
    },
    Generate,
    Confirm,
    Recover {
        code: String,
    },
    List {
        cursor: Option<String>,
    },
    Upload {
        id: Uuid,
        replace: Option<String>,
    },
    Download {
        id: Uuid,
    },
    Delete {
        id: Uuid,
    },
    Open {
        id: Uuid,
    },
    History,
}

fn https(value: &str) -> Result<Url> {
    let url = Url::parse(value)?;
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none(),
        "Gyro Cloud requires a secure HTTPS endpoint."
    );
    Ok(url)
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(Duration::from_secs(45))
        .build()
}

fn code() -> Key {
    XChaCha20Poly1305::generate_key(&mut OsRng).into()
}

fn read_json<T: serde::de::DeserializeOwned>(response: ureq::Response) -> Result<T> {
    Ok(serde_json::from_reader(
        response.into_reader().take(1024 * 1024),
    )?)
}

const STAGING_ISSUER: &str = "https://hqyahsvqjizmsfxclxzd.supabase.co/auth/v1";
const STAGING_PUBLIC_KEY: &str = "sb_publishable_NKcgdQHudtPow-IGRu-1jw_QRrIoANs";
const STAGING_API: &str = "https://gyro-cloud-staging.wytzebusiness.workers.dev";

fn auth_request(method: &str, path: &str) -> ureq::Request {
    agent()
        .request(method, &format!("{STAGING_ISSUER}/{path}"))
        .set("apikey", STAGING_PUBLIC_KEY)
}

fn check_email(email: &str) -> Result<()> {
    ensure!(
        email.len() <= 254
            && email
                .split_once('@')
                .is_some_and(|(local, domain)| !local.is_empty()
                    && domain.contains('.')
                    && !domain.contains('@'))
            && !email.chars().any(|c| c.is_whitespace() || c.is_control()),
        "Enter a valid email address."
    );
    Ok(())
}

fn email_proof(email: &str, proof: &str) -> Result<serde_json::Value> {
    proof_body(email, proof, "email", &["email", "magiclink", "signup"])
}

fn recovery_proof(email: &str, proof: &str) -> Result<serde_json::Value> {
    proof_body(email, proof, "recovery", &["recovery"])
}

fn proof_body(
    email: &str,
    proof: &str,
    otp_type: &str,
    link_types: &[&str],
) -> Result<serde_json::Value> {
    use serde_json::json;
    let proof = proof.trim();
    if matches!(proof.len(), 6 | 8) && proof.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(json!({ "email": email, "token": proof, "type": otp_type }));
    }
    ensure!(
        proof.len() <= 4096,
        "Paste the link from the email, or enter its code."
    );
    let link = Url::parse(proof)
        .map_err(|_| anyhow!("Paste the link from the email, or enter its code."))?;
    ensure!(
        link.origin() == Url::parse(STAGING_ISSUER)?.origin()
            && link.path() == "/auth/v1/verify"
            && link.username().is_empty()
            && link.password().is_none()
            && link.fragment().is_none(),
        "Use the link from the most recent email."
    );
    let mut fields = std::collections::BTreeMap::new();
    for (name, value) in link.query_pairs() {
        ensure!(
            matches!(
                name.as_ref(),
                "token" | "token_hash" | "type" | "redirect_to"
            ) && fields
                .insert(name.into_owned(), value.into_owned())
                .is_none(),
            "That link isn’t a Gyro sign-in link."
        );
    }
    let hash = match (fields.get("token"), fields.get("token_hash")) {
        (Some(hash), None) | (None, Some(hash)) => hash,
        _ => bail!("That link isn’t a Gyro sign-in link."),
    };
    ensure!(
        fields
            .get("type")
            .is_some_and(|kind| link_types.contains(&kind.as_str()))
            && (20..=512).contains(&hash.len())
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)),
        "That link isn’t a Gyro sign-in link."
    );
    Ok(json!({ "token_hash": hash, "type": otp_type }))
}

#[derive(Deserialize)]
struct AuthUser {
    email: String,
    email_confirmed_at: Option<chrono::DateTime<chrono::Utc>>,
    role: String,
    is_anonymous: bool,
}

#[derive(Deserialize)]
struct AuthToken {
    access_token: String,
    user: AuthUser,
}

fn sign_in(email: &str, proof: &str) -> Result<Login> {
    check_email(email)?;
    let response = auth_request("POST", "verify")
        .send_json(email_proof(email, proof)?)
        .map_err(auth_failure)?;
    finish_login(email, read_json(response)?)
}

fn finish_login(email: &str, session: AuthToken) -> Result<Login> {
    let AuthToken {
        access_token: token,
        user,
    } = session;
    ensure!(
        user.email.eq_ignore_ascii_case(email)
            && user.email_confirmed_at.is_some()
            && user.role == "authenticated"
            && !user.is_anonymous,
        "Confirm your email, then sign in."
    );
    #[derive(Deserialize)]
    struct Account {
        account: String,
    }
    let response = request(&token, "GET", "/v1/account")?
        .call()
        .map_err(http_error)?;
    let account = read_json::<Account>(response)?.account;
    ensure!(is_digest(&account), "Invalid Gyro Cloud account.");
    Ok(Login { account, token })
}

fn check_password(password: &str) -> Result<()> {
    ensure!(
        password.chars().count() >= 8,
        "Use a password of at least 8 characters."
    );
    // The account service hashes with bcrypt, which ignores bytes past 72.
    ensure!(password.len() <= 72, "Use a password of up to 72 bytes.");
    Ok(())
}

fn auth_failure_message(status: u16, error_code: Option<&str>) -> &'static str {
    match (status, error_code) {
        (_, Some("invalid_credentials")) => {
            "That email and password don’t match. Never set a password? Email yourself a code instead."
        }
        (_, Some("email_not_confirmed")) => "Confirm your email first, then sign in.",
        (_, Some("otp_disabled")) => "No account uses this email yet. Create one first.",
        (_, Some("user_already_exists" | "email_exists")) => {
            "An account with this email already exists. Sign in instead."
        }
        (_, Some("weak_password")) => "Choose a stronger password.",
        (_, Some("same_password")) => "That’s already your password.",
        (_, Some("reauthentication_needed" | "reauthentication_not_valid")) => {
            "Sign out and back in, then change your password."
        }
        (_, Some("otp_expired")) => "That link or code is wrong or expired. Request a new one.",
        (401, _) => SIGN_IN_EXPIRED,
        (_, Some("signup_disabled" | "email_provider_disabled")) => {
            "New Gyro accounts aren’t open right now."
        }
        (429, _) | (_, Some("over_request_rate_limit" | "over_email_send_rate_limit")) => {
            "Too many attempts. Wait a moment and try again."
        }
        (400 | 422, _) => "Gyro Account couldn’t accept that. Check what you entered and try again.",
        _ => "Couldn’t reach Gyro Account. Try again.",
    }
}

fn auth_failure_parts(error: ureq::Error) -> (u16, Option<String>) {
    let ureq::Error::Status(status, response) = error else {
        return (0, None);
    };
    let body: serde_json::Value = read_json(response).unwrap_or_default();
    (status, body["error_code"].as_str().map(str::to_owned))
}

fn auth_failure(error: ureq::Error) -> anyhow::Error {
    let (status, code) = auth_failure_parts(error);
    anyhow!(auth_failure_message(status, code.as_deref()))
}

fn set_password(login: &Login, password: &str) -> std::result::Result<(), (u16, Option<String>)> {
    auth_request("PUT", "user")
        .set("Authorization", &format!("Bearer {}", login.token))
        .send_json(serde_json::json!({ "password": password }))
        .map(|_| ())
        .map_err(auth_failure_parts)
}

/// The emailed proof is spent once verified, so a password the account service
/// refuses afterwards is reported beside the new login rather than failing it.
fn reset_password(email: &str, proof: &str, password: &str) -> Result<(Login, Option<String>)> {
    check_email(email)?;
    check_password(password)?;
    let response = auth_request("POST", "verify")
        .send_json(recovery_proof(email, proof)?)
        .map_err(auth_failure)?;
    let login = finish_login(email, read_json(response)?)?;
    let refused = match set_password(&login, password) {
        Err((_, Some(code))) if code == "same_password" => None,
        Err((status, code)) => Some(format!(
            "You’re signed in, but your password didn’t change. {}",
            auth_failure_message(status, code.as_deref())
        )),
        Ok(()) => None,
    };
    Ok((login, refused))
}

/// No login means the account exists but has not confirmed its email yet.
fn sign_in_with_password(email: &str, password: &str) -> Result<Option<Login>> {
    check_email(email)?;
    let response = match auth_request("POST", "token?grant_type=password")
        .send_json(serde_json::json!({ "email": email, "password": password }))
    {
        Ok(response) => response,
        Err(error) => {
            let (status, code) = auth_failure_parts(error);
            if code.as_deref() == Some("email_not_confirmed") {
                return Ok(None);
            }
            bail!(auth_failure_message(status, code.as_deref()));
        }
    };
    finish_login(email, read_json(response)?).map(Some)
}

enum SignUp {
    Session(Box<AuthToken>),
    ConfirmationRequired,
    AccountExists,
}

/// With email confirmation on, a repeat sign-up looks like success so the
/// service does not reveal who has an account: no session, no email sent, and
/// a user with no identities. Sending it to the confirm step would strand them.
fn classify_sign_up(body: serde_json::Value) -> Result<SignUp> {
    if body.get("access_token").is_some() {
        return Ok(SignUp::Session(Box::new(serde_json::from_value(body)?)));
    }
    let identities = body
        .get("identities")
        .or_else(|| body.get("user").and_then(|user| user.get("identities")))
        .and_then(serde_json::Value::as_array);
    Ok(if identities.is_some_and(Vec::is_empty) {
        SignUp::AccountExists
    } else {
        SignUp::ConfirmationRequired
    })
}

fn sign_up(name: &str, email: &str, password: &str) -> Result<SignUp> {
    let name = validate_display_name(name)?;
    ensure!(!name.is_empty(), "Enter your name.");
    check_email(email)?;
    check_password(password)?;
    let response = match auth_request("POST", "signup").send_json(serde_json::json!({
        "email": email,
        "password": password,
        "data": { "display_name": name }
    })) {
        Ok(response) => response,
        Err(error) => {
            let (status, code) = auth_failure_parts(error);
            if matches!(
                code.as_deref(),
                Some("user_already_exists" | "email_exists")
            ) {
                return Ok(SignUp::AccountExists);
            }
            bail!(auth_failure_message(status, code.as_deref()));
        }
    };
    classify_sign_up(read_json(response)?)
}

fn account_profile(login: &Login) -> Result<serde_json::Value> {
    let response = auth_request("GET", "user")
        .set("Authorization", &format!("Bearer {}", login.token))
        .call()
        .map_err(http_error)?;
    let user: serde_json::Value = read_json(response)?;
    Ok(serde_json::json!({
        "email": user["email"],
        "displayName": user["user_metadata"]["display_name"]
            .as_str().or_else(|| user["user_metadata"]["full_name"].as_str()),
        "plan": user["app_metadata"]["plan"].as_str()
    }))
}

fn validate_display_name(name: &str) -> Result<&str> {
    let name = name.trim();
    ensure!(
        name.chars().count() <= 80 && !name.chars().any(char::is_control),
        "Use a name of up to 80 characters without control characters."
    );
    Ok(name)
}

fn request(token: &str, method: &str, path: &str) -> Result<ureq::Request> {
    let base = https(STAGING_API)?;
    let url = base.join(path)?;
    Ok(agent()
        .request(method, url.as_str())
        .set("Authorization", &format!("Bearer {token}")))
}

const SIGN_IN_EXPIRED: &str = "Your Gyro Cloud sign-in expired. Sign in again.";

fn http_error(error: ureq::Error) -> anyhow::Error {
    match error {
        ureq::Error::Status(401, _) => anyhow!(SIGN_IN_EXPIRED),
        ureq::Error::Status(404, _) => anyhow!("The cloud copy was removed."),
        ureq::Error::Status(413, _) => {
            anyhow!("This chat exceeds the 16 MiB encrypted backup limit.")
        }
        _ => anyhow!("Gyro Cloud request failed. Try again."),
    }
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn key_entry(login: &Login) -> Result<keyring::Entry> {
    let service = "Gyro Cloud backup v1";
    // Debug acceptance profiles use different Keychain entries so restore
    // exercises recovery even when both profiles run on the same Mac.
    #[cfg(debug_assertions)]
    let service = if let Some(profile) = std::env::var_os("GYRO_TEST_DATA_DIR") {
        format!("{service} (test {})", digest(profile.as_encoded_bytes()))
    } else {
        service.to_owned()
    };
    Ok(keyring::Entry::new(service.as_ref(), &login.account)?)
}

fn saved_key(login: &Login) -> Result<Option<Key>> {
    match key_entry(login)?.get_secret() {
        Ok(bytes) => Ok(Some(
            bytes
                .try_into()
                .map_err(|_| anyhow!("Invalid saved backup key."))?,
        )),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => bail!("Could not read the backup key from Keychain."),
    }
}

fn aad(account: &str, id: Uuid, purpose: &str) -> String {
    format!("gyro-cloud/{VERSION}/{account}/{id}/{purpose}")
}

fn seal(key: &Key, aad: &str, bytes: &[u8]) -> Result<Vec<u8>> {
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let cipher = XChaCha20Poly1305::new(key.into());
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: bytes,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| anyhow!("Could not encrypt the chat."))?;
    let mut envelope = Vec::with_capacity(25 + ciphertext.len());
    envelope.push(VERSION);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

fn unseal(key: &Key, aad: &str, envelope: &[u8]) -> Result<Vec<u8>> {
    ensure!(
        envelope.len() >= 41 && envelope[0] == VERSION,
        "Unsupported or incomplete encrypted backup."
    );
    XChaCha20Poly1305::new(key.into())
        .decrypt(
            XNonce::from_slice(&envelope[1..25]),
            Payload {
                msg: &envelope[25..],
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| anyhow!("The recovery code is incorrect or the backup was damaged."))
}

fn decode_archive(key: &Key, account: &str, id: Uuid, bytes: &[u8]) -> Result<Archive> {
    ensure!(
        bytes.len() <= MAX_CIPHER,
        "Encrypted backup exceeds 16 MiB."
    );
    let compressed = unseal(key, &aad(account, id, "archive"), bytes)?;
    let mut decoder = zstd::stream::read::Decoder::new(compressed.as_slice())?;
    decoder.window_log_max(26)?;
    let mut decoded = Vec::new();
    decoder
        .take(MAX_ARCHIVE as u64 + 1)
        .read_to_end(&mut decoded)?;
    ensure!(
        decoded.len() <= MAX_ARCHIVE,
        "Decoded backup exceeds 64 MiB."
    );
    let archive: Archive = serde_json::from_slice(&decoded)?;
    ensure!(
        archive.version == VERSION,
        "Unsupported chat archive version."
    );
    Ok(archive)
}

fn export(store: &SessionStore, id: Uuid) -> Result<Archive> {
    let session = store
        .get_session(id)?
        .context("This local chat was not found.")?;
    let messages = store
        .read_transcript_events(id)?
        .into_iter()
        .filter_map(|event| {
            let kind = match event.kind {
                SessionEventKind::UserMessage => MessageKind::User,
                SessionEventKind::AssistantMessage => MessageKind::Assistant,
                SessionEventKind::CommandOutput => MessageKind::Tool,
                _ => return None,
            };
            let text = match kind {
                MessageKind::Tool => event
                    .payload
                    .get("output")
                    .and_then(serde_json::Value::as_str)
                    .filter(|output| !output.is_empty())
                    .unwrap_or(&event.message)
                    .to_owned(),
                MessageKind::Assistant => {
                    crate::providers::markers::strip_hidden_control_markers(&event.message).message
                }
                MessageKind::User => event.message,
            };
            Some(Message {
                kind,
                text,
                timestamp: event.created_at,
                model: event
                    .payload
                    .get("modelLabel")
                    .or_else(|| event.payload.get("modelId"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect();
    Ok(Archive {
        version: VERSION,
        title: session.title,
        created_at: session.created_at,
        updated_at: session.updated_at,
        model: session.model_label.or(session.model_id),
        messages,
    })
}

const KEY_CHECK: &[u8] = b"gyro-cloud-ready!";
const KEY_CHECK_URL: &str = "/v1/key-check";

fn key_check(login: &Login) -> Result<Option<Vec<u8>>> {
    match request(&login.token, "GET", KEY_CHECK_URL)?.call() {
        Ok(response) => {
            let mut bytes = Vec::new();
            response.into_reader().take(256).read_to_end(&mut bytes)?;
            Ok(Some(bytes))
        }
        Err(ureq::Error::Status(404, _)) => Ok(None),
        Err(error) => Err(http_error(error)),
    }
}

fn key_check_aad(login: &Login) -> String {
    aad(&login.account, Uuid::nil(), "key-check")
}

fn verify_key_check(login: &Login, key: &Key, bytes: &[u8]) -> Result<()> {
    ensure!(
        unseal(key, &key_check_aad(login), bytes)? == KEY_CHECK,
        "Invalid backup key check."
    );
    Ok(())
}

fn reserve_key(login: &Login, key: &Key) -> Result<()> {
    let envelope = seal(key, &key_check_aad(login), KEY_CHECK)?;
    let response = request(&login.token, "PUT", KEY_CHECK_URL)?
        .set("If-None-Match", "*")
        .send_bytes(&envelope);
    if response.is_ok() {
        return Ok(());
    }
    if let Some(existing) = key_check(login)? {
        return verify_key_check(login, key, &existing);
    }
    Err(http_error(response.expect_err("request failed")))
}

fn chat_url(id: Uuid) -> String {
    format!("/v1/chats/{id}")
}

fn list(login: &Login, cursor: Option<&str>) -> Result<Page> {
    let mut request = request(&login.token, "GET", "/v1/chats")?;
    if let Some(cursor) = cursor {
        request = request.query("cursor", cursor);
    }
    read_json(request.call().map_err(http_error)?)
}

fn download(login: &Login, key: &Key, id: Uuid) -> Result<Archive> {
    let response = request(&login.token, "GET", &chat_url(id))?
        .call()
        .map_err(http_error)?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_CIPHER as u64 + 1)
        .read_to_end(&mut bytes)
        .context("Download interrupted. Try again.")?;
    decode_archive(key, &login.account, id, &bytes)
}

fn local_dir(login: &Login) -> Result<PathBuf> {
    let paths = GyroPaths::for_current_user()?;
    paths.ensure()?;
    let directory = paths.base_dir.join("cloud-history").join(&login.account);
    std::fs::create_dir_all(&directory)?;
    Ok(directory)
}

fn publish_history(directory: &Path, id: Uuid, archive: &Archive) -> Result<()> {
    atomic_write(
        &directory.join(format!("{id}.history")),
        &serde_json::to_vec(archive)?,
    )
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().context("Missing history directory.")?)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(())
}

fn upload(
    login: &Login,
    key: &Key,
    id: Uuid,
    replace: Option<String>,
) -> Result<serde_json::Value> {
    let store = crate::stores::open_store().map_err(anyhow::Error::msg)?;
    let archive = export(&store, id)?;
    drop(store);
    let plain = serde_json::to_vec(&archive)?;
    ensure!(
        plain.len() <= MAX_ARCHIVE,
        "This chat exceeds the 64 MiB decoded backup limit."
    );
    let archive_digest = digest(&plain);
    let directory = local_dir(login)?;
    let path = directory.join(format!("{id}.receipt"));
    let pending_path = directory.join(format!("{id}.upload"));
    let pending = read_pending(&pending_path);
    let mut receipt: Option<Receipt> = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let url = chat_url(id);
    let (current, cloud_digest) = match request(&login.token, "HEAD", &url)?.call() {
        Ok(response) => (
            Some(
                response
                    .header("ETag")
                    .context("Missing cloud version.")?
                    .to_owned(),
            ),
            response.header("X-Gyro-Digest").map(str::to_owned),
        ),
        Err(ureq::Error::Status(404, _)) => (None, None),
        Err(error) => return Err(http_error(error)),
    };
    if let (Some(etag), Some(cloud_digest), Some((metadata, payload))) =
        (&current, cloud_digest, &pending)
    {
        if cloud_digest == digest(payload) {
            let committed = Receipt {
                etag: etag.clone(),
                archive_digest: metadata.archive_digest.clone(),
            };
            atomic_write(&path, &serde_json::to_vec(&committed)?)?;
            let _ = std::fs::remove_file(&pending_path);
            receipt = Some(committed);
        }
    }
    if let Some(receipt) = &receipt {
        if Some(&receipt.etag) == current.as_ref() && receipt.archive_digest == archive_digest {
            return Ok(serde_json::json!({ "status": "unchanged" }));
        }
    }
    let expected = replace
        .as_ref()
        .or_else(|| receipt.as_ref().map(|receipt| &receipt.etag));
    if replace.is_some() && current.is_none() {
        bail!("The cloud copy was removed. Start a new upload to recreate it.");
    }
    if current.is_some() && current.as_ref() != expected {
        return Ok(serde_json::json!({ "status": "conflict", "etag": current }));
    }
    let (metadata, payload) = match pending {
        Some((metadata, payload))
            if metadata.expected == current && metadata.archive_digest == archive_digest =>
        {
            (metadata, payload)
        }
        _ => {
            let compressed = zstd::stream::encode_all(plain.as_slice(), 3)?;
            let payload = seal(key, &aad(&login.account, id, "archive"), &compressed)?;
            ensure!(
                payload.len() <= MAX_CIPHER,
                "This chat exceeds the 16 MiB encrypted backup limit."
            );
            let title: String = archive.title.chars().take(200).collect();
            let title = B64.encode(seal(
                key,
                &aad(&login.account, id, "title"),
                title.as_bytes(),
            )?);
            let metadata = PendingUpload {
                expected: current.clone(),
                archive_digest: archive_digest.clone(),
                title,
            };
            let mut staged = serde_json::to_vec(&metadata)?;
            staged.push(b'\n');
            staged.extend_from_slice(&payload);
            atomic_write(&pending_path, &staged)?;
            (metadata, payload)
        }
    };
    let put_request = request(&login.token, "PUT", &url)?;
    let send = || -> Result<ureq::Response, ureq::Error> {
        let request = put_request
            .clone()
            .set("Content-Type", "application/octet-stream")
            .set("X-Gyro-Title", &metadata.title);
        match &current {
            Some(etag) => request.set("If-Match", etag),
            None => request.set("If-None-Match", "*"),
        }
        .send_bytes(&payload)
    };
    let response = match send() {
        Err(ureq::Error::Transport(_) | ureq::Error::Status(503, _)) => send(),
        result => result,
    };
    let entry: Entry = match response {
        Ok(response) => read_json(response)?,
        Err(ureq::Error::Status(412, _)) => {
            let response = request(&login.token, "HEAD", &url)?
                .call()
                .map_err(http_error)?;
            return Ok(
                serde_json::json!({ "status": "conflict", "etag": response.header("ETag") }),
            );
        }
        Err(error) => return Err(http_error(error)),
    };
    ensure!(
        entry.id == id && entry.digest == digest(&payload),
        "Cloud upload could not be verified."
    );
    atomic_write(
        &path,
        &serde_json::to_vec(&Receipt {
            etag: entry.etag,
            archive_digest,
        })?,
    )?;
    let _ = std::fs::remove_file(pending_path);
    Ok(serde_json::json!({ "status": "uploaded" }))
}

fn run(action: Action) -> Result<serde_json::Value> {
    use serde_json::{json, to_value, Value};
    let enabled = std::env::var("GYRO_CLOUD_ENABLED").as_deref() == Ok("1");
    if !enabled {
        if matches!(action, Action::Status) {
            return Ok(json!({ "enabled": false }));
        }
        bail!("Gyro Cloud is disabled.");
    }
    let mut state = STATE
        .try_lock()
        .map_err(|_| anyhow!("A Gyro Cloud operation is already in progress."))?;
    let mut password_error = None;
    match &action {
        Action::SendPasswordReset { email } => {
            check_email(email)?;
            auth_request("POST", "recover")
                .send_json(json!({ "email": email }))
                .map_err(auth_failure)?;
            return Ok(Value::Null);
        }
        Action::ResetPassword {
            email,
            proof,
            password,
        } => {
            let (login, refused) = reset_password(email, proof, password)?;
            state.login = Some(login);
            state.pending = None;
            password_error = refused;
        }
        Action::SendCode { email } => {
            check_email(email)?;
            auth_request("POST", "otp")
                .send_json(json!({ "email": email, "create_user": false }))
                .map_err(auth_failure)?;
            return Ok(Value::Null);
        }
        Action::SignIn { email, proof } => {
            state.login = Some(sign_in(email, proof)?);
            state.pending = None;
        }
        Action::SignUp {
            name,
            email,
            password,
        } => match sign_up(name, email, password)? {
            SignUp::Session(session) => {
                state.login = Some(finish_login(email, *session)?);
                state.pending = None;
            }
            SignUp::ConfirmationRequired => {
                return Ok(json!({ "confirmationRequired": true }));
            }
            SignUp::AccountExists => return Ok(json!({ "accountExists": true })),
        },
        Action::PasswordSignIn { email, password } => {
            let Some(login) = sign_in_with_password(email, password)? else {
                return Ok(json!({ "confirmationRequired": true }));
            };
            state.login = Some(login);
            state.pending = None;
        }
        Action::ResendConfirmation { email } => {
            check_email(email)?;
            auth_request("POST", "resend")
                .send_json(json!({ "type": "signup", "email": email }))
                .map_err(auth_failure)?;
            return Ok(Value::Null);
        }
        Action::SignOut => {
            *state = State::default();
        }
        _ => {}
    }
    if matches!(
        action,
        Action::Status
            | Action::SignIn { .. }
            | Action::SignUp { .. }
            | Action::PasswordSignIn { .. }
            | Action::ResetPassword { .. }
            | Action::SignOut
    ) {
        // An expired sign-in reads as signed out, not as a broken account.
        let profile = match state.login.as_ref().map(account_profile).transpose() {
            Err(error) if error.to_string() == SIGN_IN_EXPIRED => {
                state.login = None;
                None
            }
            other => other?,
        };
        let unlocked = state
            .login
            .as_ref()
            .map(saved_key)
            .transpose()?
            .flatten()
            .is_some();
        let backup_exists = match state.login.as_ref() {
            Some(login) => unlocked || key_check(login)?.is_some(),
            None => false,
        };
        return Ok(json!({ "enabled": true, "signedIn": state.login.is_some(),
            "unlocked": unlocked, "backupExists": backup_exists, "profile": profile,
            "passwordError": password_error }));
    }
    let login = state
        .login
        .as_ref()
        .context("Sign in to Gyro Cloud first.")?;
    match action {
        Action::ChangePassword { password } => {
            check_password(&password)?;
            set_password(login, &password)
                .map_err(|(status, code)| anyhow!(auth_failure_message(status, code.as_deref())))?;
            return Ok(Value::Null);
        }
        Action::UpdateProfile { display_name } => {
            let name = validate_display_name(&display_name)?;
            auth_request("PUT", "user")
                .set("Authorization", &format!("Bearer {}", login.token))
                .send_json(json!({ "data": { "display_name": name } }))
                .map_err(http_error)?;
            return account_profile(login);
        }
        Action::Generate => {
            ensure!(
                saved_key(login)?.is_none() && key_check(login)?.is_none(),
                "Use your existing recovery code."
            );
            let key = code();
            state.pending = Some(key);
            return Ok(json!({ "code": B64.encode(key) }));
        }
        Action::Confirm => {
            let key = state.pending.context("Generate a recovery code first.")?;
            ensure!(
                saved_key(login)?.is_none(),
                "Use your existing recovery code."
            );
            reserve_key(login, &key)?;
            key_entry(login)?.set_secret(&key)?;
            state.pending = None;
            return Ok(Value::Null);
        }
        Action::Recover { code } => {
            let key: Key = B64
                .decode(code.trim())
                .ok()
                .and_then(|bytes| bytes.try_into().ok())
                .context("Invalid Gyro Cloud recovery code.")?;
            let check = key_check(login)?.context("Set up a new backup first.")?;
            verify_key_check(login, &key, &check)?;
            if let Some(entry) = list(login, None)?.items.first() {
                download(login, &key, entry.id)?;
            }
            key_entry(login)?.set_secret(&key)?;
            state.pending = None;
            return Ok(Value::Null);
        }
        _ => {}
    }
    let key = saved_key(login)?.context("Unlock Gyro Cloud with your recovery code first.")?;
    match action {
        Action::List { cursor } => {
            let page = list(login, cursor.as_deref())?;
            let items: Vec<_> = page
                .items
                .into_iter()
                .map(|entry| {
                    let title = B64
                        .decode(entry.title)
                        .ok()
                        .and_then(|bytes| {
                            unseal(&key, &aad(&login.account, entry.id, "title"), &bytes).ok()
                        })
                        .and_then(|bytes| String::from_utf8(bytes).ok());
                    json!({ "id": entry.id, "title": title, "uploadedAt": entry.uploaded_at })
                })
                .collect();
            Ok(json!({ "items": items, "cursor": page.cursor }))
        }
        Action::History => {
            let mut items = Vec::new();
            for entry in std::fs::read_dir(local_dir(login)?)? {
                let entry = entry?;
                let path = entry.path();
                if !entry.file_type()?.is_file()
                    || path.extension().and_then(|ext| ext.to_str()) != Some("history")
                {
                    continue;
                }
                if let Some(id) = path
                    .file_stem()
                    .and_then(|id| id.to_str())
                    .and_then(|id| Uuid::parse_str(id).ok())
                {
                    items.push(id);
                }
            }
            items.sort_unstable();
            Ok(to_value(items)?)
        }
        Action::Upload { id, replace } => upload(login, &key, id, replace),
        Action::Download { id } => {
            let archive = download(login, &key, id)?;
            publish_history(&local_dir(login)?, id, &archive)?;
            Ok(to_value(archive)?)
        }
        Action::Open { id } => {
            let file = std::fs::File::open(local_dir(login)?.join(format!("{id}.history")))?;
            let archive: Archive = serde_json::from_reader(file.take(MAX_ARCHIVE as u64))?;
            Ok(to_value(archive)?)
        }
        Action::Delete { id } => {
            request(&login.token, "DELETE", &chat_url(id))?
                .call()
                .map_err(http_error)?;
            Ok(Value::Null)
        }
        _ => bail!("Invalid Gyro Cloud action."),
    }
}

#[tauri::command]
pub(crate) async fn gyro_cloud(action: Action) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || run(action).map_err(|error| error.to_string()))
        .await
        .map_err(|_| "Gyro Cloud operation interrupted.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use gyro_core::sessions::SessionOrigin;
    use serde_json::json;

    #[test]
    fn profile_name_validation_and_action_contract() -> Result<()> {
        assert_eq!(validate_display_name("  Wytze  ")?, "Wytze");
        assert_eq!(validate_display_name("")?, "");
        assert_eq!(validate_display_name("李明")?, "李明");
        assert!(validate_display_name("a\nb").is_err());
        assert!(validate_display_name(&"a".repeat(81)).is_err());
        let action: Action = serde_json::from_value(json!({
            "type": "updateProfile", "displayName": "Wytze"
        }))?;
        assert!(
            matches!(action, Action::UpdateProfile { display_name } if display_name == "Wytze")
        );
        Ok(())
    }

    #[test]
    fn sign_up_action_contract_and_password_rules() -> Result<()> {
        let action: Action = serde_json::from_value(json!({
            "type": "signUp", "name": "Wytze", "email": "w@example.com", "password": "correct horse"
        }))?;
        assert!(matches!(action, Action::SignUp { name, .. } if name == "Wytze"));
        let action: Action = serde_json::from_value(json!({
            "type": "passwordSignIn", "email": "w@example.com", "password": "correct horse"
        }))?;
        assert!(matches!(action, Action::PasswordSignIn { .. }));
        assert!(check_password("1234567").is_err());
        assert!(check_password("12345678").is_ok());
        assert!(check_password(&"a".repeat(73)).is_err());
        assert!(sign_up("   ", "w@example.com", "correct horse").is_err());
        Ok(())
    }

    #[test]
    fn auth_failures_explain_the_next_step() {
        assert!(auth_failure_message(400, Some("invalid_credentials")).contains("don’t match"));
        assert!(auth_failure_message(422, Some("user_already_exists")).contains("Sign in"));
        assert!(auth_failure_message(422, Some("otp_disabled")).contains("Create one"));
        assert!(auth_failure_message(422, Some("something_new")).contains("Check what"));
        assert!(auth_failure_message(429, None).contains("Too many"));
        assert!(auth_failure_message(500, None).contains("Try again"));
    }

    #[test]
    fn repeat_sign_up_is_recognized_instead_of_awaiting_an_email() -> Result<()> {
        // What the service returns for an email that already has an account.
        assert!(matches!(
            classify_sign_up(
                json!({ "id": Uuid::nil(), "email": "w@example.com", "identities": [] })
            )?,
            SignUp::AccountExists
        ));
        assert!(matches!(
            classify_sign_up(json!({ "user": { "identities": [] } }))?,
            SignUp::AccountExists
        ));
        assert!(matches!(
            classify_sign_up(
                json!({ "id": Uuid::nil(), "identities": [{ "provider": "email" }] })
            )?,
            SignUp::ConfirmationRequired
        ));
        // A missing list must not claim an account exists.
        assert!(matches!(
            classify_sign_up(json!({ "id": Uuid::nil() }))?,
            SignUp::ConfirmationRequired
        ));
        let action: Action = serde_json::from_value(json!({
            "type": "resendConfirmation", "email": "w@example.com"
        }))?;
        assert!(matches!(action, Action::ResendConfirmation { .. }));
        Ok(())
    }

    #[test]
    fn recovery_proofs_only_accept_recovery_links() -> Result<()> {
        let hash = "a".repeat(40);
        let link = |kind: &str| format!("{STAGING_ISSUER}/verify?token={hash}&type={kind}");
        assert_eq!(
            recovery_proof("w@example.com", &link("recovery"))?,
            json!({ "token_hash": hash, "type": "recovery" })
        );
        assert!(recovery_proof("w@example.com", &link("magiclink")).is_err());
        assert!(email_proof("w@example.com", &link("recovery")).is_err());
        assert_eq!(
            recovery_proof("w@example.com", "123456")?,
            json!({ "email": "w@example.com", "token": "123456", "type": "recovery" })
        );
        Ok(())
    }

    #[test]
    fn password_actions_contract() -> Result<()> {
        let action: Action = serde_json::from_value(json!({
            "type": "resetPassword", "email": "w@example.com", "proof": "123456", "password": "correct horse"
        }))?;
        assert!(matches!(action, Action::ResetPassword { .. }));
        let action: Action = serde_json::from_value(json!({
            "type": "sendPasswordReset", "email": "w@example.com"
        }))?;
        assert!(matches!(action, Action::SendPasswordReset { .. }));
        let action: Action = serde_json::from_value(json!({
            "type": "changePassword", "password": "correct horse"
        }))?;
        assert!(matches!(action, Action::ChangePassword { .. }));
        // A short password is refused before the emailed proof can be spent.
        assert!(reset_password("w@example.com", "123456", "short").is_err());
        Ok(())
    }

    #[test]
    fn signup_confirmation_links_are_accepted() -> Result<()> {
        let hash = "a".repeat(40);
        let link = format!("{STAGING_ISSUER}/verify?token={hash}&type=signup");
        assert_eq!(
            email_proof("w@example.com", &link)?,
            json!({ "token_hash": hash, "type": "email" })
        );
        Ok(())
    }

    #[test]
    fn backup_timestamp_is_optional_for_old_entries() -> Result<()> {
        let mut value =
            json!({"id": Uuid::nil(), "etag": "etag", "title": "title", "digest": "digest"});
        let old: Entry = serde_json::from_value(value.clone())?;
        assert!(old.uploaded_at.is_none());
        value["uploadedAt"] = json!("2026-11-03T10:00:00Z");
        let current: Entry = serde_json::from_value(value)?;
        assert_eq!(current.uploaded_at.as_deref(), Some("2026-11-03T10:00:00Z"));
        Ok(())
    }

    #[test]
    fn restores_transcript_on_fresh_device_and_rejects_invalid_backups() -> Result<()> {
        let original = tempfile::tempdir()?;
        let store = SessionStore::open(GyroPaths::from_base_dir(original.path().join("Gyro")))?;
        let session =
            store.create_session(original.path(), SessionOrigin::Desktop, "Original title")?;
        store.rename_session(session.id, "Renamed café")?;
        store.append_event(
            session.id,
            SessionEventKind::UserMessage,
            "Show λ",
            json!({
                "attachments": [{ "path": "/private/local-file", "data": "attachment-data" }]
            }),
        )?;
        store.append_event(
            session.id,
            SessionEventKind::CommandOutput,
            "Tool output",
            json!({
                "output": "line 1\nline 2", "credential": "private-credential"
            }),
        )?;
        store.append_event(
            session.id,
            SessionEventKind::AssistantMessage,
            "```rust\nfn main() {}\n```",
            json!({}),
        )?;

        let archive = export(&store, session.id)?;
        let plain = serde_json::to_vec(&archive)?;
        let text = std::str::from_utf8(&plain)?;
        for excluded in [
            "private/local-file",
            "attachment-data",
            "private-credential",
        ] {
            assert!(!text.contains(excluded));
        }
        assert_eq!(archive.title, "Renamed café");
        assert_eq!(
            archive
                .messages
                .iter()
                .map(|m| m.text.as_str())
                .collect::<Vec<_>>(),
            ["Show λ", "line 1\nline 2", "```rust\nfn main() {}\n```"]
        );
        let account = "test-account";
        let id = session.id;
        let recovery_code = B64.encode(code());
        let key: Key = B64.decode(&recovery_code)?.try_into().unwrap();
        let associated_data = aad(account, id, "archive");
        let payload = seal(
            &key,
            &associated_data,
            &zstd::stream::encode_all(plain.as_slice(), 3)?,
        )?;
        let fresh = tempfile::tempdir()?;
        let key_from_code: Key = B64.decode(recovery_code)?.try_into().unwrap();
        let restored = decode_archive(&key_from_code, account, id, &payload)?;
        for _ in 0..2 {
            publish_history(fresh.path(), id, &restored)?;
        }
        assert_eq!(std::fs::read_dir(fresh.path())?.count(), 1);
        let history = fresh.path().join(format!("{id}.history"));
        assert_eq!(std::fs::read(&history)?, plain);
        assert!(decode_archive(&code(), account, id, &payload).is_err());
        assert!(decode_archive(&key, "other-account", id, &payload).is_err());
        assert!(decode_archive(&key, account, Uuid::new_v4(), &payload).is_err());
        assert!(decode_archive(&key, account, id, &payload[..payload.len() - 1]).is_err());
        let mut tampered = payload.clone();
        tampered[25] ^= 1;
        assert!(decode_archive(&key, account, id, &tampered).is_err());
        tampered[0] = 2;
        assert!(decode_archive(&key, account, id, &tampered).is_err());
        assert!(decode_archive(&key, account, id, &vec![0; MAX_CIPHER + 1]).is_err());
        assert_eq!(std::fs::read(history)?, plain);
        Ok(())
    }

    #[test]
    fn rejects_archive_larger_than_decoded_limit() -> Result<()> {
        let key = code();
        let id = Uuid::new_v4();
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 3)?;
        let zeros = vec![0; 1024 * 1024];
        for _ in 0..64 {
            encoder.write_all(&zeros)?;
        }
        encoder.write_all(&[0])?;
        let payload = seal(&key, &aad("account", id, "archive"), &encoder.finish()?)?;
        let error = decode_archive(&key, "account", id, &payload).unwrap_err();
        assert!(error.to_string().contains("exceeds 64 MiB"));
        Ok(())
    }
}
