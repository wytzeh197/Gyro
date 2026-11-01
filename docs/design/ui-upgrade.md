# Gyro UI upgrade — 10 October 2026

The approved Synara comparison informed a quieter shell, compact sent images,
consistent work feedback, and accurate draft identity.

## Changes

- Consolidated conversation and navigation polish from styles.css into
  chat-design.css and navigation-design.css, merging duplicate conversation rules.
- Retained content-fitting user bubbles (80% / 560px maximum) and the 5% composer reduction.
- Added 112px-wide, 80px-high sent-image previews with filename disclosure on
  hover/focus, accessible labels, and full-image opening.
- Unavailable images keep their filename and explanation without a large empty
  image tray. Documents and assistant file cards retain their captions.
- Extracted the attachment list into transcript-attachments.tsx to respect the
  existing shared-component architecture ceiling.
- Standardized header alignment, utility icons, focus styling, button targets,
  completed-change rows, and supporting panels.
- Added a quiet focused-pane header indicator and explicit semantic styling for
  approval, retry, failure, and cancellation states.
- Empty panes show New chat even if their caller supplies an old conversation title.
- Preserved completed-work collapse, native window offsets, permissions, scroll
  ownership, pane-close resolution, and drag/drop safeguards.

## Component preview

The standalone /ui-upgrade-fixture.html uses production AppChrome, ChatSurface,
ChatGridSurface, and file components with clearly labelled local sample data.
Controls cover both themes, all interface sizes, pane widths, reduced motion,
completed/running/approval/failed work, attachments, welcome, and split/close.

Approvals, retries, sends, and file actions update sample state only. The fixture
does not issue provider calls or native file operations.

## Verification

- Desktop and shared UI type checks.
- Production Vite build.
- Workbench smoke and UI-token checks.
- Chat-run, hardening, file-link, pane-close/target/new-session, scroll, and drag checks.
- Architecture, surface-boundary, and Browser-host bounds checks.
- Browser inspection in light/dark themes and Small/Default/Large sizes, including
  380px/480px/620px panes, contained composers, missing-image captions, full-image
  opening/dismissal, accurate draft titles, and draft preservation after sibling close.
- Failed-state Retry and sample approval actions reach the expected new state.
- Reduced-motion fixture controls remain reachable.

Source guards follow the extracted modules. The workbench catalog assertion now
matches the catalog's existing 500K context window for GPT-6.1 Sol; no model
catalog values changed.

The installed native app was not rebuilt or replaced. Packaged macOS appearance,
native keyboard focus, and real provider integration remain part of native
release acceptance. Browser fixtures do not establish full accessibility
compliance. Pointer-hover verification is limited when this chat's Browser is
hidden; structured labels and click previews remain inspectable.
