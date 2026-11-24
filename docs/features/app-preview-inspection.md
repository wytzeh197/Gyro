# App Preview and Inspection Panel

Status — the snapshot workflow is implemented in source. A real Simulator run and installed-app acceptance still require an Xcode-equipped Mac.

## Set up iPhone and iPad previews

- Open **Set up Apple previews** from the Browser’s empty view or **Browser options → Preview target**. Gyro checks for full Xcode, its first-launch setup, an iOS runtime, and usable Simulator devices.
- Follow the Apple download link for your Mac or use **Choose Xcode…** to select an installed copy. Gyro saves the choice locally and uses it for its own Xcode commands.
- Open Xcode to finish its first-launch setup. Install **iOS** in **Xcode → Settings → Components**. The iOS runtime supports iPhone and iPad. Gyro checks again when you return, and **Check again** is available at any time.
- Pick a Simulator and select **Open preview**. Use **Run** in its preview to build the active project.

## Native preview workflow

- In the right-hand Browser panel, open **Preview target** and choose an installed iPhone or iPad Simulator, or a running Mac window. Switching back to **Web preview** restores that chat’s web page.
- Select **Run** to find Xcode schemes in the active workspace. Choose the scheme if there are several. Gyro builds locally, boots the selected Simulator when needed, and installs and launches the app. **Rebuild** uses the same scheme and destination. Build failures include an expandable log.
- The panel draws the device bezel around the app pixels. iPhone and iPad follow the captured orientation, and Mac windows sit inside a MacBook-style display. The hardware frame and cutouts stay in the preview layer. Portrait cutouts follow the selected Simulator model. The iPhone 12 and 13 mini have separate notch measurements. The iPhone 14 Pro, 14 Pro Max, 17 Pro, and 17 Pro Max use their own Dynamic Island proportions. For other models the preview uses the original Simulator pixels and a generic surround. Captures and annotation crops keep the original pixels.
- **Capture** saves the Simulator PNG at its original pixel dimensions. **Auto-refresh** fetches updated snapshots while the panel is visible. Use **Open in Device Hub** to interact with the simulated app, and refresh when returning to Gyro. Native Mac window inspection can dispatch an explicitly requested click with Accessibility permission.
- **Annotate** freezes a capture. Drag a region or choose **Select whole screen**, then send a comment and screenshot crop to the current chat. Image-capable models receive the crop. After rebuilding and returning to the same screen, refresh and use **Compare**. A narrow pane uses a Before / After switch.
- Simulator interaction and Xcode acceptance require a Mac with full Xcode and an installed runtime. The component fixture uses a 1206 × 2622 PNG and can verify geometry, selection, and comparison independently of Xcode.

## Earlier acceptance evidence

- UI and desktop TypeScript checks passed.
- Desktop Rust check passed.
- Four focused preview tests passed: ownership separation, capture identity/revision/expiry, Retina coordinate mapping and surround rejection, and actual PNG composition/orientation.
- PNG tool transport test passed for both ordinary browser screenshots and framed preview captures, including external-path rejection.
- Eleven session-browser tests passed.
- Provider capability manifest, browser capabilities, viewport behavior, host visibility, and background page-event/protected-target regression scripts passed.
- Gyro Browser rendered the actual panel component at desktop and narrow widths, in light and dark themes. Target switching, capture display, expiry labels, disconnected-runtime errors, and clearing a capture when returning to Web were observed.
- Screenshots in `artifacts/app-preview/` show **component fixture data**. They are not native application or Simulator acceptance evidence.

## Acceptance still blocked

- The explicit macOS acceptance harness failed at Screen Recording preflight for the test process before capture. Native window capture and click execution therefore remain unverified in this environment.
- `xcode-select -p` returned `/Library/Developer/CommandLineTools`; `xcrun --find simctl` and device listing failed. No Xcode application was found in /Applications. A full Xcode installation and booted iPhone runtime are needed for device acceptance.
- The running Gyro build rejected background mouse input with “show this chat's Browser before using the mouse”. The source fix and page-event regression checks passed; this changed native code has not been installed/restarted and exercised through the live broker.
- The complete inspect → interact → edit → recapture workflow across real native runtimes is not accepted yet. macOS CoreGraphics capture is deprecated in favor of ScreenCaptureKit; a supported-OS runtime check remains necessary.

## Reproduce native acceptance after prerequisites

The test never selects arbitrary personal windows. It requires the dedicated window from `scripts/fixtures/app-preview-native.swift`.

```sh
mkdir -p artifacts/app-preview
swiftc scripts/fixtures/app-preview-native.swift -o artifacts/app-preview/native-fixture
artifacts/app-preview/native-fixture "$PWD/artifacts/app-preview/count.txt"
```

With that fixture running and Screen Recording/Accessibility granted to the actual test process:

```sh
GYRO_PREVIEW_NATIVE_DIR="$PWD/artifacts/app-preview" cargo test -p gyro-desktop app_preview::platform::tests::native_window_acceptance --lib --offline -- --ignored --nocapture
```

The harness requires a real button state change and writes before/after PNGs. This verifies the native module; it does not replace installed-app broker acceptance.
