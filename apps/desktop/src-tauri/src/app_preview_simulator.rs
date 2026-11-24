//! Local Xcode build and Simulator operations for an explicitly selected workspace.
use super::{xcode, Target};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const XCRUN: &str = "/usr/bin/xcrun";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Scheme {
    project: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    udid: uuid::Uuid,
    name: String,
    device_type_identifier: String,
    state: String,
    is_available: bool,
}

fn devices(xcode: &xcode::Xcode) -> Result<Vec<Device>, String> {
    let output = command_using(
        xcode,
        None,
        &["simctl", "list", "devices", "available", "--json"],
        15,
    )?;
    let groups: std::collections::BTreeMap<String, Vec<Device>> =
        serde_json::from_value(output_json(&output)?["devices"].clone())
            .map_err(|e| e.to_string())?;
    Ok(groups
        .into_iter()
        .filter(|(runtime, _)| runtime.starts_with("com.apple.CoreSimulator.SimRuntime.iOS-"))
        .flat_map(|(_, devices)| devices)
        .filter(|device| device.is_available && device_family(device).is_some())
        .collect())
}

fn device_family(device: &Device) -> Option<&'static str> {
    let model = device
        .device_type_identifier
        .strip_prefix("com.apple.CoreSimulator.SimDeviceType.")?;
    if model.starts_with("iPhone-") {
        Some("iPhone")
    } else if model.starts_with("iPad-") {
        Some("iPad")
    } else {
        None
    }
}

pub(super) fn targets() -> Result<Vec<Target>, String> {
    targets_using(&xcode::require()?)
}

pub(super) fn targets_using(xcode: &xcode::Xcode) -> Result<Vec<Target>, String> {
    Ok(devices(xcode)?
        .into_iter()
        .filter_map(|device| {
            let family = device_family(&device)?;
            Some(Target {
                id: format!("simulator:{}", device.udid),
                kind: "simulator".into(),
                title: device.name,
                width: 0.,
                height: 0.,
                window_id: None,
                pid: None,
                bounds: None,
                device_family: Some(family.into()),
                device_type: device
                    .device_type_identifier
                    .strip_prefix("com.apple.CoreSimulator.SimDeviceType.")
                    .map(str::to_owned),
                booted: Some(device.state == "Booted"),
            })
        })
        .collect())
}

pub(super) fn udid(target: &Target) -> Result<&str, String> {
    let id = target
        .id
        .strip_prefix("simulator:")
        .ok_or("Select a Simulator device first")?;
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid Simulator identifier")?;
    Ok(id)
}

fn output_json(bytes: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(bytes).map_err(|error| format!("Xcode returned invalid JSON: {error}"))
}

pub(super) fn command(
    root: Option<&Path>,
    args: &[&str],
    timeout_secs: u64,
) -> Result<Vec<u8>, String> {
    command_using(&xcode::require()?, root, args, timeout_secs)
}

pub(super) fn command_using(
    xcode: &xcode::Xcode,
    root: Option<&Path>,
    args: &[&str],
    timeout_secs: u64,
) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    use std::os::unix::process::CommandExt;
    let mut stdout = tempfile::tempfile().map_err(|e| e.to_string())?;
    let stderr = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut command = Command::new(XCRUN);
    command
        .env("DEVELOPER_DIR", xcode.developer_dir())
        .args(args)
        .process_group(0)
        .stdin(Stdio::null());
    if let Some(root) = root {
        command.current_dir(root);
    }
    let mut child = command
        .stdout(stdout.try_clone().map_err(|e| e.to_string())?)
        .stderr(stderr.try_clone().map_err(|e| e.to_string())?)
        .spawn()
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                if status.success() {
                    stdout.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
                    let mut bytes = Vec::new();
                    stdout
                        .take(8 * 1024 * 1024 + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|e| e.to_string())?;
                    if bytes.len() > 8 * 1024 * 1024 {
                        return Err("Xcode output exceeded the preview limit".into());
                    }
                    return Ok(bytes);
                }
                let mut lines = Vec::new();
                for mut file in [stderr, stdout] {
                    let len = file.metadata().map_err(|e| e.to_string())?.len();
                    file.seek(SeekFrom::Start(len.saturating_sub(16 * 1024)))
                        .map_err(|e| e.to_string())?;
                    let mut bytes = Vec::new();
                    file.take(16 * 1024)
                        .read_to_end(&mut bytes)
                        .map_err(|e| e.to_string())?;
                    if !bytes.is_empty() {
                        lines.push(String::from_utf8_lossy(&bytes).trim().to_owned());
                    }
                }
                return Err(format!(
                    "{} failed ({status})\n{}",
                    args[0],
                    lines.join("\n")
                ));
            }
            None if started.elapsed() >= Duration::from_secs(timeout_secs) => {
                // Stop build scripts and other children of the timed-out Xcode process too.
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.wait();
                return Err(format!("{} timed out", args[0]));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn project_flag(project: &Path) -> Result<&'static str, String> {
    match project.extension().and_then(std::ffi::OsStr::to_str) {
        Some("xcworkspace") => Ok("-workspace"),
        Some("xcodeproj") => Ok("-project"),
        _ => Err("Choose an Xcode project or workspace".into()),
    }
}

pub(super) fn schemes(root: &Path) -> Result<Vec<Scheme>, String> {
    let mut projects = Vec::new();
    let mut walk = walkdir::WalkDir::new(root)
        .max_depth(3)
        .sort_by_file_name()
        .into_iter();
    while let Some(entry) = walk.next() {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_dir() || entry.depth() == 0 {
            continue;
        }
        if project_flag(entry.path()).is_ok() {
            projects.push(entry.into_path());
            walk.skip_current_dir();
        } else if entry.file_name().to_str().is_some_and(|name| {
            name.starts_with('.')
                || matches!(
                    name,
                    "node_modules" | "target" | "build" | "Pods" | "DerivedData"
                )
        }) {
            walk.skip_current_dir();
        }
    }
    if projects.is_empty() {
        return Err("No Xcode project or workspace was found in this folder".into());
    }
    let xcode = xcode::require()?;
    let mut schemes = Vec::new();
    let mut first_error = None;
    for project in projects.into_iter().take(12) {
        let flag = project_flag(&project)?;
        let relative = project
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_str()
            .ok_or("Invalid project path")?;
        let result = command_using(
            &xcode,
            Some(root),
            &[
                "xcodebuild",
                flag,
                relative,
                "-list",
                "-json",
                "-disableAutomaticPackageResolution",
            ],
            45,
        )
        .and_then(|bytes| output_json(&bytes));
        match result {
            Ok(value) => {
                let key = if flag == "-workspace" {
                    "workspace"
                } else {
                    "project"
                };
                if let Some(items) = value[key]["schemes"].as_array() {
                    schemes.extend(items.iter().filter_map(Value::as_str).map(|name| Scheme {
                        project: relative.to_owned(),
                        name: name.to_owned(),
                    }));
                }
            }
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    if schemes.is_empty() {
        return Err(first_error.unwrap_or_else(|| "No Xcode schemes were found".into()));
    }
    Ok(schemes)
}

pub(super) fn run(
    root: &Path,
    derived: &Path,
    target: &Target,
    project: &str,
    scheme: &str,
    progress: impl Fn(&str),
) -> Result<(), String> {
    let project = root
        .join(project)
        .canonicalize()
        .map_err(|_| "Xcode project is unavailable")?;
    if !project.starts_with(root) || scheme.trim().is_empty() || scheme.len() > 512 {
        return Err("Choose a scheme from this workspace".into());
    }
    let flag = project_flag(&project)?;
    let id = udid(target)?;
    let destination = format!("platform=iOS Simulator,id={id}");
    let args = [
        "xcodebuild",
        flag,
        project.to_str().ok_or("Invalid project path")?,
        "-scheme",
        scheme,
        "-configuration",
        "Debug",
        "-destination",
        &destination,
        "-derivedDataPath",
        derived.to_str().ok_or("Invalid Derived Data path")?,
    ];
    let xcode = xcode::require()?;
    let run_command = |root, args: &[&str], timeout| command_using(&xcode, root, args, timeout);
    progress("Building");
    run_command(
        Some(root),
        &[args.as_slice(), &["-quiet", "build"]].concat(),
        600,
    )?;
    let settings = run_command(
        Some(root),
        &[args.as_slice(), &["-showBuildSettings", "-json"]].concat(),
        45,
    )?;
    let (product, bundle) = app_product(&output_json(&settings)?, scheme, derived)?;
    progress("Launching");
    let device = devices(&xcode)?
        .into_iter()
        .find(|device| device.udid.to_string().eq_ignore_ascii_case(id))
        .ok_or("The selected Simulator is unavailable")?;
    if device.state != "Booted" && device.state != "Booting" {
        run_command(None, &["simctl", "boot", id], 30)?;
    }
    run_command(None, &["simctl", "bootstatus", id, "-b"], 180)?;
    run_command(
        None,
        &[
            "simctl",
            "install",
            id,
            product.to_str().ok_or("Invalid app path")?,
        ],
        60,
    )?;
    run_command(
        None,
        &[
            "simctl",
            "launch",
            "--terminate-running-process",
            id,
            &bundle,
        ],
        30,
    )?;
    Ok(())
}

fn app_product(
    settings: &Value,
    scheme: &str,
    derived: &Path,
) -> Result<(PathBuf, String), String> {
    let mut apps = settings
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let build = &item["buildSettings"];
            let name = build["FULL_PRODUCT_NAME"].as_str()?;
            if build["PLATFORM_NAME"] != "iphonesimulator" || !name.ends_with(".app") {
                return None;
            }
            let path = Path::new(build["TARGET_BUILD_DIR"].as_str()?).join(name);
            let bundle = build["PRODUCT_BUNDLE_IDENTIFIER"].as_str()?;
            let target = item["target"].as_str().unwrap_or_default();
            Some((target, path, bundle))
        })
        .collect::<Vec<_>>();
    apps.dedup_by(|a, b| a.1 == b.1);
    let (_, path, bundle) = if apps.len() == 1 {
        apps.remove(0)
    } else {
        apps.into_iter()
            .find(|(target, _, _)| *target == scheme)
            .ok_or("The selected scheme must build an identifiable iOS app")?
    };
    let path = path
        .canonicalize()
        .map_err(|_| "The built iOS app could not be found")?;
    if !path.starts_with(derived.canonicalize().map_err(|e| e.to_string())?) {
        return Err("The built app is outside Gyro’s Derived Data folder".into());
    }
    Ok((path, bundle.to_owned()))
}

pub(super) fn open_device(target: &Target) -> Result<(), String> {
    let id = udid(target)?;
    let developer = xcode::require()?.developer_dir();
    let app = ["Device Hub.app", "Simulator.app"]
        .into_iter()
        .map(|name| developer.join("Applications").join(name))
        .find(|path| path.is_dir())
        .ok_or("Open Device Hub from Xcode and select this Simulator")?;
    let status = Command::new("/usr/bin/open")
        .arg("-a")
        .arg(app)
        .args(["--args", "-CurrentDeviceUDID", id])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not open Device Hub".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_family_uses_the_runtime_type_even_with_a_custom_device_name() {
        let mut device = Device {
            udid: uuid::Uuid::new_v4(),
            name: "Product design".into(),
            device_type_identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro".into(),
            state: "Shutdown".into(),
            is_available: true,
        };
        assert_eq!(device_family(&device), Some("iPhone"));
        device.device_type_identifier = "com.apple.CoreSimulator.SimDeviceType.iPad-Air".into();
        assert_eq!(device_family(&device), Some("iPad"));
        device.device_type_identifier = "com.apple.CoreSimulator.SimDeviceType.Apple-TV".into();
        assert_eq!(device_family(&device), None);
    }
}
