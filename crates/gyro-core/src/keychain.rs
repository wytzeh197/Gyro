use anyhow::{Context, Result};

const SERVICE_NAME: &str = "Gyro";

pub fn set_api_key(account: &str, value: &str) -> Result<()> {
    // Unit tests must not write the user's credential file.
    #[cfg(test)]
    {
        let _ = (account, value);
        return Ok(());
    }
    #[cfg(not(test))]
    {
        local_secrets::set(account, value).context("store credential on this Mac")?;
        #[cfg(target_os = "macos")]
        macos_read::forget(account);
        Ok(())
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
        if let Some(value) = local_secrets::get(account).context("read credential on this Mac")? {
            return Ok(Some(value));
        }
        // A key saved by an older build still sits in the login keychain.
        // Copy it only when macOS can hand it over without a password sheet.
        // A sheet is never requested; the person pastes the key once instead.
        #[cfg(target_os = "macos")]
        {
            match macos_read::get(account) {
                Ok(Some(value)) => {
                    if local_secrets::set(account, &value).is_ok() {
                        macos_read::forget(account);
                    }
                    return Ok(Some(value));
                }
                Ok(None) => return Ok(None),
                Err(error) if macos_read::access_needs_user_interaction(&error) => {
                    return Ok(None);
                }
                Err(error) => return Err(error),
            }
        }
        #[cfg(not(target_os = "macos"))]
        Ok(None)
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
mod macos_read;

/// Called before CLI/Tauri startup. The isolated reader has private pipes and
/// cannot change the parent application's Keychain interaction policy.
pub fn run_read_helper() -> Option<i32> {
    #[cfg(target_os = "macos")]
    return macos_read::run_helper();
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
        macos_read::forget(account);
        local_secrets::delete(account).context("delete credential on this Mac")
    }
}
