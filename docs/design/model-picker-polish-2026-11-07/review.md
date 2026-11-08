# Model picker spacing polish

Updated the production picker styles in `packages/ui/src/styles.css`. The panel is 360px wide, with a shared text inset, a separated header, more space between model classes, equal-width context badges, and explicit badge/check columns for models without context metadata. Colors, typography, radii, and spacing use Gyro's existing system.

## Review

| Check | Result | Evidence |
| --- | --- | --- |
| Tokens and components | Pass | Existing `--gyro-*` semantic tokens and production `ComposerModelRail`; no new components or colors. Panel width remains component geometry. |
| Populated layout | Pass | `picker.png`; all nine OpenAI model rows fit at 900×760, with no list overflow. |
| Status and selection | Pass in browser fixture | Active radio selection, checkmark, provider state, and header agree with fixture config. Status logic was unchanged. |
| Action hierarchy | Pass | One selected model; provider navigation and settings remain secondary. |
| Keyboard and focus | Pass in browser fixture | ArrowDown moves between models; ArrowLeft returns to the provider; ArrowRight restores the selected model. Existing focus outline remains visible. |
| Narrow viewport | Pass in browser fixture | At 420×760, panel remains within the viewport; shorter available height uses existing scroll/fade behavior. See `narrow.png`. |
| Empty, disconnected, sign-in, and warning states | Unverified visually | Existing markup and behavior unchanged; header remains nonshrinking and the empty-state pane remains flexible. |
| Native and live providers | Unverified | Screenshot uses the production component with local catalog/auth fixtures, without provider requests. |

Validation: UI TypeScript check and `git diff --check` passed. Screenshots are browser captures, not installed-app captures.
