//! Explicit zero-network OS Keychain mechanism acceptance, with synthetic values.
//! Does not open Gyro, access owner entries, authenticate, send email or spend.
#[cfg(all(target_os = "macos", debug_assertions))]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    use gyro_core::cloud_connection::supabase::MacKeychain;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    use uuid::Uuid;
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() == 3 && args[0] == "--child" {
        MacKeychain::isolated_acceptance_step(Uuid::parse_str(&args[1])?, &args[2])?;
        return Ok(());
    }
    if !args.is_empty() {
        return Err("No operator-supplied namespace or arguments accepted".into());
    }
    let namespace = Uuid::new_v4();
    let binary = std::env::current_exe()?;
    let step = |name: &str| -> Result<(), Box<dyn std::error::Error>> {
        let mut child = Command::new(&binary)
            .args(["--child", &namespace.to_string(), name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        let started = Instant::now();
        loop {
            let status = match child.try_wait() {
                Ok(status) => status,
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Could not wait for isolated Keychain child".into());
                }
            };
            if let Some(status) = status {
                if status.success() {
                    return Ok(());
                }
                return Err(format!(
                    "Isolated Keychain step failed: {name}; upstream output suppressed"
                )
                .into());
            }
            if started.elapsed() >= Duration::from_secs(20) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Isolated Keychain step timed out: {name}").into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    let result = (|| {
        for name in [
            "absent",
            "save",
            "load",
            "rotate",
            "load-rotated",
            "reject-other-project",
            "clear",
            "absent",
        ] {
            step(name)?;
            println!("PASS isolated Keychain: {name}");
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    })();
    let cleanup = step("clear");
    result?;
    cleanup?;
    println!("PASS: real macOS Keychain across eight fresh processes; synthetic refresh storage, rotation, project mismatch rejection and deletion. No owner credential, hosted Auth, payment or provider was exercised.");
    Ok(())
}
fn main() {
    #[cfg(all(target_os = "macos", debug_assertions))]
    if let Err(_) = run() {
        eprintln!("Isolated native Keychain acceptance failed. No real credentials or upstream errors are printed.");
        std::process::exit(1);
    }
    #[cfg(not(all(target_os = "macos", debug_assertions)))]
    {
        eprintln!("This isolated acceptance probe requires a macOS debug build.");
        std::process::exit(1);
    }
}
