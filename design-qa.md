# CLI surface design QA

final result: passed

## Target and evidence

- Source: `/Users/wytzehemrica/.codex/generated_images/01a08039-f9b8-7a50-854d-bfccc8114862/exec-d8318cd6-0dc8-495b-8907-258490053d26.png` (option 1).
- User correction: retain Sessions | Workspace; within Sessions, show terminals with provider logos only on the CLI surface.
- Implementation: `docs/screenshots/cli-cleanup/implemented.png`.
- Combined comparison: `docs/screenshots/cli-cleanup/comparison.png` (source left, implementation right).
- Source: 1568 × 1003 pixels. Native app capture: 1199 × 768 pixels. Source was proportionally downsampled to the capture size for comparison; no stretching. The native capture API does not report CSS viewport size or device pixel ratio.
- State: light theme, Codex CLI and Shell side by side, Shell selected. Terminal content is real output rather than the concept's illustrative text. The shell is idle, so its status is gray.

## Findings and iteration

The initial rendered design had two P2 spacing problems: the toolbar spacer inherited a hidden state at the current window width, and the provider-logo wrapper stretched inside the sidebar row. Fixed the spacer to flex and constrained provider logos to 16px. The subsequent capture and combined comparison show launch/menu actions at the right edge, readable sidebar names, and consistent logo alignment.

No remaining actionable P0/P1/P2 findings in the reviewed CLI chrome. Native terminal output, OS window controls, and the user-requested contextual sidebar intentionally differ from the concept. The CLI owns its welcome text and terminal scrollback wrapping; these were not replaced with mock content.

## Required fidelity checks

- Typography: existing native sans UI and monospace terminal renderer retained. Toolbar title and active pane title establish hierarchy without repeated status words or branch labels.
- Layout: one toolbar row, one header per pane, hairline grid separators, and no stacked terminal cards. Full-view comparison is sufficient for composition; headers and sidebar rows were also inspected in the full-resolution implementation capture.
- Colors: existing Gyro theme tokens retained, including the slightly tinted code background. Green indicates active CLI processes; gray indicates idle shells.
- Assets: existing provider-logo components reused, matching chat provider marks. No new raster assets are used by the implementation.
- Content: one New terminal launcher; secondary actions are in the overflow menu. Project context is shown once. The contextual sidebar retains New Session and Search. Back to chats restores the chat list. New Session → View open terminals returns to the existing grid without creating a process.

## Interaction verification

Verified in the running native development app:

- New Session → Codex CLI opens the CLI surface and contextual sidebar.
- Selecting a sidebar process focuses its interactive terminal.
- Overflow → Split terminal adds a pane and its sidebar entry.
- Closing the added shell removes both; closing a running CLI retains the termination confirmation.
- Back to chats restores project/chat navigation.
- New Session → View open terminals restores existing panes.
- Provider authentication warning now identifies cloudflare-api instead of the incorrect label “s”. No authentication was performed.

Desktop type checking and diff whitespace checks pass. The broad source-based workbench smoke suite reports the existing First chat check and a compact-sidebar chrome check amid concurrent shared styling changes; these are not a claim that the entire suite passes.

## Remaining coverage

Dark theme and additional native window sizes were not visually exercised in this pass. Responsive styles retain the existing single-column breakpoint. No deployment or installed-app replacement was performed.
