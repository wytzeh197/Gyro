use super::to_string;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderApiKeyStatus {
    provider_id: String,
    configured: bool,
    env_name: Option<String>,
    supported: bool,
}

#[tauri::command]
pub(crate) async fn provider_api_key_status(
    provider_id: String,
) -> Result<ProviderApiKeyStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(ProviderApiKeyStatus {
            supported: gyro_core::provider_supports_api_key(&provider_id),
            env_name: gyro_core::provider_api_key_env_name(&provider_id).map(str::to_string),
            configured: gyro_core::stored_provider_api_key(&provider_id)
                .map_err(to_string)?
                .is_some(),
            provider_id,
        })
    })
    .await
    .map_err(|error| format!("provider API key status worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn set_provider_api_key(
    provider_id: String,
    value: String,
) -> Result<ProviderApiKeyStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gyro_core::set_stored_provider_api_key(&provider_id, &value).map_err(to_string)?;
        // A cached probe was taken before this key existed, so it must not keep
        // answering "not signed in" now that Gyro holds one.
        gyro_core::invalidate_provider_health_cache();
        Ok(ProviderApiKeyStatus {
            supported: true,
            env_name: gyro_core::provider_api_key_env_name(&provider_id).map(str::to_string),
            configured: true,
            provider_id,
        })
    })
    .await
    .map_err(|error| format!("provider API key save worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn clear_provider_api_key(
    provider_id: String,
) -> Result<ProviderApiKeyStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gyro_core::clear_stored_provider_api_key(&provider_id).map_err(to_string)?;
        // The opposite of the save path: a cached "signed in" must not outlive
        // the key it was taken from.
        gyro_core::invalidate_provider_health_cache();
        Ok(ProviderApiKeyStatus {
            supported: gyro_core::provider_supports_api_key(&provider_id),
            env_name: gyro_core::provider_api_key_env_name(&provider_id).map(str::to_string),
            configured: false,
            provider_id,
        })
    })
    .await
    .map_err(|error| format!("provider API key clear worker failed: {error}"))?
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomProviderModel {
    id: String,
    display_name: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomProviderModels {
    base_url: String,
    models: Vec<CustomProviderModel>,
}

/// List the models an endpoint advertises, for the Settings "Fetch models"
/// button.
///
/// The stored key is read here rather than handed to the renderer, which never
/// receives one. A draft key can also be passed for a provider that has not been
/// saved yet, so the button works while the form is still being filled in.
#[tauri::command]
pub(crate) async fn list_custom_provider_models(
    base_url: String,
    provider_id: Option<String>,
    api_key: Option<String>,
) -> Result<CustomProviderModels, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api_key = api_key
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                provider_id
                    .as_deref()
                    .and_then(gyro_core::provider_api_key_value)
            })
            .unwrap_or_default();
        let discovery =
            gyro_core::openai_compat_list_models(&base_url, &api_key).map_err(to_string)?;
        Ok(CustomProviderModels {
            base_url: discovery.base_url,
            models: discovery
                .models
                .into_iter()
                .map(|model| CustomProviderModel {
                    id: model.id,
                    display_name: model.display_name,
                })
                .collect(),
        })
    })
    .await
    .map_err(|error| format!("provider model discovery worker failed: {error}"))?
}
