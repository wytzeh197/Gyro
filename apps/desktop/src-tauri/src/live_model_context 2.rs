//! Live, model-specific context limits. No inference requests are made here.
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

const METADATA_TTL: Duration = Duration::from_secs(300);
const RUNTIME_TTL: Duration = Duration::from_secs(900);
const MAX_WINDOW: u64 = 100_000_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelContextWindow {
    pub provider_id: String,
    pub model_id: String,
    pub context_window_tokens: Option<u64>,
    pub source: String,
    pub checked_at: String,
}

#[derive(Clone)]
struct Entry {
    window: u64,
    source: &'static str,
    scope: Option<String>,
    at: Instant,
    checked_at: String,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<(String, String), Entry>,
    queries: HashMap<(String, Option<String>), (Instant, HashSet<String>)>,
}

fn cache() -> &'static RwLock<Cache> {
    static CACHE: OnceLock<RwLock<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(Cache::default()))
}

fn scope(provider: &str, base_url: Option<&str>) -> Option<String> {
    base_url
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .or(match provider {
            "openrouter" => Some("https://openrouter.ai/api/v1"),
            "mistral" => Some("https://api.mistral.ai/v1"),
            "deepseek" => Some("https://api.deepseek.com"),
            "ollama" => Some(gyro_core::DEFAULT_OLLAMA_BASE_URL),
            _ => None,
        })
        .map(|url| url.trim_end_matches('/').to_string())
}

fn fresh(entry: &Entry, requested_scope: &Option<String>) -> bool {
    entry.scope == *requested_scope
        && entry.at.elapsed()
            < if entry.source == "runtime" {
                RUNTIME_TTL
            } else {
                METADATA_TTL
            }
}

fn remember(
    state: &mut Cache,
    provider: &str,
    model: &str,
    window: u64,
    source: &'static str,
    requested_scope: Option<String>,
) {
    if !(1..=MAX_WINDOW).contains(&window) || model.trim().is_empty() {
        return;
    }
    let key = (provider.to_string(), model.trim().to_string());
    // A provisioned session limit outranks a theoretical model maximum.
    if source != "runtime"
        && state
            .entries
            .get(&key)
            .is_some_and(|entry| entry.source == "runtime" && fresh(entry, &requested_scope))
    {
        return;
    }
    state
        .entries
        .retain(|_, entry| entry.at.elapsed() < RUNTIME_TTL);
    if state.entries.len() >= 5_000 && !state.entries.contains_key(&key) {
        return;
    }
    state.entries.insert(
        key,
        Entry {
            window,
            source,
            scope: requested_scope,
            at: Instant::now(),
            checked_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        },
    );
}

pub(crate) fn observe_runtime(
    provider: &str,
    model: Option<&str>,
    base_url: Option<&str>,
    window: Option<u64>,
) {
    if let (Some(model), Some(window), Ok(mut state)) = (model, window, cache().write()) {
        remember(
            &mut state,
            provider,
            model,
            window,
            "runtime",
            scope(provider, base_url),
        );
    }
}

pub(crate) fn invalidate(provider: &str) {
    if let Ok(mut state) = cache().write() {
        state.entries.retain(|(id, _), _| id != provider);
        state.queries.retain(|(id, _), _| id != provider);
    }
}

pub(crate) fn known_window(provider: &str, model: &str) -> Option<u64> {
    let entry = cache()
        .read()
        .ok()?
        .entries
        .get(&(provider.to_string(), model.trim().to_string()))?
        .clone();
    let configured = super::load_config_blocking().ok().and_then(|config| {
        config
            .model_providers
            .into_iter()
            .find(|item| item.id == provider)
    });
    fresh(
        &entry,
        &scope(
            provider,
            configured.as_ref().and_then(|p| p.base_url.as_deref()),
        ),
    )
    .then_some(entry.window)
}

fn local_openai_windows(raw: &str) -> Vec<(String, u64)> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    value
        .get("models")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model.get("slug")?.as_str()?.trim();
            let window = model.get("context_window")?.as_u64()?;
            (!id.is_empty() && (1..=MAX_WINDOW).contains(&window)).then(|| (id.to_string(), window))
        })
        .collect()
}

fn read_local_openai_windows() -> Vec<(String, u64)> {
    let home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".codex"))
        });
    let Some(path) = home.map(|home| home.join("models_cache.json")) else {
        return Vec::new();
    };
    let Ok(metadata) = std::fs::metadata(&path) else {
        return Vec::new();
    };
    if !metadata
        .modified()
        .ok()
        .and_then(|at| at.elapsed().ok())
        .is_some_and(|age| age < Duration::from_secs(86_400))
    {
        return Vec::new();
    }
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let mut raw = String::new();
    if file
        .take(4 * 1024 * 1024 + 1)
        .read_to_string(&mut raw)
        .is_err()
        || raw.len() > 4 * 1024 * 1024
    {
        return Vec::new();
    }
    local_openai_windows(&raw)
}

/// Limits for every requested model, including an explicit unknown result.
/// URLs and credentials come exclusively from native, saved provider config.
#[tauri::command]
pub(crate) async fn refresh_model_context_windows(
    provider_id: String,
    model_ids: Vec<String>,
    force: bool,
) -> Result<Vec<ModelContextWindow>, String> {
    if provider_id.is_empty()
        || provider_id.len() > 64
        || model_ids.len() > 500
        || model_ids
            .iter()
            .any(|id| id.trim().is_empty() || id.len() > 200 || id.chars().any(char::is_control))
    {
        return Err("invalid model context query".into());
    }
    tauri::async_runtime::spawn_blocking(move || refresh(&provider_id, &model_ids, force))
        .await
        .map_err(|error| format!("model context worker failed: {error}"))?
}

fn refresh(
    provider_id: &str,
    model_ids: &[String],
    force: bool,
) -> Result<Vec<ModelContextWindow>, String> {
    let config = super::load_config_blocking()?;
    let provider = config
        .model_providers
        .iter()
        .find(|provider| provider.id == provider_id);
    let requested_scope = scope(
        provider_id,
        provider.and_then(|provider| provider.base_url.as_deref()),
    );
    let query_key = (provider_id.to_string(), requested_scope.clone());
    let needs_query = force
        || cache()
            .read()
            .ok()
            .and_then(|state| state.queries.get(&query_key).cloned())
            .is_none_or(|(at, ids)| {
                at.elapsed() >= METADATA_TTL || model_ids.iter().any(|id| !ids.contains(id))
            });
    if needs_query {
        let mut windows = Vec::new();
        let mut source = "provider";
        if provider_id == "openai" {
            windows = read_local_openai_windows();
            source = "local";
        } else if provider_id == "ollama" {
            if let Ok(discovery) = gyro_core::discover_ollama_models(
                provider.and_then(|provider| provider.base_url.as_deref()),
            ) {
                windows = discovery
                    .models
                    .into_iter()
                    .filter_map(|model| {
                        model.context_window_tokens.map(|window| (model.id, window))
                    })
                    .collect();
            }
        } else if matches!(provider_id, "openrouter" | "mistral" | "deepseek")
            || provider.is_some_and(|provider| {
                provider.kind.as_deref() == Some(gyro_core::OPENAI_COMPATIBLE_KIND)
            })
        {
            let credential = gyro_core::try_provider_api_key_value(provider_id)
                .ok()
                .flatten()
                .unwrap_or_default();
            let can_query = provider_id == "openrouter"
                || !credential.is_empty()
                || provider.is_some_and(|provider| {
                    provider.enabled
                        && requested_scope.as_deref().is_some_and(|base| {
                            gyro_core::openai_compat_endpoint(base)
                                .is_ok_and(|url| gyro_core::openai_compat_host_is_loopback(&url))
                        })
                });
            if can_query {
                if let Some(base) = requested_scope.as_deref() {
                    if let Ok(discovery) =
                        gyro_core::openai_compat_list_model_metadata(base, &credential, model_ids)
                    {
                        windows = discovery
                            .models
                            .into_iter()
                            .filter_map(|model| {
                                model.context_window_tokens.map(|window| (model.id, window))
                            })
                            .collect();
                    }
                }
            }
        }
        if let Ok(mut state) = cache().write() {
            for (model, window) in windows {
                if model_ids.iter().any(|id| id == &model) {
                    remember(
                        &mut state,
                        provider_id,
                        &model,
                        window,
                        source,
                        requested_scope.clone(),
                    );
                }
            }
            // Negative results are cached too; unavailable metadata cannot trigger a request storm.
            state
                .queries
                .retain(|_, (at, _)| at.elapsed() < METADATA_TTL);
            let mut queried = state
                .queries
                .get(&query_key)
                .map(|(_, ids)| ids.clone())
                .unwrap_or_default();
            queried.extend(model_ids.iter().cloned());
            state.queries.insert(query_key, (Instant::now(), queried));
        }
    }
    let state = cache()
        .read()
        .map_err(|_| "model context cache unavailable")?;
    Ok(model_ids
        .iter()
        .map(|model| {
            let entry = state
                .entries
                .get(&(provider_id.to_string(), model.clone()))
                .filter(|entry| fresh(entry, &requested_scope));
            let catalog = super::provider_context::catalog_context_window(provider_id, Some(model));
            ModelContextWindow {
                provider_id: provider_id.to_string(),
                model_id: model.clone(),
                context_window_tokens: entry.map(|entry| entry.window).or(catalog),
                source: entry
                    .map(|entry| entry.source)
                    .unwrap_or(if catalog.is_some() {
                        "catalog"
                    } else {
                        "unknown"
                    })
                    .into(),
                checked_at: entry
                    .map(|entry| entry.checked_at.clone())
                    .unwrap_or_else(|| {
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    }),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provisioned_runtime_limit_wins_over_metadata_and_is_model_scoped() {
        let mut state = Cache::default();
        remember(&mut state, "xai", "grok-a", 128_000, "runtime", None);
        remember(&mut state, "xai", "grok-a", 500_000, "provider", None);
        remember(&mut state, "xai", "grok-b", 1_000_000, "provider", None);
        assert_eq!(
            state.entries[&("xai".into(), "grok-a".into())].window,
            128_000
        );
        assert_eq!(
            state.entries[&("xai".into(), "grok-b".into())].window,
            1_000_000
        );
        assert!(!state
            .entries
            .contains_key(&("openrouter".into(), "grok-a".into())));
    }
    #[test]
    fn changed_endpoint_and_expired_reading_do_not_supply_a_limit() {
        let mut state = Cache::default();
        remember(
            &mut state,
            "custom",
            "model",
            32_768,
            "provider",
            Some("http://localhost:1/v1".into()),
        );
        let entry = state
            .entries
            .get_mut(&("custom".into(), "model".into()))
            .unwrap();
        assert!(!fresh(entry, &Some("http://localhost:2/v1".into())));
        entry.at = Instant::now() - METADATA_TTL - Duration::from_secs(1);
        assert!(!fresh(entry, &entry.scope));
    }
    #[test]
    fn local_metadata_rejects_invalid_windows_and_preserves_exact_ids() {
        let windows = local_openai_windows(
            r#"{"models":[{"slug":"gpt-a","context_window":500000},{"slug":"gpt-b","context_window":272000},{"slug":"bad","context_window":0},{"slug":"bad2","context_window":"1000000"}]}"#,
        );
        assert_eq!(
            windows,
            vec![("gpt-a".into(), 500_000), ("gpt-b".into(), 272_000)]
        );
    }
}
