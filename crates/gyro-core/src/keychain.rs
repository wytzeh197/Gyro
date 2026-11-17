use anyhow::{Context, Result};

const SERVICE_NAME: &str = "Gyro";

/// Upgrade existing installations before warming provider connections. No
/// plaintext entry is discarded unless every Keychain write was verified.
pub fn migrate_legacy_credentials() -> Result<()> {
    #[cfg(all(target_os = "macos", not(test)))]
    {
        #[cfg(debug_assertions)]
        if empty_fixture_store() {
            return Ok(());
        }
        local_secrets::migrate_all(|account, value| {
            secure_write(account, value)?;
            macos_read::forget(account);
            Ok(())
        })?;
    }
    Ok(())
}

pub fn set_api_key(account: &str, value: &str) -> Result<()> {
    // Unit tests must not write the user's credential file.
    #[cfg(test)]
    {
        let _ = (account, value);
        return Ok(());
    }
    #[cfg(not(test))]
    {
        #[cfg(target_os = "macos")]
        {
            local_secrets::secure_transaction(account, |_| secure_write(account, value))?;
            macos_read::forget(account);
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        local_secrets::set(account, value).context("store credential on this Mac")
    }
}

pub fn get_api_key(account: &str) -> Result<Option<String>> {
    // Explicit debug fixtures use an empty credential store only with an
    // isolated temporary HOME. Normal app/benchmark runs keep real credentials.
    #[cfg(debug_assertions)]
    if empty_fixture_store() {
        return Ok(None);
    }
    // Unit fixtures must not consume the user's credentials. Binary/native
    // integration tests exercise the actual reader protocol separately.
    #[cfg(test)]
    {
        let _ = account;
        return Ok(None);
    }
    #[cfg(not(test))]
    {
        #[cfg(target_os = "macos")]
        return local_secrets::secure_transaction(account, |legacy| {
            if let Some(value) = legacy {
                secure_write(account, value)?;
                macos_read::forget(account);
                return Ok(Some(value.to_owned()));
            }
            // A denied read is an error, never an absent credential.
            macos_read::get(account)
        });
        #[cfg(not(target_os = "macos"))]
        local_secrets::get(account).context("read credential on this Mac")
    }
}

#[cfg(debug_assertions)]
fn empty_fixture_store() -> bool {
    if std::env::var("GYRO_TEST_EMPTY_KEYCHAIN").as_deref() != Ok("1") {
        return false;
    }
    let Some(home) = std::env::var_os("HOME") else {
        return false;
    };
    let Ok(home) = std::path::PathBuf::from(home).canonicalize() else {
        return false;
    };
    let Ok(temp) = std::env::temp_dir().canonicalize() else {
        return false;
    };
    fixture_home_is_temporary(&home, &temp)
}

#[cfg(debug_assertions)]
fn fixture_home_is_temporary(home: &std::path::Path, temp: &std::path::Path) -> bool {
    (home != temp && home.starts_with(temp))
        || (home != std::path::Path::new("/private/tmp") && home.starts_with("/private/tmp"))
}

#[cfg(all(test, debug_assertions))]
mod fixture_tests {
    use super::fixture_home_is_temporary;
    use std::path::Path;

    #[test]
    fn empty_fixture_credentials_require_an_isolated_temporary_home() {
        let temp = Path::new("/private/var/folders/fixture/T");
        assert!(fixture_home_is_temporary(&temp.join("fixture/home"), temp));
        assert!(fixture_home_is_temporary(
            Path::new("/private/tmp/fixture/home"),
            temp
        ));
        assert!(!fixture_home_is_temporary(
            Path::new("/Users/fixture"),
            temp
        ));
        assert!(!fixture_home_is_temporary(temp, temp));
        assert!(!fixture_home_is_temporary(Path::new("/private/tmp"), temp));
    }
}

fn get_api_key_direct(account: &str) -> Result<Option<String>> {
    match keyring::Entry::new(SERVICE_NAME, account)
        .context("open macOS keychain entry")?
        .get_password()
    {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error).context("read provider API key from keychain"),
    }
}

mod local_secrets;
#[cfg(target_os = "macos")]
pub(crate) mod macos_read;

/// Called before CLI/Tauri startup. The isolated reader has private pipes and
/// cannot change the parent application's Keychain interaction policy.
pub fn run_read_helper() -> Option<i32> {
    #[cfg(target_os = "macos")]
    return crate::cloud_connection::supabase::store::macos::run_helper()
        .or_else(macos_read::run_helper);
    #[cfg(not(target_os = "macos"))]
    None
}

pub fn delete_api_key(account: &str) -> Result<()> {
    #[cfg(test)]
    {
        let _ = account;
        return Ok(());
    }
    #[cfg(not(test))]
    {
        #[cfg(target_os = "macos")]
        {
            local_secrets::secure_transaction(account, |_| {
                match keyring::Entry::new(SERVICE_NAME, account)?.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(error) => Err(error).context("delete credential from Keychain"),
                }
            })?;
            macos_read::forget(account);
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        local_secrets::delete(account).context("delete credential on this Mac")
    }
}

#[cfg(all(target_os = "macos", not(test)))]
fn secure_write(account: &str, value: &str) -> Result<()> {
    local_secrets::validate(account, value)?;
    let entry = keyring::Entry::new(SERVICE_NAME, account).context("open Keychain entry")?;
    entry
        .set_password(value)
        .context("save credential in Keychain")?;
    anyhow::ensure!(
        entry.get_password().context("verify Keychain credential")? == value,
        "Keychain credential verification failed"
    );
    Ok(())
}

/// Preserve the existing device identity. A denied Keychain read must never
/// create a replacement identity and silently invalidate trusted pairings.
pub fn remote_device_identity(generate: impl FnOnce() -> [u8; 32]) -> Result<[u8; 32]> {
    use base64::Engine;
    const ACCOUNT: &str = "remote-device:dev.gyro.desktop";
    fn decode(value: &str) -> Result<[u8; 32]> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(value)
            .context("invalid saved remote device identity")?
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid saved remote device identity"))
    }
    #[cfg(all(target_os = "macos", not(test)))]
    let encoded = local_secrets::secure_transaction(ACCOUNT, |plain| {
        let value = if let Some(value) = plain {
            value.to_owned()
        } else if let Some(value) = macos_read::get(ACCOUNT)? {
            return Ok(value);
        } else if let Some(value) = macos_read::remote_identity()? {
            value
        } else {
            base64::engine::general_purpose::STANDARD.encode(generate())
        };
        decode(&value)?;
        secure_write(ACCOUNT, &value)?;
        macos_read::forget(ACCOUNT);
        Ok(value)
    })?;
    #[cfg(any(not(target_os = "macos"), test))]
    let encoded = local_secrets::get_or_insert_with(ACCOUNT, || {
        Ok(base64::engine::general_purpose::STANDARD.encode(generate()))
    })?;
    decode(&encoded)
}
