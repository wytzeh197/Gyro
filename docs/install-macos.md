# Install Gyro on macOS

Gyro is a public Alpha for macOS 14 or newer. Download it from the
[Gyro download site](https://usegyro.io/). GitHub
[Releases](https://github.com/wytzeh197/Gyro/releases/latest) is the source of
the binaries and the fallback if the site cannot load release information.

## Choose the correct download

- **Apple Silicon** is for Macs with an Apple M-series chip.
- **Intel Mac** is for Macs whose processor is identified as Intel.

To check, open **Apple menu → About This Mac**. A **Chip** row names an Apple
M-series chip; a **Processor** row naming Intel needs the Intel build. The DMG
filenames end in `_aarch64.dmg` for Apple Silicon and `_x64.dmg` for Intel.

The site may highlight an architecture only when the browser exposes a reliable
signal. Always confirm the selection yourself before downloading.

## Install and open Gyro

1. Download the matching DMG.
2. Open the DMG and drag **Gyro.app** to the **Applications** shortcut.
3. Open **Applications** in Finder and try to open **Gyro**. macOS will block
   the first launch because this Alpha has no Apple Developer ID signature or
   notarization. Dismiss the warning.
4. Open **System Settings → Privacy & Security** and scroll to **Security**.
5. Select **Open Anyway** beside the Gyro message, authenticate if prompted,
   then confirm **Open**.

The **Open Anyway** button is available for about an hour after the blocked
launch attempt. Once confirmed, macOS records Gyro as an exception and normal
launches do not require these steps again unless the app changes.

Do not disable Gatekeeper and do not remove quarantine globally. If macOS says
the app is damaged or corrupt instead of offering **Open Anyway**, stop and
[report the release and filename](https://github.com/wytzeh197/Gyro/issues/new)
rather than bypassing the warning.

An organization may prevent **Open Anyway** on a managed Mac. Gyro cannot and
will not override that policy; ask the device administrator before installing
it.

## What “unsigned Alpha” means

Release app bundles use an ad-hoc code signature so macOS can verify their
internal structure. They are not signed with an Apple-issued Developer ID and
are not notarized by Apple, which is why the first-launch warning appears.

Tauri updater archives have a separate Gyro updater signature. That signature
lets an installed Gyro verify updates published by the project, but it does not
replace Apple signing or notarization.

## Verify the download

Every release includes `SHA256SUMS`. Download it from the same release, then
calculate the DMG checksum in Terminal:

```bash
cd ~/Downloads
shasum -a 256 Gyro_<version>_aarch64.dmg
```

Use `Gyro_<version>_x64.dmg` for an Intel download. The printed value must match
the value beside that exact filename in `SHA256SUMS`. Delete the DMG and report
an issue if it does not match.

## Update or roll back

Gyro can offer a project-signed update after a verified non-prerelease Alpha is
published. You can also replace Gyro.app with the matching DMG from the
[latest release](https://github.com/wytzeh197/Gyro/releases/latest).

To roll back:

1. Quit Gyro.
2. Back up `~/Library/Application Support/Gyro/` in Finder.
3. Download the required version from
   [previous releases](https://github.com/wytzeh197/Gyro/releases).
4. Replace Gyro.app in Applications with that version and follow the first-open
   steps again if macOS asks.

Read that release's compatibility notes before opening existing data with an
older Alpha.

## Uninstall

Quit Gyro and move **Gyro.app** from Applications to the Trash. To remove local
sessions and settings too, use Finder's **Go → Go to Folder** and move
`~/Library/Application Support/Gyro/` to the Trash. Removing that directory is
permanent, so back it up first if you may reinstall.

The Homebrew route documented in [Homebrew packaging](homebrew.md) installs
only the `gyro` CLI. It does not install Gyro.app or change macOS security
settings.

For source builds, follow [Build From Source](../README.md#build-from-source).
See the [privacy notes](privacy.md) for Gyro's local-data defaults and
[support options](../SUPPORT.md) when installation fails.
