# Terminal appearance QA

Scope: apply the terminal styling from the user's Codex screenshots to Gyro's existing terminal surfaces. This is an adaptation inside Gyro, not a clone of Codex's full window.

Source visual: `/var/folders/tf/yjnx70vd6t54vg3cx_y7vq7h0000gn/T/TemporaryItems/NSIRD_screencaptureui_Z6V5yq/Screenshot 2026-09-08 at 16.16.48.png`; additional active-CLI reference supplied at 16.17.12.

Implementation: http://127.0.0.1:1420/, in-app browser tab 2. Screenshots are inline in the task's browser capture results (not saved as local image files). Final capture: focused Shell pane, white canvas, compact selected tab. Preview capture is 841 × 759 pixels; supplied source is 3164 × 1914, displayed at 2048 × 1239. Compare the terminal region and relative spacing rather than whole-window proportions: the preview uses a narrower window and different shell content.

## Findings and iteration

1. Initial capture showed an inherited blue-gray background and right-aligned tab. Fixed the shared xterm screen background rule and header justification.
2. Post-fix captures show left-aligned compact tabs and white output canvas. Focus mode and selecting another pane both retain the expected layout.

## Fidelity surfaces

- Typography: retained native monospace stack and 12px text; reduced line height to 1.2. Compact tab labels use 12px medium UI text.
- Spacing: 30px selected tab inside a 42px pane header; 16px terminal inset; 1px split dividers. Gyro retains its existing surface toolbar above the pane header intentionally.
- Colors: white light-mode canvas throughout the xterm host, screen and viewport; neutral gray selected tabs; no blue active stripe. Existing dark terminal canvas retained. ANSI colors remain controlled by the terminal application, with the renderer's contrast remapping disabled.
- Assets: existing terminal and close icons; no raster assets required in the terminal region.
- Copy: removed redundant routine Running/Ready labels from pane tabs. Stopped/failed/attention states remain available; stopped output has a quieter recovery notice.

## Checks and limitations

- Type checks and UI token validation passed.
- Browser checked focused mode and pane switching; earlier split capture exposed and led to correction of the canvas and tab alignment defects.
- Native provider output, including Codex's input band, is not reproduced in the browser fixture. Native CLI theme negotiation and dark-mode runtime remain unverified.
- No full-window pixel-fidelity claim: product navigation, preview content, viewport and Gyro's extra toolbar intentionally differ from the reference.

final result: passed


## Shared terminal tabs and drag placement

Source: `/Users/wytzehemrica/Desktop/Screenshot 2026-09-08 at 16.25.07.png` (1406 × 226 reference crop). Compare the terminal tab strip, not the surrounding application navigation.

Implementation evidence: inline in-app browser tab 2 captures in this task, 841 × 759 viewport. The strip uses 34px rounded selected tabs, a terminal icon, a close button, and a plus menu immediately beside the tabs. Native provider content differs from the preview fixtures intentionally.

Changed the previous two-level toolbar/pane headers to one shared tab strip. Hover reveals a drag grip. Dragging onto the body exposes labeled split targets. Panes remain keyed and mounted while hidden. Splits support up to four terminals; adding a fifth does not evict an existing terminal.

Interaction checks: created Shell and Claude preview tabs, dragged Shell left of Claude, dragged Claude above Shell, reordered tabs, split again after reordering, and closed Shell while Claude remained visible. Source-based placement regressions cover horizontal/vertical placement, moving existing panes without duplication, capacity, and changing the active tab. Type checks passed. Input/process continuity in a real native CLI remains a runtime test gap; browser verification covers the UI placement and retained renderer structure.

Visual iteration: removed inherited button outlines and old pane headers after the initial tab-strip capture. Final captures show one neutral strip and subtle split dividers. No raster assets are used in this terminal chrome. Typography follows the existing UI stack at 13px; terminal text is unchanged in this iteration. Existing app navigation intentionally differs from Codex.

final result: passed
