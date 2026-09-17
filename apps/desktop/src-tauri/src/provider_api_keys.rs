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
