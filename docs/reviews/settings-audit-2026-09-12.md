# Settings review — 12 September 2026

Reviewed all 12 settings sections in the local capture harness, plus their React callbacks, reducer behavior, and relevant native implementation. Screenshots 01–12 show the initial review states; later images show fixes. This is not a claim that every native integration has been exercised.

## Completed fixes

- Removed the composer’s blue focus border. Focused and unfocused borders both measured `rgb(222, 225, 229)` in light mode; shadow is `none`. Individual button keyboard-focus indicators remain.
- Fixed exclusion/number entry, shortcut clearing and documentation, reset scope and dialog keyboard behavior, truncated CLI profiles, missing search entries, and misleading paths/status/permission descriptions.

## Validation

- UI and desktop TypeScript checks passed.
- Workbench smoke checks and UI token checks passed, including new reset-preservation and explicit keybinding-clear checks.
- `cargo test -p gyro-core usage::tests --lib`: 30 passed.
- Browser interaction checks cover the controls noted below, section navigation, search, and 860×620 layout. Native-only actions and live provider behavior remain limited as noted per section.

## Section-by-section evidence

### 1. General — Improved; preview controls checked

Verified navigation and model-follow selection. Explained Off, Peek, and Follow; clarified saved-view and per-chat workspace behavior. Added missing Menu bar and model activity search entries. Native menu-bar visibility was not exercised.

![General, initial review](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/01-general.png)

### 2. Appearance — Preview controls checked

Theme, density, and quick-action toggles changed state. Color callbacks are wired to persisted preferences. The screenshot records the initial light-theme view. Color picker and macOS Reduce Motion behavior were reviewed in code, not exhaustively tested.

![Appearance, initial review](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/02-appearance.png)

### 3. Keyboard — Fixed and interaction-tested

Corrected Command palette to Cmd+Shift+P, Search everything to Cmd+K, and navigation to Cmd+1/2/3. Removed the incorrect Cmd+1–9 and generic Cmd+F claims. Backspace now stores an explicit unassigned binding; reset restores the default. Bare keys and reserved search/save shortcuts are rejected with an explanation. Verified assignment, clearing, rejection, and reset in the browser. Custom shortcuts still require the relevant workspace/trust context.

![Keyboard, initial review](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/03-keyboard.png)

### 4. Usage Limits — Core tests pass; native integration limited

Bars/Wheels and daily warning controls responded. Clarified daily pace and current approval mode. Budget and pause callbacks are wired, but this capture harness returns a fixed safety snapshot and does not implement budget persistence, so the browser cannot prove those native actions. All 30 core usage tests passed, including budget thresholds and pause enforcement.

![Usage Limits, initial review](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/04-usage.png)

### 5. Providers — UI and wiring reviewed; sign-in untested

All provider rows, model choices, actions, and details menus were inspected in the DOM and code. Council is explicitly marked Coming soon. Provider authentication, live connection checks, disabling providers, and model downloads were not performed.

![Providers, initial review](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/05-providers.png)

### 6. CLI Profiles — Fixed and interaction-tested

Removed the seven-profile truncation so all saved profiles appear. Explained that this configures New Terminal. Verified pane count changes and First/Last focus selection. Actual terminal launches were not run as part of this review.

![CLI Profiles, initial review](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/06-cli.png)

### 7. Permissions — Misleading wording corrected; native access untested

Removed unconditional claims that network access asks and outside-workspace reads always require approval. These now describe provider/mode dependence. Clarified limits of secret-pattern redaction. Added search entries for workspace mode and post-edit summaries. Reviewed approval/config callback wiring. Did not change real security permissions or trigger macOS prompts.

![Permissions, initial review](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/07-permissions.png)

### 8. Editor & Search — Fixed and interaction-tested

Reproduced comma deletion: typing tmp/**, cache/** became tmp/**cache/**. Draft fields now preserve incomplete input and save on blur or Enter. Number fields normalize after editing. Verified both patterns, 250 maximum results, Minimap Off, and persistence across section changes. Inherit placeholders now reflect actual inherited values. Clearing a pattern field returns to inheritance. Scope handling and resolver logic reviewed.

![Editor & Search, initial review](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/08-editor.png)

### 9. Tools & Contributions — UI and validation paths reviewed

Language-service status and bundled contribution are visible. Reviewed JSON parsing, error handling, registration, enable/disable, and removal callback wiring. No external manifest was installed or executable contribution enabled.

![Tools & Contributions, initial review](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/09-tools.png)

### 10. Updates — Development state reviewed; installation untested

Automatic-check preference and updater callback wiring reviewed. Corrected retry wording to name the actual button. The preview reports Development and cannot verify signed production update download/install.

![Updates, initial review](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/10-updates.png)

### 11. Advanced — Fixed; reset regression test passes

Corrected storage/log paths to ~/Library/Application Support/Gyro and its logs subfolder, matching GyroPaths. Copy actions now report success/failure. Removed the hardcoded ready status masquerading as a live connection check. Reset now resets presentation preferences only, preserving open work, trust, keybindings, project configuration, and behavioral preferences. Added Cancel focus, Tab containment, Escape dismissal, and focus restoration; verified Escape in-browser. Native clipboard/diagnostics export not end-to-end tested. Compact 860×620 view has no horizontal page overflow.

![Advanced, initial review](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/11-advanced.png)

### 12. Help — Search checked; external links not opened

Verified searching full access returns the relevant answer. Reviewed help filters, section shortcuts, expandable answers, and support URLs. External destinations were not navigated; no support message was sent.

![Help, initial review](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/12-help.png)

## Verified fixes

![Focused composer without blue border](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/14-composer-focused-fixed.png)

![Editor values retained after navigation](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/15-editor-fixed.png)

![Advanced settings at 860×620](/Users/wytzehemrica/Documents/Gyro/docs/screenshots/settings-audit-2026-09-12/13-advanced-fixed-compact.png)

## Remaining verification limits

Live sign-in, provider connection health, actual budget/pause persistence through desktop IPC, macOS permissions and notifications, updater installation, contribution execution, and native diagnostics export require a desktop integration run. They were not declared working based on the preview. Screenshot review also does not establish full accessibility compliance; keyboard testing covered the controls and reset dialog described above.
