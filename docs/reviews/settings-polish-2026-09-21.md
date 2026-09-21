# Settings polish — 21 September 2026

Reviewed the existing September 12 audit, current SettingsSurface and search index, shared styles, and the local changes already in progress.

## Decisions

- Removed five fixed General rows: Startup behavior, Default workspace, Default surface, Session restore, and Continue sessions from CLI. They had no controls or callbacks; startup and restore also repeated the same information. Menu bar and model activity remain configurable.
- Removed the fixed Terminal font and Reduce motion rows from Appearance. This removes presentation-only values, not font behavior or support for the system's reduced-motion preference.
- Removed Advanced's Local socket row. It offered neither an action nor measured connection status. Storage paths, diagnostics export, and reset remain.
- Removed the eight corresponding search entries, renamed the model activity label consistently, and refreshed section summaries.
- Kept functional settings and the existing navigation. Provider setup, permissions, budgets, editor preferences, updates, and diagnostics have concrete user purposes; no backend settings were deleted.

## Design

Retained Gyro's existing font, theme tokens, blue/violet accents, and sidebar dimensions. Reduced outer padding and section gaps, replaced rounded group enclosures with thin separators, and restored consistent Appearance heading typography and description. Existing density and keyboard-focus rules remain.

## Validation

- UI and desktop TypeScript checks passed.
- Workbench smoke and UI token checks passed. Updated the existing density assertion to match its shorter description.
- Viewed delivered light and dark screenshots of the actual SettingsSurface in the development-only settings-preview.html harness.
- Browser interactions verified Dark selection, Quick actions becoming aria-checked=false, General navigation, and Follow becoming aria-pressed=true.
- The preview uses in-memory state. It does not prove native preference persistence or provider/native integrations. Full desktop sidebar and narrow-window layout were not visually verified in this pass.
- Existing unrelated changes were preserved. Nothing was committed or published.
