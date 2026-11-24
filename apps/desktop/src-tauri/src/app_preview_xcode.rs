//! Xcode discovery and first-run checks for Apple previews.
use super::{simulator, Target};
use serde::Serialize;
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};

pub(super) struct Xcode {
    bundle: PathBuf,
    version: Option<String>,
    minimum_macos: Option<String>,
}

impl Xcode {
    fn at(path: &Path) -> Option<Self> {
        if !path.is_absolute() {
            return None;
        }
        let bundle = path.canonicalize().ok()?;
        if !bundle
            .join("Contents/Developer/usr/bin/xcodebuild")
            .is_file()
        {
            return None;
        }
        let plist = bundle.join("Contents/Info.plist");
        let read = |key| {
            let result = Command::new("/usr/bin/plutil")
                .args(["-extract", key, "raw", "-o", "-"])
                .arg(&plist)
                .output()
                .ok()?;
            result
                .status
                .success()
                .then(|| String::from_utf8_lossy(&result.stdout).trim().to_owned())
        };
        if read("CFBundleIdentifier").as_deref() != Some("com.apple.dt.Xcode") {
            return None;
        }
        Some(Self {
            bundle,
            version: read("CFBundleShortVersionString"),
            minimum_macos: read("LSMinimumSystemVersion"),
        })
    }

    pub(super) fn developer_dir(&self) -> PathBuf {
        self.bundle.join("Contents/Developer")
    }

    fn supports(&self, macos: Option<Version>, apple_silicon: bool) -> bool {
        let version = self.version.as_deref().and_then(Version::parse);
        if !apple_silicon && version.is_some_and(|version| version.0 >= 27) {
            return false;
        }
        let minimum = self.minimum_macos.as_deref().and_then(Version::parse);
        !matches!((macos, minimum), (Some(macos), Some(minimum)) if macos < minimum)
    }
}

fn choice_path() -> Result<PathBuf, String> {
    gyro_core::GyroPaths::for_current_user()
        .map(|paths| paths.base_dir.join("apple-preview-xcode.json"))
        .map_err(|error| error.to_string())
}

fn read_choice() -> Result<Option<PathBuf>, String> {
    match fs::read(choice_path()?) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Choose Xcode again to repair Gyro’s saved selection".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn choose(path: &Path) -> Result<(), String> {
    let xcode = Xcode::at(path).ok_or("Choose a full Xcode application")?;
    let (macos, apple_silicon) = host();
    if !xcode.supports(macos, apple_silicon) {
        return Err("This Xcode version can’t run on this Mac. Choose a compatible copy.".into());
    }
    let paths = gyro_core::GyroPaths::for_current_user().map_err(|e| e.to_string())?;
    paths.ensure().map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(&paths.base_dir).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, &xcode.bundle).map_err(|e| e.to_string())?;
    file.persist(choice_path()?).map_err(|e| e.to_string())?;
    Ok(())
}

fn bundle_for_developer_dir(path: &Path) -> &Path {
    if path.ends_with("Contents/Developer") {
        path.parent().and_then(Path::parent).unwrap_or(path)
    } else {
        path
    }
}

fn system_selection() -> Option<Xcode> {
    if let Some(path) = std::env::var_os("DEVELOPER_DIR") {
        if let Some(xcode) = Xcode::at(bundle_for_developer_dir(Path::new(&path))) {
            return Some(xcode);
        }
    }
    let result = Command::new("/usr/bin/xcode-select")
        .env_remove("DEVELOPER_DIR")
        .arg("-p")
        .output()
        .ok()?;
    if !result.status.success() {
        return None;
    }
    let path = String::from_utf8(result.stdout).ok()?;
    Xcode::at(bundle_for_developer_dir(Path::new(path.trim())))
}

pub(super) fn selected() -> Result<Option<Xcode>, String> {
    if let Some(path) = read_choice()? {
        return Xcode::at(&path).map(Some).ok_or_else(|| {
            "Gyro’s selected Xcode was moved or removed. Choose Xcode again.".into()
        });
    }
    if let Some(xcode) = system_selection() {
        return Ok(Some(xcode));
    }
    let mut directories = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::home_dir() {
        directories.push(home.join("Applications"));
    }
    let mut first_incompatible = None;
    let (macos, apple_silicon) = host();
    for directory in directories {
        let mut apps = fs::read_dir(&directory)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "app"))
            .collect::<Vec<_>>();
        let standard = directory.join("Xcode.app");
        apps.sort_by(|a, b| (a != &standard, a).cmp(&(b != &standard, b)));
        for xcode in apps.iter().filter_map(|path| Xcode::at(path)) {
            if xcode.supports(macos, apple_silicon) {
                return Ok(Some(xcode));
            }
            first_incompatible.get_or_insert(xcode);
        }
    }
    Ok(first_incompatible)
}

pub(super) fn require() -> Result<Xcode, String> {
    selected()?.ok_or_else(|| "Set up Apple previews to use iPhone and iPad Simulators".into())
}

pub(super) fn open() -> Result<(), String> {
    let xcode = require()?;
    let status = Command::new("/usr/bin/open")
        .arg(&xcode.bundle)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not open Xcode".into())
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Version(u32, u32, u32);

impl Version {
    fn parse(value: &str) -> Option<Self> {
        let mut parts = value.trim().split('.');
        Some(Self(
            parts.next()?.parse().ok()?,
            parts.next().unwrap_or("0").parse().ok()?,
            parts.next().unwrap_or("0").parse().ok()?,
        ))
    }
}

fn host() -> (Option<Version>, bool) {
    let macos = Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| Version::parse(&String::from_utf8_lossy(&output.stdout)));
    let apple_silicon = cfg!(target_arch = "aarch64")
        || Command::new("/usr/sbin/sysctl")
            .args(["-n", "hw.optional.arm64"])
            .output()
            .is_ok_and(|output| output.status.success() && output.stdout.starts_with(b"1"));
    (macos, apple_silicon)
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum State {
    Missing,
    Incompatible,
    FirstLaunch,
    Runtime,
    Devices,
    Ready,
    Error,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum Download {
    AppStore,
    Version { version: &'static str },
    Requirements,
}

// Compatibility table: https://developer.apple.com/xcode/system-requirements/
// Xcode 27 requires Apple silicon.
// Future macOS versions on Intel fall back to Apple’s requirements page.
fn download(macos: Option<Version>, apple_silicon: bool) -> Download {
    let version = match macos {
        Some(v) if apple_silicon && v >= Version(26, 6, 0) => return Download::AppStore,
        Some(Version(26, 2.., _)) => "26.6",
        Some(Version(26, _, _) | Version(15, 6.., _)) => "26.3",
        Some(Version(15, 3.., _)) => "16.4",
        Some(Version(15, 2, _)) => "16.3",
        Some(Version(15, _, _) | Version(14, 5.., _)) => "16.2",
        Some(Version(14, _, _)) => "15.4",
        _ => return Download::Requirements,
    };
    Download::Version { version }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Setup {
    state: State,
    download: Download,
    macos: Option<String>,
    xcode: Option<String>,
    detail: Option<String>,
    devices: Vec<Target>,
}

pub(super) fn setup() -> Setup {
    let (macos, apple_silicon) = host();
    let mut setup = Setup {
        state: State::Missing,
        download: download(macos, apple_silicon),
        macos: macos.map(|Version(major, minor, patch)| {
            if patch > 0 {
                format!("{major}.{minor}.{patch}")
            } else {
                format!("{major}.{minor}")
            }
        }),
        xcode: None,
        detail: None,
        devices: Vec::new(),
    };
    let xcode = match selected() {
        Ok(Some(xcode)) => xcode,
        Ok(None) => return setup,
        Err(error) => {
            setup.state = State::Error;
            setup.detail = Some(error);
            return setup;
        }
    };
    setup.xcode = Some(match &xcode.version {
        Some(version) => format!("Xcode {version}"),
        None => "Xcode".into(),
    });
    if !xcode.supports(macos, apple_silicon) {
        setup.state = State::Incompatible;
        return setup;
    }
    match probe(&xcode) {
        Ok((state, devices)) => {
            setup.state = state;
            setup.devices = devices;
        }
        Err(error) => {
            setup.state = State::Error;
            setup.detail = Some(error);
        }
    }
    setup
}

fn probe(xcode: &Xcode) -> Result<(State, Vec<Target>), String> {
    let command = |args: &[&str]| simulator::command_using(xcode, None, args, 15);
    if let Err(error) = command(&["xcodebuild", "-checkFirstLaunchStatus"]) {
        let lower = error.to_ascii_lowercase();
        let pending = error.starts_with("xcodebuild failed (exit status: 1)\n")
            && error.lines().skip(1).all(|line| line.trim().is_empty());
        if pending || lower.contains("-runfirstlaunch") || lower.contains("license agreement") {
            return Ok((State::FirstLaunch, Vec::new()));
        }
        return Err(error);
    }
    let runtimes = command(&["simctl", "list", "runtimes", "--json"])?;
    if !has_ios_runtime(&runtimes)? {
        return Ok((State::Runtime, Vec::new()));
    }
    let devices = simulator::targets_using(xcode)?;
    let state = if devices.is_empty() {
        State::Devices
    } else {
        State::Ready
    };
    Ok((state, devices))
}

fn has_ios_runtime(output: &[u8]) -> Result<bool, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Runtime {
        identifier: String,
        is_available: bool,
    }

    #[derive(serde::Deserialize)]
    struct Runtimes {
        runtimes: Vec<Runtime>,
    }

    let response: Runtimes = serde_json::from_slice(output)
        .map_err(|e| format!("Xcode returned invalid runtimes: {e}"))?;
    Ok(response.runtimes.iter().any(|runtime| {
        runtime.is_available
            && runtime
                .identifier
                .starts_with("com.apple.CoreSimulator.SimRuntime.iOS-")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_matches_the_host_instead_of_assuming_the_latest_xcode_runs() {
        assert_eq!(
            download(Some(Version(26, 2, 0)), true),
            Download::Version { version: "26.6" }
        );
        assert_eq!(download(Some(Version(26, 6, 0)), true), Download::AppStore);
        assert_eq!(
            download(Some(Version(26, 6, 0)), false),
            Download::Version { version: "26.6" }
        );
        assert_eq!(
            download(Some(Version(26, 1, 0)), true),
            Download::Version { version: "26.3" }
        );
        assert_eq!(
            download(Some(Version(14, 0, 0)), true),
            Download::Version { version: "15.4" }
        );
    }

    #[test]
    #[ignore = "requires a Mac with only Command Line Tools and empty Gyro test data"]
    fn detects_a_mac_without_full_xcode() {
        let setup = setup();
        assert_eq!(setup.state, State::Missing, "{setup:?}");
        assert!(setup.xcode.is_none());
        assert!(setup.devices.is_empty());
    }

    #[test]
    fn only_an_available_ios_runtime_satisfies_setup() {
        let runtimes = br#"{"runtimes":[
            {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","isAvailable":false},
            {"identifier":"com.apple.CoreSimulator.SimRuntime.tvOS-26-5","isAvailable":true}
        ]}"#;
        assert!(!has_ios_runtime(runtimes).unwrap());
        assert!(has_ios_runtime(
            br#"{"runtimes":[
            {"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","isAvailable":true}
        ]}"#
        )
        .unwrap());
        assert!(has_ios_runtime(b"{}").is_err());
    }
}
