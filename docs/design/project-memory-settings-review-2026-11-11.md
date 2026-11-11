# Project memory in project settings — 2026-11-11

Project memory now lives in the existing Edit project dialog, reached by hovering the sidebar project folder. General and Project memory use the existing memory view buttons and semantic tokens. The separate sidebar memory row is removed. Memory uses a session belonging to the selected project, preferring its active session; it does not switch the active chat.

## Screen review

- **Pass — existing components and tokens:** reused ProjectMemoryPanel, its view controls, the native project dialog, and Gyro spacing/color/focus tokens. No new palette, typography, or component dependency.
- **Pass — states:** the existing browser fixture exercises loading, populated, empty, failed load, saved notes, suggestions, receipts, and preserved conflict drafts. Saving from the project dialog succeeds and leaves it open. Empty/error fixtures exercise the same panel standalone.
- **Pass — truthful status:** save success waits for the runtime operation; failed loading is distinct from empty memory. These checks use synthetic runtime data.
- **Pass — action hierarchy:** General and Project memory are mutually visible. Memory buttons are outside the project form, so a memory action cannot submit project settings. Each view keeps its existing primary action.
- **Pass — keyboard:** ArrowRight opens project details; Escape preserves a focused memory draft; closing the dialog restores focus to the project folder after modal removal.
- **Pass — layout:** visually inspected light, dark, General, and 480px-wide screenshots. The narrow dialog has no horizontal overflow.
- **Unverified — native/live:** no rebuilt or installed macOS app, actual project-memory file mutation, or live provider acceptance in this task.

## Validation

UI and desktop TypeScript checks passed. Sidebar project grouping passed. `pnpm test:project-memory:browser` passed with 13 captures, including mouse-hover navigation into the dialog, keyboard access, memory save, focus restoration, and narrow layout. See [capture manifest](../screenshots/2026-11-11-project-settings-memory/manifest.json) and [light popup](../screenshots/2026-11-11-project-settings-memory/memory-project-settings-light.png).

## Proposed project rule

Keep Project memory management inside the project's settings dialog. This follows Wytze's requested placement and keeps project configuration together without adding a row to the chat list. Proposed for the project's design guidance; shared instructions and vault memory were not changed.
