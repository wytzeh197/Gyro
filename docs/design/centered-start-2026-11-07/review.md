# Centered new-session composer: option B

Implemented the approved centered concept in `packages/ui/src/chat-start-polish.css`, imported after the existing design layers in `styles-entry.css`.

- The logo and heading stay centered above the composer, relative to the chat canvas.
- The composer uses an 800px layout width (760 rendered pixels at the default 0.95 interface scale), a 64px minimum writing area, and 12px toolbar gaps.
- Subtle separators distinguish model, reasoning, and voice controls when the composer is wider than 620px. Narrow composers keep the existing compact controls.
- Project, workspace, and branch controls are centered beneath the input.
- Existing semantic colors, radii, spacing, controls, status logic, and keyboard behavior are retained. Styles target empty, untiled chat surfaces; active chat composers are excluded.

## Review

| Check | Result | Evidence |
| --- | --- | --- |
| Tokens and components | Pass | Existing `--gyro-*` semantic tokens and existing composer controls; 800px uses the existing foundation composer width. |
| Centered hierarchy | Pass | `checks.json`: composer center matches canvas center exactly at all five viewport/theme/size combinations; heading and logo differ by less than 0.01px. |
| Dark/light and responsive layout | Pass in browser | `desktop.png`, `desktop-wide.png`, `light.png`, `large-narrow.png`, `narrow.png`; no horizontal page or toolbar overflow. |
| Status and actions | Pass in browser fixture | Empty input keeps Send disabled. Approval mode and selected provider remain driven by the fixture config. No provider requests were made. |
| Keyboard and menus | Pass in browser fixture | Model menu receives radio-item focus and supports ArrowDown; Escape dismisses it; effort selector opens. `effort-open.png`. Existing focus styling retained. |
| Error/loading states | Not visually verified | State logic and markup unchanged. |
| Native installed app | Not verified | Screenshot is the production UI running through the local development capture harness with demo project/provider data. The installed app was not replaced. |

Validation: UI TypeScript check and `git diff --check` passed. No commit or deployment performed.
