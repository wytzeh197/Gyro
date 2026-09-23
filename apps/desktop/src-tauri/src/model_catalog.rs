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

#[tauri::command]
pub async fn fetch_model_catalog() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let raw = fetch_catalog()?;
        // The runner keeps its own copy, so automations and the menu bar see
        // the same models as the picker, and a restart without a network
        // still runs them correctly. A document the runner cannot read is
        // left to the picker's own validation and changes nothing here.
        if let Ok(profiles) = parse_profiles(&raw) {
            install(profiles);
            persist(&raw);
        }
        Ok(raw)
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
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|raw| parse_profiles(&raw).ok())
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

fn persist(raw: &str) {
    let Some(path) = cache_path() else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    // A focused app refreshes once a minute; an unchanged catalog costs no write.
    if std::fs::read_to_string(&path).is_ok_and(|current| current == raw) {
        return;
    }
    // Written beside the target and renamed over it, so a crash mid-write
    // leaves the previous copy rather than a torn document.
    let _ = std::fs::create_dir_all(parent);
    let staging = path.with_extension("json.partial");
    if std::fs::write(&staging, raw).is_ok() && std::fs::rename(&staging, &path).is_err() {
        let _ = std::fs::remove_file(&staging);
    }
}

/// Read the runtime facts out of a catalog document.
///
/// Mirrors the picker's validation for the fields it reads, and like it
/// rejects the whole document on bad data, so the runner never holds a
/// catalog the picker refused. A disabled catalog yields no profiles: the
/// picker falls back to the bundled models, and so does the runner.
fn parse_profiles(raw: &str) -> Result<Profiles, String> {
    let invalid = |what: &str| format!("model catalog: invalid {what}");
    let document: serde_json::Value = serde_json::from_str(raw).map_err(|_| invalid("document"))?;
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
    for model in models {
        let text = |key: &str| {
            model
                .get(key)
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid(key))
        };
        let provider_id = text("providerId")?.to_string();
        let model_id = text("id")?.to_ascii_lowercase();
        let min_revision = model
            .get("minClientRevision")
            .and_then(|value| value.as_u64())
            .filter(|revision| *revision >= 1)
            .ok_or_else(|| invalid("minClientRevision"))?;
        let efforts = match model.get("supportedReasoningEfforts") {
            None => None,
            Some(value) => {
                let list = value.as_array().ok_or_else(|| invalid("efforts"))?;
                let mut efforts = Vec::with_capacity(list.len());
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
        let context_window = match model.get("contextWindowTokens") {
            None => None,
            Some(value) => Some(
                value
                    .as_u64()
                    .filter(|tokens| (1..=100_000_000).contains(tokens))
                    .ok_or_else(|| invalid("contextWindowTokens"))?,
            ),
        };
        let key = (provider_id, model_id);
        if profiles.contains_key(&key) {
            return Err(invalid("duplicate model"));
        }
        // An entry for a later client describes handling this build lacks, so
        // it stays out of the runner just as it stays out of the picker.
        if enabled && min_revision <= CLIENT_REVISION {
            profiles.insert(
                key,
                CatalogModelProfile {
                    supported_reasoning_efforts: efforts,
                    context_window_tokens: context_window,
                },
            );
        }
    }
    Ok(profiles)
}

#[cfg(test)]
pub(crate) fn install_for_test(raw: &str) {
    install(parse_profiles(raw).expect("test catalog parses"));
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
        let profiles = parse_profiles(&document(
            r#"{"providerId":"openai","id":"GPT-9","displayName":"GPT-9","minClientRevision":2,
                "contextWindowTokens":400000,"supportedReasoningEfforts":["low","ultra"]},
               {"providerId":"xai","id":"grok-9","displayName":"Grok 9","minClientRevision":1}"#,
        ))
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
        assert!(parse_profiles(&document(later)).unwrap().is_empty());
        let current =
            r#"{"providerId":"openai","id":"gpt-9","displayName":"GPT-9","minClientRevision":1}"#;
        let disabled = document(current).replace(r#""enabled":true"#, r#""enabled":false"#);
        assert!(parse_profiles(&disabled).unwrap().is_empty());
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
            assert!(parse_profiles(&document(bad)).is_err(), "accepted: {bad}");
        }
        assert!(parse_profiles(r#"{"schema":"other","enabled":true,"models":[]}"#).is_err());
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

    /// The published catalog must always parse here, or every published model
    /// silently falls back to the runner's bundled tables.
    #[test]
    fn the_published_catalog_parses() {
        let raw = include_str!("../../../../site/model-catalog.json");
        assert!(parse_profiles(raw).is_ok());
    }
}
