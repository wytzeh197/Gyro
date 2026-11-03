# App Preview and Inspection Panel

Status: source implementation with partial acceptance, 2026-10-31. No install, release, commit, or dependency installation was performed.

## Implemented

- The Browser panel offers Web, discovered macOS windows, and booted iPhone Simulator targets. Selection belongs to the chat and workspace. An existing Web page remains separate from a native runtime.
- Four broker capabilities expose discovery, selection, framed PNG capture, and capture-bound clicks: `gyro_browser_targets`, `gyro_browser_select_target`, `gyro_browser_capture_preview`, `gyro_browser_preview_click`.
- Captures include the selected target, owner, timestamp, content rectangle, image dimensions, and a 15-second interaction expiry. PNG bytes use the existing validated private capture transport. Model captures also update the owning panel.
- Pointer coordinates use full framed-image pixels. The content rectangle maps them to CSS pixels for Web and logical window points for macOS; surrounds reject input. Selection, later captures, and dispatched clicks invalidate earlier references. Native clicks also recheck window identity/geometry, the current pixels, the front window, and the Accessibility hit target.
- macOS capture uses public CoreGraphics/AppKit APIs and requires Screen Recording. Native clicks require Accessibility and an unobscured verified window; text/protected controls require user interaction.
- Simulator discovery and PNG capture use installed `xcrun simctl` with a booted iPhone UDID. Device screenshots receive a phone surround. Simulator touch injection is **not implemented**; interact in Simulator and refresh the capture.
- Hidden Web input now uses the existing page-event path. It does not provide trusted OS events, native menus, HTML drag-and-drop, or CSS hover.
- Stale captures remain visibly labeled after expiry or disconnect. Changing targets removes the old image. This is snapshot inspection, not a live native video stream.

## Verified

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
