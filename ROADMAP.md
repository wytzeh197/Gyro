# Roadmap

Gyro is moving toward a private alpha that can be trusted for real local coding
work every day. The sequencing rule is simple: make one complete run clear,
recoverable, and safe before expanding into broader orchestration or ecosystem
work.

This roadmap is based on the implementation audit completed on 2026-07-11 and
the product entry and workbench plan. Supporting detail lives in:

- [`docs/product-readiness-audit.md`](docs/product-readiness-audit.md)
- [`docs/product-entry-and-workbench-plan.md`](docs/product-entry-and-workbench-plan.md)
- [`docs/release.md`](docs/release.md)
- [`docs/vision.md`](docs/vision.md)

## Roadmap Rules

These rules apply across every milestone:

1. Trust and data integrity outrank feature breadth.
2. Every visible action must work, explain why it is blocked, or be omitted.
3. Provider, model, workspace, branch, worktree, permission, and run state must
   reflect reality rather than optimistic UI state.
4. Commands, file edits, and sensitive context expansion must follow Gyro's
   explicit local approval policy.
5. Sessions must remain recoverable after app restarts, terminal failures,
   provider failures, and interrupted updates.
6. Distribution is part of the product: signing, notarization, checksums,
   architecture selection, updates, and rollback guidance are release gates.
7. New platforms, providers, and ecosystem surfaces begin only after the
   current milestone's exit gate is met.

## Current Position

Gyro is beyond its foundation phase and is closing the gap between an extensive
developer build and a dependable private alpha.

### Implemented foundations

- `gyro-core` local paths, SQLite session metadata, JSONL events, config,
  approval policy, redaction, Keychain access, worktrees, and local app IPC.
- `gyro` CLI chat, run, resume, sessions, setup, doctor, config, and app
  open/attach commands.
- Real PTY-backed terminal panes with input, resize, stop, restart, restore,
  xterm rendering, profiles, presets, and pane ordering.
- Desktop execution through Codex CLI and Claude Code with streaming, retries,
  resume cursors, diagnostics, and readiness checks.
- IDE workbench with workspace tree, Monaco buffers, guarded saves, search, Git
  status/stage/unstage, tasks, tests, output, and diagnostics.
- Local tasks, persisted automations, provider setup, diff review, settings, and
  a live local browser preview.
- Tauri application bundling, release checks, updater plumbing, Homebrew
  definitions, and a tag-driven release workflow.

## Private Alpha Exit Gate

Partially implemented and still gated, Gyro must clear the blockers below. The
implemented foundations above are necessary, but none of them replaces this
end-to-end exit gate.

- Provider-proposed edits do not yet share one atomic, typed
  propose/review/apply/reject/recover transaction.
- Always-on automation execution lacks durable scheduling, leases, recovery,
  and stop conditions.
- Provider onboarding still needs clean-machine acceptance coverage.
- LSP and DAP discovery exists, but lifecycle management is not production
  ready.
- Browser preview lacks automatic console/error collection and verified capture.
- Production Apple signing, notarization, updater keys, and clean-machine release
  proof are incomplete.
- The public download journey and first-run activation flow are not yet a single
  tested funnel.

## Surface Roadmaps

Chat, CLI, and IDE are three views into the same local-first execution engine.
They must share projects, sessions, providers, approvals, events, and recovery,
but each surface has a distinct primary job:

| Surface | Primary job                                                  | Must not become                                        |
| ------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| Chat    | Direct, review, and resume an agent run                      | A decorative message feed detached from real execution |
| CLI     | Operate Gyro quickly from a terminal and bridge into the app | A second session system with different rules           |
| IDE     | Understand, edit, run, and verify code with agent assistance | An editor clone that bypasses Gyro's trust model       |

Shared engine capabilities are planned once in the milestone roadmap below.
The surface tracks describe how each capability must appear and behave for the
user.

### Chat Surface Roadmap

#### Product role

Chat is Gyro's clearest path from intent to a trusted coding run. It should make
the conversation, execution state, proposed actions, evidence, and next decision
readable as one continuous record.

Chat owns:

- Starting and resuming provider-backed agent conversations.
- Showing the effective project, branch or worktree, provider, model, and
  approval policy.
- Presenting streaming responses, tool activity, approvals, edits, failures,
  results, and recovery in chronological context.
- Moving naturally into diff, terminal, file, task, or browser evidence without
  losing the conversation.

Chat does not own raw terminal multiplexing, full-file editing, or source-control
management. It links into those surfaces with explicit context.

#### v0.2 — Trusted conversation

Deliver:

- A project-backed new-chat state with no executable send action until a project
  and ready provider are selected.
- Always-visible run context: repository, branch/worktree, provider, model,
  approval mode, and current run state.
- Stable message and event rendering for user prompts, assistant text,
  reasoning summaries where available, tool calls, terminal commands, file
  proposals, approvals, diagnostics, retries, and completion.
- Streaming that preserves message order and does not duplicate content after
  reconnect or resume.
- Stop, retry, continue, and resume actions with precise semantics.
- Typed command and file-edit approval cards that explain scope, risk, and the
  effect of approval or rejection.
- Clear waiting, blocked, failed, cancelled, and completed states with a concrete
  next action.
- Attachment handling that shows exactly which local files or images will enter
  provider context.
- Session titles and summaries derived from real work, editable by the user, and
  never used as a replacement for the durable event record.

Validation:

- Long streaming response, tool interleaving, stop during streaming, provider
  crash, retry, app restart, stale resume cursor, and offline recovery.
- Approval accepted, rejected, expired, invalidated by disk changes, and restored
  after restart.
- Keyboard-only prompt, provider selection, approval, and session navigation.
- Large message, code block, diff, image attachment, and narrow-window rendering.

Exit gate:

- A user can read one Chat timeline and accurately explain what the agent was
  asked, what it attempted, what required approval, what changed, what failed,
  and what can happen next.

#### v0.2.2 — First-run Chat activation

Deliver:

- First-launch handoff from provider setup and project selection directly into a
  ready composer.
- Starter actions based on the selected repository, such as explain the project,
  diagnose a failure, plan a change, or inspect current Git state.
- Plain-language permission choices beside the composer with detailed policy
  available on demand.
- Honest unavailable-provider states with setup and diagnostic actions.
- A first-success moment based on a completed trusted action, not merely a sent
  message.

Exit gate:

- A clean user reaches a provider-backed, project-aware first response without
  editing configuration or guessing why send is disabled.

#### v0.3 — Parallel and handoff-aware Chat

Deliver:

- Multiple concurrent conversations with unambiguous project, worktree, branch,
  provider, and status identity.
- Typed handoff between supported providers with a preview of transferred
  context and explicit loss of provider-native resume state.
- Conversation grouping around tasks, worktrees, or goals without merging their
  durable histories.
- Cross-run references that link to evidence instead of copying hidden context.
- Resource and attention controls for simultaneous streaming, approvals, and
  notifications.

Exit gate:

- No message, approval, or tool event can be mistaken for another active run.

#### v0.4 — Code-intelligent Chat

Deliver:

- Symbol, diagnostic, test, diff, and debugger context selected through typed IDE
  references.
- Agent answers that link back to exact workspace evidence and preserve stale
  context warnings.
- Reusable skills and project policy surfaced as visible run context.
- Structured plan and implementation checkpoints that remain approval-aware.

Exit gate:

- Deeper code intelligence improves the conversation without granting Chat a
  separate file-mutation or execution path.

#### Chat measures

- Time from new Chat to first provider output.
- Stream completion, stop, retry, and resume success rates.
- Approval response time and invalidated-approval frequency.
- Provider setup recovery rate from Chat.
- Percentage of failed runs with a successful documented recovery action.

### CLI Surface Roadmap

#### Product role

The CLI is the fastest, scriptable, terminal-native route into the same Gyro
sessions and policies used by the desktop app. It should feel complete on its
own while making app handoff effortless when visual review becomes valuable.

The CLI owns:

- Setup, diagnostics, one-shot runs, interactive chat, session discovery,
  resume, configuration, and app open/attach.
- Machine-readable output for automation and integration.
- Terminal-native approval and recovery when the desktop app is absent.
- A reliable bridge between shell context and the desktop workbench.

The CLI does not own separate provider configuration, session storage, approval
rules, or mutation contracts.

#### v0.2 — Dependable local control

Deliver:

- Consistent command grammar and help for `setup`, `doctor`, `chat`, `run`,
  `resume`, `sessions`, `config`, and `app` workflows.
- Stable exit codes separating success, user cancellation, invalid input,
  unavailable provider, approval rejection, execution failure, and internal
  failure.
- Human-readable output for interactive use and versioned JSON output for tools.
- Provider and model readiness diagnostics matching the desktop state.
- Project discovery and explicit workspace selection without unsafe implicit
  traversal.
- Terminal-native command and file-edit approvals using the same typed proposal
  contract as Chat and IDE.
- Signal-safe cancellation and cleanup for Ctrl-C, terminated providers, and
  interrupted writes.
- Durable session creation and resume with correct working directory, branch,
  worktree, provider, model, and approval policy.
- `gyro doctor` remediation that distinguishes required failures from optional
  capabilities.

Validation:

- Interactive shell and non-interactive pipe behavior.
- TTY and non-TTY output, Unicode, narrow terminals, missing color support, and
  `NO_COLOR`.
- Ctrl-C during provider startup, streaming, command execution, approval, and
  file application.
- JSON schema snapshots and exit-code assertions for every top-level command.
- Missing app, app already running, stale IPC socket, and app handoff recovery.

Exit gate:

- A developer can install the CLI, diagnose setup, complete and resume a trusted
  run, and hand it to the app without session or policy divergence.

#### v0.2.1 — Installable CLI

Deliver:

- Signed or verifiable architecture-specific CLI archives published with each
  application release.
- Homebrew Formula using immutable release URLs and checksums.
- Shell completion generation for zsh, bash, and fish.
- `gyro --version` output aligned with release metadata.
- Clear compatibility behavior when CLI and app versions differ.
- Upgrade guidance that never silently changes third-party provider CLIs.

Exit gate:

- A clean macOS user can install, verify, run `gyro doctor`, and upgrade the CLI
  through the documented release channels.

#### v0.3 — Scriptable orchestration

Deliver:

- Explicit worktree and task targeting for parallel runs.
- Structured event streaming suitable for local automation.
- Non-interactive approval-policy constraints that fail closed when human input
  is required.
- Commands for task status, wait, stop, inspect, and handoff.
- Safe Git preparation flows with dry-run output and explicit publication
  approval.
- Automation commands backed by the durable scheduler rather than shell-only
  background processes.

Exit gate:

- Scripts can coordinate Gyro runs predictably without bypassing approval,
  workspace, or resource boundaries.

#### v0.4 — Extension and editor bridge

Deliver:

- Stable, versioned local IPC and event contracts for editor extensions.
- Commands that resolve symbols, diagnostics, tests, and workspace policies
  through `gyro-core`.
- Skill and plugin inspection, validation, and permission reporting.
- Debug bundles that redact secrets and project content by default.

Exit gate:

- External integrations use documented contracts and cannot require scraping
  human CLI output.

#### CLI measures

- Setup and doctor success on clean machines.
- Command success rate by stable exit-code category.
- Session resume and app-handoff success.
- Ctrl-C and crash cleanup correctness.
- JSON contract compatibility across releases.

### IDE Surface Roadmap

#### Product role

The IDE surface is where Gyro turns agent intent into inspectable code work. It
combines files, editor buffers, Git state, tasks, tests, diagnostics, terminals,
diffs, and browser evidence while keeping every mutation inside the shared trust
model.

The IDE owns:

- Workspace navigation, reading, editing, guarded saving, search, Git review,
  task/test execution, diagnostics, and verification evidence.
- Precise code context selection for agent actions.
- Visual review of proposals and the resulting on-disk/Git state.

The IDE does not own a second session engine, direct unlogged provider writes,
or editor actions that bypass workspace and approval boundaries.

#### v0.2 — Trusted code workbench

Deliver:

- Reliable workspace tree refresh, file open, tabs, dirty state, save, revert,
  rename, create, and delete behavior within workspace boundaries.
- Content-hash guarded saves with a three-way recovery path for stale buffers.
- Workspace search with cancellation, exclusions, result limits, and binary-file
  handling.
- Git status, diff, stage, and unstage derived from actual repository state.
- One typed diff review experience for manual edits and provider proposals.
- Task and test discovery with live output, cancellation, exit state, and links
  from failures to files.
- PTY-backed terminal panels with create, input, resize, stop, restart, restore,
  and visible output refresh.
- Live local browser preview with navigation, reload, responsive widths, console
  errors, external open, and verified capture.
- Problems and Output panels that distinguish diagnostics, tool output, provider
  output, task output, and application logs.
- Agent actions for selection, file, diagnostic, test failure, diff, and Git
  state using explicit context previews.

Validation:

- Dirty buffer, external file change, deleted file, rename collision, symlink
  escape, large file, binary file, and repository switch.
- Git stage/unstage in clean, dirty, conflicted, detached, and nested-repository
  states.
- Real task, test, terminal, browser, and provider execution through the desktop
  bridge.
- Restart with open tabs, stale buffers, restored panes, and unavailable files.
- Keyboard navigation, focus restoration, zoom, compact width, and reduced
  motion.

Exit gate:

- A user can inspect a repository, make or review a guarded change, run its
  validation, and understand the resulting disk and Git state without leaving
  Gyro.

#### v0.2.2 — Project-first activation

Deliver:

- **Open a project** as the primary empty-state action.
- Recent projects and resumable sessions with missing-path recovery.
- Repository summary containing branch, dirty state, detected languages, tasks,
  tests, and provider readiness.
- Honest progressive loading rather than a fully populated mock workbench.
- Guided first action that can open Chat, run a task, inspect Git, or explain the
  project without forcing a single workflow.

Exit gate:

- Opening a project produces a useful, truthful workbench even when no provider
  is configured or the machine is offline.

#### v0.3 — Parallel project workbench

Deliver:

- Multi-project and multi-worktree navigation with unmistakable visual identity.
- Editor tab ownership tied to repository and worktree.
- Cross-worktree diff and Git review without accidental mixed staging.
- Per-task terminals, output, browser previews, and resource limits.
- Branch creation, commit preparation, push, and pull-request preparation with
  explicit checkpoints.
- Cleanup guidance for completed, abandoned, dirty, or externally changed
  worktrees.

Exit gate:

- No editor, Git, terminal, task, or agent action can silently target a different
  repository or worktree than the surface indicates.

#### v0.4 — Language intelligence and debugging

Deliver:

- Production lifecycle for the first supported language server: start, reuse,
  cancellation, restart, crash recovery, workspace changes, and diagnostics.
- Go to definition, references, hover, symbols, rename preview, and refactor
  review.
- Agent actions grounded in fresh symbol and diagnostic context.
- Debug adapter lifecycle with launch configuration, breakpoints, variables,
  call stack, console, stop, restart, and crash recovery only after LSP maturity.
- Extension points that reuse `gyro-core` session, policy, event, and provider
  contracts.

Exit gate:

- Language and debug intelligence remain recoverable, cancellable, and clearly
  labelled when unavailable; no experimental scaffold is presented as complete.

#### IDE measures

- Project-open and workspace-index success.
- Guarded-save success, stale-buffer recovery, and path-boundary violations.
- Task/test completion and cancellation reliability.
- Git state accuracy after every IDE action.
- Terminal and browser verification success.
- Time from diagnostic or failed test to a reviewed fix.

### Surface Continuity Gates

The three surface roadmaps are complete only when continuity also holds:

1. A CLI-created session opens in Chat with the same project, provider, model,
   approval policy, and durable history.
2. A Chat proposal opens in IDE diff review without changing its identity,
   scope, or approval state.
3. An IDE-selected file, range, diagnostic, diff, or test failure enters Chat
   only after a visible context preview.
4. Commands launched from Chat or IDE appear in the same terminal/event model as
   CLI execution.
5. Stop, failure, approval, and completion state cannot disagree between
   surfaces.
6. App and CLI version skew is detected and handled without corrupting shared
   sessions.

## Design Roadmap

### Design outcome

Gyro should feel like a calm operational workspace even when it is presenting
complex agent, terminal, code, diff, Git, provider, and approval state. Clean
design does not mean removing capability. It means showing the right layer of
complexity at the right time and giving every visible element a clear role.

The design must remain recognizably Gyro: local-first, approval-aware, precise,
and built around continuity between Chat, CLI, and IDE. Visual polish must make
trust and state easier to understand rather than simply making the application
look quieter.

### Design rules

1. **One dominant purpose per region.** Navigation, creation, execution, review,
   and verification should not compete for attention inside the same area.
2. **Content outranks chrome.** User work, agent state, code, diffs, terminals,
   and approvals should be more prominent than window and panel controls.
3. **Density follows the task.** Entry and empty states stay spacious; code,
   terminal, diff, diagnostics, and Git surfaces may be dense when density helps
   comparison or scanning.
4. **Operational color is scarce.** Accent colors communicate interaction,
   running, waiting, success, warning, failure, additions, and deletions. They
   are not decoration.
5. **Structure before cards.** Prefer stable regions, surface steps, alignment,
   and hairline dividers over stacks of floating containers.
6. **Context stays near action.** Project, branch/worktree, provider/model,
   permission policy, and attachments belong close to the composer or command
   that will use them.
7. **Progressive disclosure is honest.** Secondary controls may be collapsed,
   but active risks, required approvals, failures, and blocked states must never
   be hidden.
8. **Stable geometry reduces cognitive load.** State changes should appear
   inside established regions instead of repeatedly rearranging the shell.
9. **Empty states are real states.** Do not populate decorative data or expose
   inactive panels merely to make the product look complete.
10. **Accessibility is part of visual quality.** Contrast, focus, labels,
    keyboard paths, target sizes, zoom, and reduced motion are release criteria.

### Visual system foundations

Define and document a small, enforceable system for all three surfaces:

- A restrained graphite surface scale for window, sidebar, canvas, raised
  control, hover, active, and overlay states.
- Semantic colors for interaction, running, waiting, success, warning, failure,
  diff addition, and diff deletion with accessible text/background pairings.
- A limited typography set for display prompts, interface text, metadata, code,
  and numeric status.
- A four-pixel spacing base with named compact, standard, comfortable, and
  section gaps.
- A small radius family for inline controls, inputs, panels, and overlays.
- One hairline border system and a deliberately limited shadow system.
- Standard control heights, icon sizes, hit targets, and focus-ring behavior.
- Shared motion tokens for immediate feedback, panel transitions, overlays, and
  progress, including a reduced-motion path.
- Z-index and overlay ownership rules for menus, tooltips, dialogs, approvals,
  command palettes, and drag surfaces.

Tokens should live in the shared UI layer. Surface-specific CSS may compose
tokens but must not invent parallel color, radius, spacing, or motion systems.

### v0.2 — Hierarchy and consistency pass

Goal:

- Make the current application feel coherent and trustworthy before adding more
  visible capability.

Deliver:

- Inventory every visible Chat, CLI, IDE, settings, task, automation, provider,
  diff, terminal, and browser surface.
- Classify each element as primary content, secondary context, operational
  state, navigation, action, or decoration.
- Remove decorative containers and nested cards that do not express real
  hierarchy.
- Consolidate colors, radii, borders, shadows, spacing, typography, control
  height, and motion into shared tokens.
- Establish a stable desktop grid for titlebar, primary navigation, sidebar,
  central workspace, inspector/review region, and bottom panel.
- Define when each region is visible, collapsed, resizable, or absent.
- Make application chrome quieter than the active work surface.
- Reserve the strongest text contrast for primary content and required actions.
- Make disabled, unavailable, experimental, and permission-blocked controls
  visually and semantically distinct.
- Standardize loading, empty, running, waiting, approval-needed, failed,
  cancelled, and completed states.
- Keep panel resizing and surface switching stable without layout jumps.

Surface-specific priorities:

- **Chat:** emphasize the prompt, current run, approvals, and result; make
  project/provider/policy context compact but visible beside the composer.
- **CLI:** reduce decorative shell around terminals; prioritize process identity,
  working directory, status, output, and stop/restart actions.
- **IDE:** allow higher information density while keeping file ownership,
  dirty/stale state, Git state, problems, terminal, and diff hierarchy clear.

Validation:

- Screenshot baseline at `1280x720`, `1440x900`, `1728x1117`, and compact
  supported width for every primary route.
- Light-content and heavy-content cases, including long paths, long model names,
  large diffs, many tabs, terminal output, diagnostics, and provider errors.
- Keyboard, focus-visible, screen-reader label, contrast, zoom, and reduced-motion
  audit.
- Click-through proof that every visible control works or clearly explains its
  unavailable state.

Exit gate:

- Chat, CLI, and IDE share one recognizable design system, each has one obvious
  primary purpose, and operational state is more prominent than decoration.

### v0.2.2 — Entry, empty state, and activation design

Goal:

- Make the path from first launch to useful work feel simple without concealing
  setup or trust boundaries.

Deliver:

- A short first-launch sequence for local storage, provider readiness, project
  selection, and permission behavior.
- Project-first empty states for Chat and IDE, plus CLI-session continuation when
  available.
- A central starting action with surrounding execution context rendered as quiet
  metadata until interaction.
- Progressive loading that introduces workspace regions only when they have
  truthful content.
- Direct recovery states for missing projects, unavailable providers, expired
  authentication, offline operation, and failed environment checks.
- A consistent relationship between the public product experience, download
  flow, DMG presentation, application icon, first launch, and workbench.

Validation:

- Five-second comprehension test: users can identify the primary action and
  effective project/provider/permission context.
- Clean-user walkthrough from first launch through first accepted change.
- Empty, offline, partial-setup, cancelled-setup, and returning-user variants.

Exit gate:

- A new user always has one obvious next action and can understand why any action
  is unavailable without searching Settings or documentation.

### v0.3 — Scalable multi-work design

Goal:

- Preserve calm hierarchy as projects, worktrees, tasks, agents, terminals, and
  approvals multiply.

Deliver:

- Stable visual identity for repository, branch, worktree, provider, and run.
- Compact status aggregation that highlights only items requiring attention.
- Navigation patterns for many projects and sessions without turning the sidebar
  into an unstructured activity feed.
- Resizable review and verification regions with predictable collapse and
  restoration.
- Clear ownership markers across tabs, terminals, diffs, tasks, browser previews,
  and approvals.
- Attention management for simultaneous running, waiting, failed, and completed
  work without relying on constant color or animation.

Validation:

- Stress layouts with many projects, sessions, tabs, terminals, changed files,
  diagnostics, tasks, and pending approvals.
- Prove that project and worktree identity remains visible at every mutation and
  publication action.
- Verify that badges and notifications communicate priority without becoming
  permanent visual noise.

Exit gate:

- Adding parallel work increases information density without making ownership,
  risk, or next action ambiguous.

### v0.4 — Intelligent workbench design

Goal:

- Integrate language intelligence, debugging, skills, and plugins without
  fragmenting the shell or creating a collection of unrelated tool windows.

Deliver:

- Consistent presentation for symbols, references, hover, diagnostics, code
  actions, refactor previews, and debugger state.
- A shared evidence pattern linking Chat claims to files, ranges, tests, diffs,
  terminals, and browser results.
- Clear experimental, unavailable, disconnected, stale, and crashed states for
  language servers and debug adapters.
- Permission and provenance presentation for skills and plugins.
- Command-palette and contextual-action rules that prevent duplicate controls
  across toolbar, menus, editor, Chat, and panels.

Exit gate:

- New intelligence uses existing Gyro hierarchy and state patterns; it does not
  introduce a second visual language or bypass visible trust boundaries.

### Component roadmap

Build or consolidate components in this order:

1. Semantic text, icon, badge, and status primitives.
2. Buttons, icon buttons, segmented controls, fields, menus, and tooltips.
3. Shell regions, toolbars, sidebars, split panes, tabs, and panel headers.
4. Empty, loading, error, blocked, offline, and recovery states.
5. Composer context bar and provider/model/permission selectors.
6. Run timeline events, tool activity, command approvals, and edit approvals.
7. File tree, editor tabs, problems, output, terminal, browser, and diff review.
8. Toasts, banners, update notices, dialogs, and destructive confirmations.
9. Multi-project identity, attention aggregation, and notification patterns.
10. Language intelligence, debugger, skill, and plugin surfaces.

Each shared component requires documented variants, interaction states,
keyboard behavior, accessible naming, overflow behavior, compact-width behavior,
and at least one real surface integration before it is considered complete.

### Design QA and governance

- Maintain representative screenshot fixtures for every primary route and
  operational state.
- Extend `smoke:workbench` when shell geometry, navigation, composer context,
  panels, or state vocabulary changes.
- Review visual diffs at the supported viewport set before merging broad UI
  changes.
- Track temporary CSS exceptions and remove them before the milestone closes.
- Reject one-off hex colors, radii, shadows, animation timings, and spacing values
  when an existing semantic token fits.
- Test with real repository names, branches, model names, file paths, diffs,
  diagnostics, and terminal output rather than idealized short fixtures.
- Perform a final manual pass in the actual Tauri application; browser-only
  previews cannot prove titlebar, native menu, focus, drag, window, or PTY
  behavior.

### Design measures

- Time to identify the primary action on each surface.
- Time to identify effective project, provider, branch/worktree, permission, and
  run state.
- Percentage of visible controls that are functional or truthfully unavailable.
- Accessibility violations by severity.
- Layout failures at supported widths and zoom levels.
- Count of visual tokens versus one-off style values.
- User errors caused by targeting the wrong project, worktree, provider, or
  approval action.
- Recovery success from empty, blocked, failed, offline, and stale states.

## Milestone Overview

| Milestone | Outcome                                             | Depends on                                     |
| --------- | --------------------------------------------------- | ---------------------------------------------- |
| v0.1.0    | A trustworthy macOS developer preview               | Stable IDE upgrade and launch blockers closed  |
| v0.1.x    | Activation, design, and release hardening           | Real v0.1.0 user and release evidence          |
| v0.2      | A dependable private alpha for daily macOS use      | Proven trusted single-run behavior             |
| v0.2.1    | A more mature install and update channel            | v0.2 trust transaction and release foundation  |
| v0.2.2    | A measured download-to-first-run journey            | Signed artifacts and provider readiness        |
| v0.3      | Safe parallel work across projects and worktrees    | Proven single-run reliability                  |
| v0.4      | Deeper IDE intelligence and stable extension points | Stable workbench contracts                     |
| v0.5      | Additional platforms and optional collaboration     | macOS reliability and a complete privacy model |

Version labels describe product milestones. Patch sequencing may change during
implementation, but milestone exit gates must not be weakened to fit a version.

## v0.1.0 — Trustworthy macOS Developer Preview

### Launch definition

v0.1.0 is the first public proof that Gyro's core product loop works. It is not
full IDE parity, a multi-agent platform, or a promise that every visible future
surface is production-ready.

A v0.1.0 user must be able to:

1. Obtain the correct signed macOS build.
2. Install and open Gyro without security bypass instructions.
3. Select a local repository.
4. Connect Codex or Claude Code without editing configuration.
5. Start or resume a real streamed run.
6. Understand the effective project, branch/worktree, provider, model, and
   approval policy.
7. Review and accept or reject proposed mutations safely.
8. Run a real terminal command and inspect files, diffs, Git state, and task
   output.
9. Recover the durable session after an app, provider, terminal, or update
   interruption.
10. Continue the same session between the CLI and desktop app.

### Current launch assessment

The engineering foundation is stronger than the pre-alpha label suggests:

- Chat executes through Codex and Claude Code with streaming, retry, resume, and
  diagnostics.
- The CLI supports setup, doctor, run, resume, sessions, and app handoff.
- The terminal stack uses real PTYs and supports input, resize, stop, restart,
  restore, and visible output.
- The IDE supports workspace navigation, Monaco buffers, guarded writes, search,
  Git state, tasks, tests, output, diagnostics, and browser preview.
- TypeScript checks, workbench smoke coverage, the production frontend build,
  Rust formatting, and the Rust workspace tests currently pass.

The product is not launch-ready because:

- A large IDE and design upgrade is still active and must be stabilized as one
  coherent release candidate.
- Provider-proposed edits still need one complete atomic approval transaction.
- Provider onboarding lacks clean-machine acceptance proof.
- The committed updater public key is a development placeholder, so the release
  configuration check fails intentionally.
- Apple signing, notarization, updater deployment, release artifacts, Homebrew
  checksums, and clean-machine installation proof are incomplete.
- The first-run and download journey exists as a plan rather than a tested
  end-to-end funnel.

### Launch blocker 1: Stabilize the active IDE upgrade

Deliver:

- Complete the current IDE implementation without mixing partial generations of
  shell, workbench, or CSS behavior.
- Reconcile Chat, CLI, and IDE context, navigation, panels, state vocabulary,
  and shared components.
- Remove temporary overrides, obsolete paths, dead controls, and unused
  scaffolding introduced during the upgrade.
- Review the complete change set intentionally before it becomes the release
  baseline.
- Run the full TypeScript, workbench, Rust, build, and manual desktop checks on
  the settled candidate.

Exit gate:

- The IDE upgrade is committed as a reviewable baseline, all required checks
  pass, and no primary surface depends on an unfinished parallel implementation.

### Launch blocker 2: Atomic mutation approval

Deliver one shared transaction:

```text
proposal -> review -> approval or rejection -> guarded write -> durable event
-> disk and Git verification -> recovery
```

The transaction must cover:

- Workspace-bound paths and symlink escape attempts.
- Stale files and content-hash conflicts.
- Dirty repositories and overlapping changes.
- New, modified, deleted, renamed, binary, and oversized files.
- Partial preparation or write failure.
- App or provider interruption during review or application.
- Rejection without false on-disk or Git state.
- Restoration of pending review after restart.

Exit gate:

- Every supported provider-generated file mutation uses the same typed,
  approval-aware, event-logged, recoverable transaction unless the active policy
  explicitly authorizes the command path responsible for mutation.

### Launch blocker 3: Clean-machine provider activation

Deliver:

- Resumable setup checks for Git, the shell, Codex, Claude Code, authentication,
  adapter health, supported models, and app/CLI compatibility.
- Project selection before executable Chat submission.
- Honest states for ready, not installed, not authenticated, unsupported,
  experimental, unhealthy, and offline providers.
- Direct setup or diagnostic actions for each recoverable state.
- A ready composer with visible project, provider/model, branch/worktree, and
  approval context after successful setup.
- Explicitly non-executable presentation for xAI, Gemini, and any other adapter
  without a supported execution contract.

Validation:

- Clean macOS account with Codex only.
- Clean macOS account with Claude Code only.
- Missing binary, expired authentication, invalid model, offline, provider crash,
  and stale resume cursor.

Exit gate:

- A new user reaches a real first provider response without editing a config
  file or guessing why an action is disabled.

### Launch blocker 4: Focused v0.1 design pass

Run this pass after the active IDE upgrade is settled.

Deliver:

- One dominant purpose and primary action for Chat, CLI, and IDE.
- Shared surface, typography, spacing, radius, border, shadow, icon, control,
  focus, and motion tokens.
- Fewer nested cards and clearer architectural regions.
- Application chrome quieter than prompts, code, diffs, terminals, approvals,
  and required recovery actions.
- Compact execution context beside the initiating action.
- Stable pane geometry and predictable collapse/restore behavior.
- Operational color reserved for interaction and meaningful state.
- Honest empty, unavailable, experimental, blocked, failed, and recovered states.
- Keyboard, focus, contrast, zoom, compact-width, screen-reader, and
  reduced-motion acceptance.

Exit gate:

- The three surfaces feel like one Gyro product, every primary action is obvious,
  and no design treatment makes incomplete functionality appear ready.

### Launch blocker 5: Production distribution

Deliver:

- Generate the production Tauri updater keypair.
- Commit the public updater key and store the private key in protected CI
  secrets.
- Configure Apple signing and notarization credentials.
- Publish signed and notarized Apple Silicon and Intel DMGs.
- Publish matching architecture-specific CLI archives.
- Generate SHA256 checksums, signatures, updater artifacts, and release notes.
- Reconcile artifact filenames and repository URLs across the release workflow,
  documentation, updater, Homebrew Cask, and Homebrew Formula.
- Replace every Homebrew checksum placeholder with immutable release values.
- Publish an update manifest endpoint with stable channel semantics.
- Verify version agreement across Cargo, package metadata, Tauri, application
  UI, filenames, release tag, notes, Homebrew, and updater metadata.

Exit gate:

- `pnpm release:check` passes and a clean supported Mac installs, launches,
  verifies, and updates Gyro without terminal workarounds.

### Launch blocker 6: Minimum download and installation journey

Deliver:

- A clear Gyro download page with local operating-system and architecture
  recommendation plus manual override.
- Apple Silicon and Intel choices with version, channel, file type, approximate
  size, minimum macOS version, and checksum access.
- Direct artifact downloads without an account gate or unnecessary
  interstitial.
- A standard DMG containing Gyro.app, an Applications alias, and a clear drag
  direction.
- Links to release notes, installation help, signatures, checksums, Homebrew,
  previous releases, privacy, and source code.
- Omission of inactive Windows and Linux download controls until supported
  artifacts exist.

Exit gate:

- A first-time user can identify, download, verify, install, and launch the
  correct build without navigating a source-hosting release interface.

### Launch blocker 7: Release-candidate acceptance

The final v0.1.0 candidate must pass:

1. Clean DMG installation and Gatekeeper assessment on Apple Silicon.
2. Intel artifact installation or equivalent verified Intel test coverage.
3. First launch without manual configuration editing.
4. A real Codex setup and streamed response.
5. A real Claude Code setup and streamed response.
6. Terminal execution, input, resize, stop, restart, restore, and output refresh.
7. CLI-created session opened in the desktop app.
8. Desktop-created session resumed from the CLI.
9. Guarded editor save plus stale-buffer recovery.
10. Provider-proposed edit approval, application, rejection, and restart
    recovery.
11. Git status, diff, stage, and unstage in a dirty repository.
12. Real task or test execution with cancellable output.
13. Live local browser preview and failure recovery.
14. App restart with durable sessions and truthful terminal/process state.
15. Signed update from an older release candidate with deferred restart.
16. Offline, missing-provider, provider-crash, stale-file, corrupt-update, and
    invalid-signature recovery.

Automated evidence must include:

- `git diff --check`
- `pnpm doctor`
- `pnpm release:check`
- `pnpm check`
- `pnpm test`
- `pnpm lint`
- `pnpm smoke:workbench`
- `pnpm --filter @gyro-dev/desktop build`
- `cargo fmt --all -- --check`
- `cargo test --workspace`
- A production Tauri bundle build

### Explicit v0.1.0 deferrals

The following do not block v0.1.0 when they are omitted or accurately labelled:

- Durable always-on automation scheduling.
- Production LSP lifecycle beyond clearly experimental support.
- Debug adapter lifecycle beyond clearly experimental support.
- xAI and Gemini execution.
- Parallel multi-project or multi-agent orchestration.
- Cross-provider handoff.
- Windows and Linux releases.
- Hosted synchronization or accounts.
- A stable plugin ecosystem.
- Full IDE parity with mature editors.
- Automatic installation or upgrading of third-party provider CLIs.

Incomplete functionality must never appear production-ready merely because it is
visible.

### v0.1.0 launch gate

v0.1.0 may be tagged only when:

1. The active IDE upgrade is stable and fully reviewed.
2. Supported mutations use the atomic approval transaction.
3. Codex and Claude pass clean-machine activation.
4. Chat, CLI, and IDE share truthful session and approval state.
5. The focused design and accessibility pass is complete.
6. Production signing, notarization, checksums, updater, Homebrew, and download
   paths are working.
7. The complete automated validation set passes.
8. The real release-candidate acceptance walkthrough passes.
9. Known limitations and experimental features are documented and visible.
10. The release commit is clean, reproducible, and matches the published tag and
    artifacts.

## v0.1.x — Activation and Release Hardening

Use patch releases after v0.1.0 for evidence-driven improvements that preserve
the release contract:

- Fix install, setup, provider, resume, update, or recovery failures found by
  early users.
- Refine first-run and empty states using observed confusion rather than added
  decoration.
- Improve performance for startup, workspace loading, long sessions, large
  diffs, terminals, and model selection.
- Reduce accessibility and compact-layout defects.
- Improve diagnostics and redacted support bundles.
- Strengthen automated clean-install, update, and app/CLI continuity coverage.
- Consolidate remaining CSS exceptions and visual-token drift.

Patch releases must not quietly introduce a new provider, platform, storage
model, permission contract, or orchestration model without the corresponding
milestone design and acceptance work.

## v0.2 — Trusted Private Alpha

### Product outcome

A developer can open a local repository, connect a supported provider, complete
one streamed coding run, review every proposed mutation, recover from failure,
and continue the same session from the app or CLI.

### Workstream 1: Atomic edit approval

Deliver:

- One typed proposal contract for provider-generated file changes.
- Workspace-bound path validation and stale-content hash checks.
- A review state that shows affected files, additions, deletions, and conflicts.
- Explicit apply and reject actions with durable event-log entries.
- Atomic writes where possible and safe failure when only part of a transaction
  can be prepared.
- Recovery behavior for app exit, provider exit, stale files, Git changes, and
  interrupted application.
- Diff state derived from disk and Git after application, never from assumed
  success.

Validation:

- Unit tests for path escape, stale hash, overlapping edits, binary files,
  deleted files, and partial failure.
- Integration test from provider proposal through review, apply, event log, and
  restored session.
- Manual rejection and recovery pass in a dirty repository.

Exit gate:

- No supported provider can mutate a project file outside the same typed
  approval transaction unless the active permission policy explicitly allows
  the command path responsible for that mutation.

### Workstream 2: Provider setup and run truth

Deliver:

- Resumable setup checks for supported provider CLIs, executable versions,
  authentication, and adapter health.
- A two-level provider and model selection model backed by real adapter
  capabilities.
- Clear states for ready, not installed, not authenticated, unsupported,
  experimental, and unhealthy providers.
- Project-level defaults with an always-visible effective provider and model.
- Resume-compatibility warnings before provider switching.
- A safe fallback when model catalogue data is stale or unavailable.

Validation:

- Clean-machine setup tests for Codex and Claude Code.
- Missing binary, expired authentication, invalid model, offline, and provider
  crash scenarios.
- Assertions that unavailable adapters cannot be selected as executable.

Exit gate:

- Every provider and model state shown in the workbench matches what Gyro can
  actually execute at that moment.

### Workstream 3: Terminal and session recovery

Deliver:

- Persisted run state for idle, running, waiting, approval-needed, stopped,
  failed, and completed sessions.
- Reliable PTY restoration without inventing live processes after restart.
- Clear recovery actions for dead shells, missing working directories, provider
  failures, and invalid resume cursors.
- Consistent project, branch, worktree, provider, and permission context across
  CLI-to-app handoff.

Validation:

- PTY create, input, resize, stop, kill, restart, restore, and output-refresh
  coverage.
- Restart during streaming, approval, command execution, and terminal activity.
- CLI-created session opened in the app and app-created session continued from
  the CLI.

Exit gate:

- An interruption never silently loses the durable session record or presents a
  dead process as running.

### Workstream 4: Honest workbench

Deliver:

- Project-first empty state with recent-session and CLI-attach paths.
- Explicit project, branch/worktree, provider/model, and approval context around
  the composer.
- Functional or truthfully unavailable states for every visible control.
- Live browser console/error collection and isolated preview capture.
- Experimental labelling for LSP and DAP until process lifecycle and recovery
  are complete.
- Consistent visual state vocabulary across Chat, CLI, IDE, tasks, automations,
  diffs, and updates.

Validation:

- Route and interaction smoke tests at desktop and compact widths.
- Keyboard, focus, reduced-motion, and screen-reader checks for primary flows.
- Manual audit for empty, loading, offline, unavailable, failed, and recovered
  states.

Exit gate:

- Every primary surface lets a user understand what Gyro is doing, what it is
  waiting for, what it changed, and what action is available next.

### Workstream 5: Durable automations

Deliver:

- A scheduler independent of the currently visible UI.
- Durable leases preventing duplicate execution.
- Missed-run, retry, backoff, timeout, pause, resume, and stop semantics.
- Workspace and worktree isolation for scheduled mutations.
- Visible run history and concrete recovery actions.
- Local notification behavior that respects privacy and quiet hours.

Validation:

- Restart, sleep/wake, clock change, duplicate worker, offline, and long-running
  task scenarios.
- Proof that a stopped or paused automation cannot silently relaunch.

Exit gate:

- Scheduled work runs at most once per lease, survives restart, and never hides
  its project, provider, permission, or result state.

### v0.2 milestone gate

v0.2 is complete only when:

1. A clean user can connect Codex or Claude Code without editing configuration.
2. The user can open a repository and complete one streamed coding run.
3. Commands and proposed file edits follow the active approval policy.
4. Guarded reads and writes cannot escape the workspace or silently overwrite a
   stale file.
5. Terminal and session recovery pass automated and manual interruption tests.
6. Automations run durably or remain clearly labelled as unavailable for alpha.
7. No primary control is a placeholder.
8. All failures preserve state and provide a concrete next action.

## v0.2.1 — Native Distribution and Safe Updates

### Product outcome

A tester can download the correct macOS build, verify it, install it using a
standard DMG, open it without security warnings, and update later without losing
an active or resumable session.

### Workstream 1: Release identity

Deliver:

- One version source propagated to Cargo, package metadata, Tauri, updater
  manifests, release notes, filenames, and the application UI.
- One Stable update stream backed by published non-prerelease GitHub Releases.
- Immutable release metadata containing version, architecture, size, checksum,
  signature, minimum macOS version, and artifact URL.

Exit gate:

- Tag, app bundle, DMG, updater manifest, and release notes all report the same
  version and GitHub release source.

### Workstream 2: Signed macOS artifacts

Deliver:

- Production Tauri updater key and protected release secrets.
- Signed and notarized Apple Silicon and Intel application builds.
- Architecture-labelled DMGs, CLI tarballs, SHA256 checksums, updater artifacts,
  and release notes.
- A standard DMG window containing Gyro.app, an Applications alias, and a clear
  drag direction.
- Homebrew Cask and CLI Formula sourced from the same immutable release.

Validation:

- `codesign`, Gatekeeper assessment, notarization, checksum, bundle metadata,
  mount, drag, eject, first launch, CLI doctor, and app/CLI continuity checks.
- Clean macOS user tests for both architectures or equivalent verified Intel
  hardware/virtualization coverage.

Exit gate:

- A clean user installs and launches Gyro without terminal commands or security
  bypass instructions.

### Workstream 3: Update safety

Deliver:

- Signed updater checks with conservative backoff and channel awareness.
- A compact update notice with versions, release notes, download, dismissal,
  progress, and deferred restart.
- Blocking of restart while an agent, terminal, approval, or file transaction is
  active.
- Session persistence before restart and clear manual fallback after failure.
- Separate informational notices for provider CLI updates; Gyro must not update
  third-party CLIs automatically.

Validation:

- Invalid signature, corrupt artifact, offline server, interrupted download,
  dismissed version, active run, restart, and rollback-guidance scenarios.

Exit gate:

- An installed older build updates successfully without losing project or
  session state, and unsigned metadata is always rejected.

## v0.2.2 — Product Entry and First-Run Activation

### Product outcome

A developer can understand Gyro, obtain the right build, finish setup, open a
project, and complete a trusted first change without release-page archaeology or
manual configuration.

### Workstream 1: Public entry

Deliver:

- A Gyro-owned public page explaining local-first execution, existing provider
  subscriptions, approval before mutation, and CLI/app continuity.
- Primary download and GitHub actions.
- A truthful demonstration of one complete project/run/review loop.
- Direct access to privacy, release notes, checksums, installation help, and
  source code.

Validation:

- Responsive, accessibility, keyboard, reduced-motion, broken-link, and product
  accuracy checks.
- No unsupported platform or quantitative claim appears as fact.

Exit gate:

- A first-time visitor can identify Gyro's purpose, trust boundary, supported
  platform, and primary action in one screen.

### Workstream 2: Download selection

Deliver:

- Local operating-system and architecture detection with a manual override.
- Apple Silicon and Intel options with version, channel, file type, approximate
  size, and minimum supported macOS version.
- Direct artifact downloads without account gates or unnecessary interstitials.
- Links for checksums, signatures, previous releases, and Homebrew.
- Truthful treatment of future Windows and Linux availability without inactive
  download controls.

Validation:

- Correct recommendation, uncertain detection, manual override, interrupted
  download, retry, and manifest failure cases.

Exit gate:

- A user reaches the correct verified artifact without navigating through a
  source-hosting release interface.

### Workstream 3: First launch

Deliver:

- A short, resumable explanation of local storage and mutation approvals.
- Environment checks for Git, shell, supported provider CLIs, authentication,
  and application update readiness.
- Primary **Open a project** path plus **Continue a CLI session** when one exists.
- Plain-language approval choices that describe actual behavior.
- Offline local project inspection and resumable setup.

Validation:

- Clean account, offline, missing Git, missing CLI, expired authentication,
  cancelled setup, restart, and existing CLI-session scenarios.

Exit gate:

- A clean user opens a repository and completes one accepted change without
  editing a configuration file.

### Funnel measures

Measure only with an explicit privacy decision and documented collection:

- Download-to-first-launch completion.
- First-launch-to-project-open completion.
- Project-open-to-first-run completion.
- Time to first accepted change.
- Provider setup success and diagnostic recovery.
- Install and update failure categories without collecting project content.

## v0.3 — Parallel Workbench

### Product outcome

A developer can run multiple isolated tasks across projects or worktrees while
always understanding ownership, branch state, provider state, and cleanup risk.

### Deliverables

- Multi-project navigation with distinct repository, branch, provider, and run
  state.
- Worktree-native tasks with safe branch naming, collision prevention, visible
  isolation, and cleanup guidance.
- Resource controls for concurrent providers, terminals, automations, and local
  services.
- Git review through branch creation, commit preparation, push, and pull-request
  preparation with explicit user approval.
- Provider handoffs using typed context and honest resume compatibility.
- Reliable recurring checks and follow-up runs with visible triage.
- Browser verification that can become part of task completion criteria.

### Validation

- Concurrent edits to shared files, branch deletion, dirty base repository,
  provider failure, process exhaustion, and abandoned worktree scenarios.
- Recovery after restart with multiple running, waiting, failed, and completed
  tasks.
- Proof that one task cannot silently mutate another task's worktree.

### Exit gate

- Parallel work is isolated, resource-bounded, recoverable, and no less
  inspectable than a single v0.2 run.

## v0.4 — IDE Intelligence and Extension Points

### Product outcome

Gyro deepens code understanding and repeatable workflows without turning the
trusted agent engine into a collection of disconnected features.

### Deliverables

- Production lifecycle for the first supported language server: start, reuse,
  cancellation, crash recovery, workspace changes, and diagnostics.
- Navigation, references, rename/refactor review, and agent-aware code actions.
- Debug adapter lifecycle only after language-server lifecycle is dependable.
- Stable skills interface for repeatable local workflows.
- Stable plugin contracts with explicit permissions and versioning.
- VS Code extension prototype backed by `gyro-core` session and approval
  contracts rather than a parallel implementation.
- Workspace policies for repository-specific commands, context, approvals, and
  validation requirements.

### Exit gate

- IDE and extension features use the same storage, provider, approval, event,
  and recovery contracts as the desktop workbench and CLI.

## v0.5 — Platforms and Optional Collaboration

### Product outcome

Gyro expands beyond its macOS-first local workflow only where the trust and
reliability model can be preserved.

### Candidate deliverables

- Windows desktop and CLI support.
- Linux desktop and CLI support.
- Platform-specific shell, PTY, credential, signing, packaging, and updater
  behavior.
- Optional encrypted team sync with clear ownership and conflict semantics.
- Enterprise policy and support options that preserve the open local core.

### Entry gate

- macOS install, activation, crash-free use, update, and recovery measures are
  stable across multiple releases.
- Cross-platform abstractions have testable contracts rather than macOS behavior
  hidden behind platform conditionals.
- Any hosted feature has an explicit privacy, security, retention, export, and
  deletion model before implementation.

## Cross-Cutting Quality Gates

Every milestone must include proportionate checks from this matrix:

| Area          | Required evidence                                                  |
| ------------- | ------------------------------------------------------------------ |
| TypeScript    | typecheck, unit/integration tests, lint, workbench smoke coverage  |
| Rust          | formatting, workspace tests, focused command/core tests            |
| File safety   | path boundaries, stale hashes, atomicity, dirty-repo recovery      |
| Terminals     | execution, input, resize, stop/kill, restore, visible output       |
| Providers     | readiness, authentication, execution, resume, failure recovery     |
| Accessibility | keyboard, focus, labels, contrast, reduced motion                  |
| Distribution  | signature, notarization, checksum, architecture, clean install     |
| Updates       | signed metadata, deferral, restart safety, failure fallback        |
| Privacy       | data inventory, default behavior, opt-in boundaries, documentation |
| Documentation | current setup, release, recovery, rollback, and limitations        |

No milestone is complete because its UI exists. Completion requires working
behavior, recovery behavior, automated coverage where practical, and a manual
acceptance pass through the real desktop/CLI path.

## Explicit Deferrals

Until their entry gates are met, Gyro will not prioritize:

- Full IDE parity with mature editors.
- Multi-agent orchestration that weakens per-run visibility.
- Windows or Linux download controls before supported artifacts exist.
- Automatic installation or upgrading of third-party provider CLIs.
- Account gating for direct open-source downloads.
- Hosted sync before local reliability and a complete privacy model.
- Vanity download counts unsupported by real, privacy-respecting data.
- Provider or model names that the active adapters cannot execute.

## Roadmap Success Measures

The roadmap is succeeding when:

- Users complete a first trusted change quickly and understand what happened.
- Provider setup failures have actionable recovery and declining recurrence.
- Interrupted runs, app restarts, and updates do not lose durable session state.
- File safety violations and silent stale overwrites remain at zero.
- Signed installs and updates succeed consistently on supported macOS systems.
- Every visible action is functional, truthfully unavailable, or intentionally
  omitted.
- Parallel and IDE capabilities add leverage without weakening the local-first
  approval and recovery model.
