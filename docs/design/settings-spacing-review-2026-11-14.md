# Settings spacing review — 14 November 2026

Reviewed all 18 current settings routes using their production React components and stylesheets, with simulated data. The local changes are scoped to `packages/ui/src/settings-layout.css`; existing work in the checkout was preserved.

## Findings and fixes

| Page | Result |
| --- | --- |
| General | Existing label, description and control spacing passed. |
| Appearance | Existing theme, density, motion and color spacing passed. |
| Keyboard Shortcuts | Editable shortcut labels and descriptions: 2px → 8px. |
| Models & accounts | Nested API-key and custom-provider sections previously touched preceding cards; added the existing 20px section spacing. Endpoint name/metadata: 3px → 8px. |
| Chat & agents | Default and expanded advanced/experimental sections passed. |
| Usage & limits | Allowance heading/detail: 3px → 8px. Added 12px above the provider dashboard. |
| CLI Profiles | Preset, table and notification spacing passed, including wrapped commands. |
| Permissions | Approval, workspace protection and macOS access copy passed. |
| Workspace | Scope, file/search and editor setting spacing passed. |
| Import projects | Archived-chat label/detail: 3px → 8px. Applied the same gap to project and job metadata. |
| Tools | Contribution name/metadata: 2px → 8px. Empty language-service state passed. |
| Gyro Cloud | Current unavailable-build state passed. |
| Plan & billing | Current unavailable-build state and informational sections passed. |
| Data & privacy | Local paths, transfer controls, diagnostics and reset spacing passed. |
| Remote access | Added 12px between section dividers and standalone pairing fields. |
| Updates | Current-build card, expanded details and preferences passed. |
| Help | Questions, expanded answers, support links and footer passed. |
| Account | Profile name/email: 2px → 8px. Sign-in action rows passed. |

The changes use existing `--gyro-space-standard`, `--gyro-space-section` and `--gyro-space-card` tokens. Ordinary preference rows already have a readable 4px label/detail gap and were left alone.

## Evidence and checks

- [Before/after gallery](../../artifacts/settings-spacing-2026-11-14/index.html): 72 full-page images per side (18 pages × 2 layouts × default/expanded), plus seven detailed comparisons.
- Wide dark: 1440 × 1000 viewport, comfortable spacing, default text size. Narrow light: 860 × 700 viewport, compact spacing, large text. Remote access uses its separate fixture; its theme and width change but it retains that fixture's default density/type scale.
- All 72 after captures: zero measured visible sibling-text gaps below 4px, zero unintended horizontal overflow, zero runtime exceptions. The geometry check excludes hidden disclosure content and screen-reader-only text. This is targeted layout evidence, not a universal pixel-level collision proof.
- `GYRO_TEST_ORIGIN=http://127.0.0.1:1432 node scripts/check-settings-redesign.mjs`: passed 73 rendered layouts and 10 interactions, including save-error feedback, import scan review, disclosure/search, reset cancellation and visible keyboard focus.
- `pnpm --filter @gyro-dev/ui typecheck`: passed.
- `prettier` applied to the changed stylesheet.

Full-page before screenshots were captured before the CSS edits. Detailed before screenshots render the same components with this task's added CSS removed, restoring their original spacing. Fixtures do not call live providers or alter real account, billing, import or remote settings.

## Design-system checklist

| Check | Outcome |
| --- | --- |
| Existing tokens and components | Pass: semantic spacing tokens; no new components, colors or type values. |
| Loading, empty, error and populated states | Partial: populated profiles/providers, empty usage/tools/import, unavailable Cloud/billing, and appearance save-error behavior exercised. Other live/backend states unverified. |
| Status accuracy and color semantics | Unchanged; fixture-derived status only. Live status unverified. |
| Action hierarchy | Unchanged. |
| Keyboard focus and control behavior | Pass in existing browser interaction suite. |
| Installed macOS app / WebKit | Unverified; no rebuild or reinstall performed. |

No commit or deployment was performed.
