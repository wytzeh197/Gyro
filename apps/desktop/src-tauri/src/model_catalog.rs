use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

// Fixed first-party data endpoint. Never accept a URL or credentials from the renderer.
const CATALOG_URL: &str = "https://usegyro.io/model-catalog.json";
const MAX_CATALOG_BYTES: u64 = 256 * 1024;
const CATALOG_SCHEMA: &str = "gyro.model-catalog.v1";
/// Must match `MODEL_CATALOG_CLIENT_REVISION` in packages/ui, so the runner
/// and the picker agree on which entries this build can execute.
const CLIENT_REVISION: u64 = 2;
const EFFORTS: [&str; 6] = ["low", "medium", "high", "xhigh", "max", "ultra"];

/// What the published catalog says about running one model.
///
/// This is what lets a model published after a release run correctly on that
/// release: the runner asks the catalog before its own bundled tables, so a
/// new model's reasoning levels and context window arrive with the catalog
/// rather than with the next app update.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct CatalogModelProfile {
    pub supported_reasoning_efforts: Option<Vec<String>>,
    pub context_window_tokens: Option<u64>,
}

type Profiles = HashMap<(String, String), CatalogModelProfile>;

/// Fetch the published document. Nothing is installed here: the picker
/// validates it first and hands it back through `install_model_catalog`.
#[tauri::command]
pub async fn fetch_model_catalog() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(fetch_catalog)
        .await
        .map_err(|error| format!("model catalog worker failed: {error}"))?
}

/// Install a document the picker has already put into effect.
///
/// The runner keeps its own copy, so automations and the menu bar see the same
/// models as the picker, and a restart without a network still runs them
/// correctly. Taking it from the picker, with the picker's rollout bucket,
/// means the runner never holds a document the picker refused or an entry this
/// installation is not rolled out to.
#[tauri::command]
pub async fn install_model_catalog(raw: String, bucket: u8) -> Result<(), String> {
    if bucket > 99 {
        return Err("model catalog: invalid rollout bucket".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let profiles = parse_profiles(&raw, bucket)?;
        install(profiles);
        persist(&raw, bucket);
        Ok(())
    })
    .await
    .map_err(|error| format!("model catalog worker failed: {error}"))?
}

/// The catalog's runtime facts for a model, when it publishes any.
pub(crate) fn catalog_model_profile(
    provider_id: &str,
    model_id: Option<&str>,
) -> Option<CatalogModelProfile> {
    let model_id = model_id?.trim();
    if model_id.is_empty() {
        return None;
    }
    profiles()
        .read()
        .ok()?
        .get(&(provider_id.to_string(), model_id.to_ascii_lowercase()))
        .cloned()
}

/// The reasoning levels the catalog lists for a model, lowercased.
pub(crate) fn catalog_reasoning_efforts(
    provider_id: &str,
    model_id: Option<&str>,
) -> Option<Vec<String>> {
    catalog_model_profile(provider_id, model_id)?.supported_reasoning_efforts
}

fn profiles() -> &'static RwLock<Profiles> {
    static PROFILES: OnceLock<RwLock<Profiles>> = OnceLock::new();
    PROFILES.get_or_init(|| {
        let restored = cache_path()
            .and_then(|path| {
                let raw = std::fs::read_to_string(&path).ok()?;
                // Caches written before the bucket was saved apply as bucket 0,
                // which is what they meant then: every entry, whatever the rollout.
                let bucket = std::fs::read_to_string(path.with_extension("bucket"))
                    .ok()
                    .and_then(|bucket| bucket.trim().parse::<u8>().ok())
                    .filter(|bucket| *bucket <= 99)
                    .unwrap_or(0);
                parse_profiles(&raw, bucket).ok()
            })
            .unwrap_or_default();
        RwLock::new(restored)
    })
}

fn install(next: Profiles) {
    if let Ok(mut current) = profiles().write() {
        *current = next;
    }
}

fn cache_path() -> Option<PathBuf> {
    // Tests must not read or overwrite the developer's own copy.
    if cfg!(test) {
        return None;
    }
    gyro_core::paths::GyroPaths::for_current_user()
        .ok()
        .map(|paths| paths.base_dir.join("model-catalog.json"))
}

fn persist(raw: &str, bucket: u8) {
    let Some(path) = cache_path() else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    let _ = std::fs::create_dir_all(parent);
    // The bucket goes first: a crash between the two writes then leaves the
    // previous document read with the current bucket, never the reverse.
    write_atomically(&path.with_extension("bucket"), &bucket.to_string());
    write_atomically(&path, raw);
}

/// Written beside the target and renamed over it, so a crash mid-write leaves
/// the previous copy rather than a torn file. An unchanged file costs no write.
fn write_atomically(path: &std::path::Path, contents: &str) {
    if std::fs::read_to_string(path).is_ok_and(|current| current == contents) {
        return;
    }
    let mut staging = path.as_os_str().to_owned();
    staging.push(".partial");
    let staging = PathBuf::from(staging);
    if std::fs::write(&staging, contents).is_ok() && std::fs::rename(&staging, path).is_err() {
        let _ = std::fs::remove_file(&staging);
    }
}

/// Read the runtime facts out of a catalog document.
///
/// Validates exactly what `parseModelCatalog` in packages/ui validates, so the
/// two accept and reject the same documents; `scripts/fixtures/
/// model-catalog-parity.json` holds the cases both sides are tested against.
/// Entries are kept only where the picker offers them: an enabled document,
/// this installation's rollout bucket, and a client revision this build meets.
fn parse_profiles(raw: &str, bucket: u8) -> Result<Profiles, String> {
    let invalid = |what: &str| format!("model catalog: invalid {what}");
    if raw.len() as u64 > MAX_CATALOG_BYTES {
        return Err(invalid("size"));
    }
    let document: serde_json::Value = serde_json::from_str(raw).map_err(|_| invalid("document"))?;
    let document = document.as_object().ok_or_else(|| invalid("document"))?;
    if document.get("schema").and_then(|value| value.as_str()) != Some(CATALOG_SCHEMA) {
        return Err(invalid("schema"));
    }
    let enabled = document
        .get("enabled")
        .and_then(|value| value.as_bool())
        .ok_or_else(|| invalid("enabled flag"))?;
    let models = document
        .get("models")
        .and_then(|value| value.as_array())
        .filter(|models| models.len() <= 500)
        .ok_or_else(|| invalid("models"))?;
    let mut profiles = Profiles::new();
    let mut seen = std::collections::HashSet::new();
    let mut entries: Vec<((String, String), u64, CatalogModelProfile)> =
        Vec::with_capacity(models.len());
    for model in models {
        let model = model.as_object().ok_or_else(|| invalid("model"))?;
        let field = |key: &str| model.get(key);
        let provider_id =
            catalog_text(field("providerId"), 64).ok_or_else(|| invalid("providerId"))?;
        let model_id = catalog_text(field("id"), 200)
            .filter(|id| catalog_model_id(id))
            .ok_or_else(|| invalid("id"))?;
        let key = (provider_id.to_string(), model_id.to_ascii_lowercase());
        if !seen.insert(key.clone()) {
            return Err(invalid("duplicate model"));
        }
        catalog_text(field("displayName"), 120).ok_or_else(|| invalid("displayName"))?;
        let min_revision = catalog_integer(field("minClientRevision"), 1, 1_000_000)
            .ok_or_else(|| invalid("minClientRevision"))?;
        for (key, max) in [("description", 600), ("insertBefore", 200)] {
            if let Some(value) = field(key) {
                catalog_text(Some(value), max).ok_or_else(|| invalid(key))?;
            }
        }
        let context_window = match field("contextWindowTokens") {
            None => None,
            Some(value) => Some(
                catalog_integer(Some(value), 1, 100_000_000)
                    .ok_or_else(|| invalid("contextWindowTokens"))?,
            ),
        };
        let efforts = match field("supportedReasoningEfforts") {
            None => None,
            Some(value) => {
                let list = value.as_array().ok_or_else(|| invalid("efforts"))?;
                let mut efforts: Vec<String> = Vec::with_capacity(list.len());
                for effort in list {
                    let effort = effort
                        .as_str()
                        .filter(|effort| EFFORTS.contains(effort))
                        .ok_or_else(|| invalid("efforts"))?;
                    if efforts.iter().any(|seen| seen == effort) {
                        return Err(invalid("efforts"));
                    }
                    efforts.push(effort.to_string());
                }
                Some(efforts)
            }
        };
        if let Some(default) = field("defaultReasoningEffort") {
            let supported = default
                .as_str()
                .zip(efforts.as_ref())
                .is_some_and(|(default, efforts)| efforts.iter().any(|effort| effort == default));
            if !supported {
                return Err(invalid("defaultReasoningEffort"));
            }
        }
        entries.push((
            key,
            min_revision,
            CatalogModelProfile {
                supported_reasoning_efforts: efforts,
                context_window_tokens: context_window,
            },
        ));
    }
    catalog_text(document.get("revision"), 120).ok_or_else(|| invalid("revision"))?;
    let rollout = catalog_integer(document.get("rolloutPercentage"), 0, 100)
        .ok_or_else(|| invalid("rolloutPercentage"))?;
    if !enabled || u64::from(bucket) >= rollout {
        return Ok(profiles);
    }
    for (key, min_revision, profile) in entries {
        // An entry for a later client describes handling this build lacks, so
        // it stays out of the runner just as it stays out of the picker.
        if min_revision <= CLIENT_REVISION {
            profiles.insert(key, profile);
        }
    }
    Ok(profiles)
}

/// The picker's `text()`: a non-blank string of at most `max` UTF-16 units
/// with no control characters. Kept untrimmed, as the picker keeps it.
fn catalog_text(value: Option<&serde_json::Value>, max: usize) -> Option<&str> {
    let value = value?.as_str()?;
    let blank = value
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .is_empty();
    (!blank && value.encode_utf16().count() <= max && !value.chars().any(|c| c.is_ascii_control()))
        .then_some(value)
}

/// The picker's `integer()`. JSON has one number type, so `2.0` is the
/// integer 2 there and must be here too.
fn catalog_integer(value: Option<&serde_json::Value>, min: u64, max: u64) -> Option<u64> {
    let value = value?;
    let number = value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|number| {
                number.fract() == 0.0 && *number >= 0.0 && *number <= 9_007_199_254_740_991.0
            })
            .map(|number| number as u64)
    })?;
    (min..=max).contains(&number).then_some(number)
}

/// The picker's model ID pattern, `^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$`, which
/// keeps an ID from ever reading as a CLI flag.
fn catalog_model_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || "._:/@+-".contains(c))
}

#[cfg(test)]
pub(crate) fn install_for_test(raw: &str) {
    install(parse_profiles(raw, 0).expect("test catalog parses"));
}

fn fetch_catalog() -> Result<String, String> {
    let response = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .redirects(0)
        .build()
        .get(CATALOG_URL)
        .set("Accept", "application/json")
        .call()
        .map_err(|error| format!("model catalog unavailable: {error}"))?;
    if response.status() != 200 {
        return Err("model catalog returned an unexpected status".into());
    }
    read_catalog(response.into_reader())
}

fn read_catalog(reader: impl Read) -> Result<String, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_CATALOG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("model catalog read failed: {error}"))?;
    if bytes.len() as u64 > MAX_CATALOG_BYTES {
        return Err("model catalog exceeds size limit".into());
    }
    String::from_utf8(bytes).map_err(|_| "model catalog is not UTF-8".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(models: &str) -> String {
        format!(
            r#"{{"schema":"gyro.model-catalog.v1","revision":"t.1","enabled":true,"rolloutPercentage":100,"models":[{models}]}}"#
        )
    }

    #[test]
    fn catalog_transport_bounds_and_encoding() {
        assert_eq!(read_catalog(&b"{}"[..]).unwrap(), "{}");
        assert!(read_catalog(vec![b' '; MAX_CATALOG_BYTES as usize + 1].as_slice()).is_err());
        assert!(read_catalog(&[0xff][..]).is_err());
    }

    #[test]
    fn a_catalog_entry_carries_its_runtime_facts() {
        let profiles = parse_profiles(
            &document(
                r#"{"providerId":"openai","id":"GPT-9","displayName":"GPT-9","minClientRevision":2,
                "contextWindowTokens":400000,"supportedReasoningEfforts":["low","ultra"]},
               {"providerId":"xai","id":"grok-9","displayName":"Grok 9","minClientRevision":1}"#,
            ),
            0,
        )
        .unwrap();
        assert_eq!(
            profiles[&("openai".into(), "gpt-9".into())],
            CatalogModelProfile {
                supported_reasoning_efforts: Some(vec!["low".into(), "ultra".into()]),
                context_window_tokens: Some(400_000),
            }
        );
        assert_eq!(
            profiles[&("xai".into(), "grok-9".into())],
            CatalogModelProfile::default()
        );
    }

    #[test]
    fn entries_for_a_later_client_and_disabled_catalogs_are_left_out() {
        let later =
            r#"{"providerId":"openai","id":"gpt-9","displayName":"GPT-9","minClientRevision":99}"#;
        assert!(parse_profiles(&document(later), 0).unwrap().is_empty());
        let current =
            r#"{"providerId":"openai","id":"gpt-9","displayName":"GPT-9","minClientRevision":1}"#;
        let disabled = document(current).replace(r#""enabled":true"#, r#""enabled":false"#);
        assert!(parse_profiles(&disabled, 0).unwrap().is_empty());
    }

    #[test]
    fn a_catalog_the_picker_would_reject_is_rejected_whole() {
        for bad in [
            r#"{"providerId":"openai","id":"a","displayName":"A","minClientRevision":1,"supportedReasoningEfforts":["turbo"]}"#,
            r#"{"providerId":"openai","id":"a","displayName":"A","minClientRevision":1,"supportedReasoningEfforts":["low","low"]}"#,
            r#"{"providerId":"openai","id":"a","displayName":"A","minClientRevision":1,"contextWindowTokens":0}"#,
            r#"{"providerId":"openai","id":"a","displayName":"A"}"#,
            r#"{"providerId":"openai","id":"a","displayName":"A","minClientRevision":1},
               {"providerId":"openai","id":"A","displayName":"A","minClientRevision":1}"#,
        ] {
            assert!(
                parse_profiles(&document(bad), 0).is_err(),
                "accepted: {bad}"
            );
        }
        assert!(parse_profiles(r#"{"schema":"other","enabled":true,"models":[]}"#, 0).is_err());
    }

    /// The picker runs the same fixture, so a document one side refuses is
    /// refused by both.
    #[test]
    fn the_runner_and_the_picker_agree_on_every_parity_case() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../scripts/fixtures/model-catalog-parity.json"
        ))
        .unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 40);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let raw = case["raw"].as_str().unwrap();
            let valid = case["valid"].as_bool().unwrap();
            assert_eq!(parse_profiles(raw, 0).is_ok(), valid, "{name}");
        }
        let many: Vec<String> = (0..501)
            .map(|i| format!(r#"{{"providerId":"openai","id":"m{i}","displayName":"M","minClientRevision":1}}"#))
            .collect();
        assert!(parse_profiles(&document(&many.join(",")), 0).is_err());
        let padded = document("").replace(
            r#""models":[]"#,
            &format!(r#""models":[]{}"#, " ".repeat(256 * 1024)),
        );
        assert!(parse_profiles(&padded, 0).is_err());
    }

    /// A partial rollout reaches the runner only where it reaches the picker.
    #[test]
    fn the_runner_follows_the_rollout_bucket() {
        let raw = document(
            r#"{"providerId":"openai","id":"gpt-9","displayName":"GPT-9","minClientRevision":1}"#,
        )
        .replace(r#""rolloutPercentage":100"#, r#""rolloutPercentage":10"#);
        assert_eq!(parse_profiles(&raw, 9).unwrap().len(), 1);
        assert!(parse_profiles(&raw, 10).unwrap().is_empty());
        assert!(parse_profiles(&raw, 99).unwrap().is_empty());
    }

    /// The only test that installs a catalog, since the store is shared by
    /// every test in the process. Its model IDs are unique to it.
    #[test]
    fn the_runner_asks_the_catalog_before_its_bundled_tables() {
        install_for_test(&document(
            r#"{"providerId":"openai","id":"catalog-test-gpt","displayName":"T","minClientRevision":2,
                "contextWindowTokens":123456,"supportedReasoningEfforts":["low","ultra"]},
               {"providerId":"xai","id":"catalog-test-grok","displayName":"T","minClientRevision":1,
                "supportedReasoningEfforts":["low","xhigh"]}"#,
        ));
        let codex =
            |effort| crate::codex_reasoning_effort_arg(Some("catalog-test-gpt"), Some(effort));
        assert_eq!(codex("ultra").as_deref(), Some("ultra"));
        assert_eq!(codex("medium"), None);
        let grok =
            |effort| crate::grok_reasoning_effort_arg(Some("catalog-test-grok"), Some(effort));
        assert_eq!(grok("xhigh").as_deref(), Some("xhigh"));
        assert_eq!(grok("high"), None);
        assert_eq!(
            crate::provider_context::provider_model_context_window(
                "openai",
                Some("catalog-test-gpt")
            ),
            Some(123_456)
        );
        // Models the catalog does not describe keep the bundled answers.
        assert_eq!(
            crate::provider_context::provider_model_context_window("openai", Some("gpt-5.4-mini")),
            Some(400_000)
        );
    }

    /// The runner and the picker must gate on the same client revision, or a
    /// model could be offered that the runner then handles as unknown.
    #[test]
    fn the_client_revision_matches_the_picker() {
        let source = include_str!("../../../../packages/ui/src/remote-model-catalog.ts");
        assert!(
            source.contains(&format!(
                "MODEL_CATALOG_CLIENT_REVISION = {CLIENT_REVISION};"
            )),
            "update CLIENT_REVISION alongside MODEL_CATALOG_CLIENT_REVISION"
        );
    }

    /// The live document through the real transport: no redirect, within the
    /// size limit, and readable by the runner. Needs the network, so it runs
    /// only on request: `cargo test --lib the_live_catalog -- --ignored`.
    #[test]
    #[ignore]
    fn the_live_catalog_is_fetched_and_parsed() {
        let raw = fetch_catalog().expect("the live catalog is reachable");
        let profiles = parse_profiles(&raw, 0).expect("the live catalog parses");
        let published =
            parse_profiles(include_str!("../../../../site/model-catalog.json"), 0).unwrap();
        assert_eq!(profiles, published, "the live catalog is the committed one");
    }

    /// The published catalog must always parse here, or every published model
    /// silently falls back to the runner's bundled tables.
    #[test]
    fn the_published_catalog_parses() {
        let raw = include_str!("../../../../site/model-catalog.json");
        assert!(parse_profiles(raw, 0).is_ok());
    }
}
