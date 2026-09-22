use std::io::Read;
use std::time::Duration;

// Fixed first-party data endpoint. Never accept a URL or credentials from the renderer.
const CATALOG_URL: &str = "https://usegyro.io/model-catalog.json";
const MAX_CATALOG_BYTES: u64 = 256 * 1024;

#[tauri::command]
pub async fn fetch_model_catalog() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(fetch_catalog)
        .await
        .map_err(|error| format!("model catalog worker failed: {error}"))?
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
    #[test]
    fn catalog_transport_bounds_and_encoding() {
        assert_eq!(read_catalog(&b"{}"[..]).unwrap(), "{}");
        assert!(read_catalog(vec![b' '; MAX_CATALOG_BYTES as usize + 1].as_slice()).is_err());
        assert!(read_catalog(&[0xff][..]).is_err());
    }
}
