use anyhow::{Context, Result};

const SERVICE_NAME: &str = "Gyro";

pub fn set_api_key(account: &str, value: &str) -> Result<()> {
    keyring::Entry::new(SERVICE_NAME, account)
        .context("open macOS keychain entry")?
        .set_password(value)
        .context("store provider API key in keychain")
}

pub fn get_api_key(account: &str) -> Result<Option<String>> {
    match keyring::Entry::new(SERVICE_NAME, account)
        .context("open macOS keychain entry")?
        .get_password()
    {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error).context("read provider API key from keychain"),
    }
}

pub fn delete_api_key(account: &str) -> Result<()> {
    match keyring::Entry::new(SERVICE_NAME, account)
        .context("open macOS keychain entry")?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error).context("delete provider API key from keychain"),
    }
}
