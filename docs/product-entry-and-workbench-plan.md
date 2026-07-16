# Product Entry and Workbench Plan

## Purpose

This plan defines how Gyro should move a developer from first discovery to a
trusted local coding run. It is informed by a review of a polished developer
tool journey, but it is not a replication brief. Gyro must retain its own
positioning, information architecture, interaction model, visual language, and
local-first approval semantics.

The exception is the download and macOS installation phase. That phase should
follow the established direct-download convention closely because platform
detection, architecture selection, a DMG, and drag-to-Applications installation
are user expectations rather than product differentiation.

## Desired Journey

1. Understand Gyro in one screen.
2. Download the correct signed build without release-page archaeology.
3. Install it using a familiar native macOS flow.
4. Open Gyro into an honest, useful first-run state.
5. Select an available provider and model with clear readiness information.
6. Choose a project, understand the trust boundary, and begin a run.
7. See approvals, commands, edits, terminals, and recovery actions as work
   progresses.
8. Receive safe, actionable update notices without interruption or ambiguity.

## Product Principles

- **Gyro first:** preserve the local-first agent workbench identity. Do not
  reproduce another product's page composition, navigation, copy, iconography,
  spacing system, or model-picker structure.
- **Trust before speed:** the fast path may be short, but workspace, provider,
  permissions, branch, worktree, and mutation state must remain visible.
- **Honest availability:** never present an unavailable provider or experimental
  feature as usable. Explain what is missing and offer a direct setup action.
- **Progressive depth:** first use should be calm; operational detail should
  appear when a run starts or when the user asks for it.
- **Native distribution:** signing, notarization, architecture, checksums, and
  updates are part of the product experience, not release-engineering trivia.
- **No fake activity:** download counts, provider status, update state, project
  history, and agent progress must come from real data or be omitted.

## 1. Public Entry Surface

### Goal

Let a developer understand Gyro's promise, trust model, and primary action in
under 20 seconds.

### Gyro-specific structure

- A compact header with product identity, documentation, changelog, GitHub, and
  a persistent download action.
- A concise statement centered on trusted local coding runs, followed by one
  sentence explaining local projects, existing provider subscriptions, and
  approval before mutation.
- Two primary actions: **Download Gyro** and **View on GitHub**.
- A real product demonstration showing one complete loop: open a repository,
  start a run, inspect a command or edit, approve it, and review the result.
- A short trust strip for local storage, BYOK/provider CLI reuse, visible
  approvals, and open-source verification.
- Links to privacy, release notes, checksums, and installation help near the
  download decision—not buried in the footer.

### Originality guardrails

- Do not reuse the reference headline, supporting sentence, provider-logo row,
  hero proportions, screenshot framing, navigation order, or social-proof copy.
- Lead with Gyro's differentiator: controlled local execution and continuity
  between the desktop app and CLI.
- Demonstrate agent state and approval mechanics rather than presenting a static
  dark workbench as the main proof.

### Acceptance criteria

- The primary download action is visible without scrolling at common laptop
  widths.
- The page names macOS support accurately and does not imply Windows or Linux
  availability before those builds are supported.
- Every quantitative claim is backed by a real source.
- The product demonstration matches the current application.

## 2. Download and Installation

### Goal

Make the path from download click to a verified application in Applications as
familiar and low-friction as possible.

### Download page

This phase may intentionally follow the conventional pattern demonstrated in
the reference journey:

- Detect the visitor's operating system and architecture locally.
- Highlight the recommended build while keeping architecture choices explicit.
- For macOS, offer Apple Silicon and Intel builds with plain-language labels.
- Show the file type, supported OS range, version, approximate size, and release
  channel before download.
- Provide one clear download button for the selected build.
- Link to release notes, previous releases, SHA256 checksums, signature details,
  and Homebrew installation.
- Do not offer inactive Windows or Linux download buttons. Show a truthful
  roadmap or notification option only when it exists.

### macOS package

- Produce separate signed and notarized DMGs for Apple Silicon and Intel unless
  a universal binary is proven small and reliable enough.
- Use a standard DMG window containing Gyro.app, an Applications alias, and a
  clear drag direction.
- Give the mounted volume and downloaded file predictable names that include
  product, version, and architecture.
- Verify the app icon, volume icon, window background, spacing, and Applications
  alias on clean light and dark macOS environments.
- Eject cleanly after installation and ensure the installed application launches
  without quarantine or unidentified-developer warnings.

### Download behavior

- Begin the selected artifact download directly; do not add an interstitial or
  account gate.
- Preserve normal browser download progress and filename behavior.
- If detection is uncertain, default to a neutral architecture selection rather
  than silently choosing the wrong artifact.
- Record only privacy-respecting aggregate download events if telemetry is
  introduced, and document them.

### Release engineering required

- Replace the development updater key with the production public key.
- Configure Apple signing and notarization secrets.
- Extend the release workflow to emit both macOS architectures, checksums,
  updater artifacts, and release notes.
- Publish the Homebrew Cask from the same immutable release artifacts.
- Add a release manifest suitable for the website's version and artifact data.
- Test download, mount, drag, first launch, update, rollback guidance, and
  checksum verification on clean machines.

### Acceptance criteria

- A clean macOS user can identify the correct build, install it, and open it
  without terminal commands.
- The website version, DMG version, app version, updater manifest, and release
  tag agree.
- Gatekeeper assessment, code signature verification, notarization, and SHA256
  verification all pass.
- A failed or interrupted download can be retried without losing the selected
  architecture.

## 3. First Launch

### Goal

Reach a useful project-backed run quickly without hiding setup or permissions.

### Flow

1. Welcome with a one-sentence explanation of local storage and approval before
   mutation.
2. Run environment checks for Git, shell, supported provider CLIs, credentials,
   and updater readiness.
3. Offer **Open a project** as the primary action and **Continue a CLI session**
   when an attachable session exists.
4. Show provider setup only for detected or supported execution adapters.
5. Let the user choose a default approval policy using concrete behavior, not
   abstract permission labels.
6. Enter the workbench with the selected repository, branch, provider, model,
   and trust mode visible.

### Rules

- Never drop a new user into a vast empty canvas with unexplained controls.
- Never claim a provider is ready based only on a logo or installed binary;
  validate the executable and its authentication/readiness contract.
- Avoid a long onboarding carousel. Checks and setup should be resumable and
  available later from Settings.

### Acceptance criteria

- A clean user can complete setup without editing a configuration file.
- Missing provider credentials produce a specific fix action.
- Closing onboarding never destroys completed setup.
- First launch remains usable offline for local project inspection.

## 4. Gyro Workbench Home

### Goal

Make the empty and idle states immediately actionable while keeping Gyro's
operational identity distinct.

### Information architecture

- Keep Gyro's stable Sessions and Workspace surfaces rather than adopting a generic
  studio/projects split.
- Use the left region for projects, sessions, search, tasks, and automations;
  keep active repository and branch context visible.
- Use the central region for the selected work surface: conversation, terminal,
  editor, diff, or browser verification.
- Keep run state, approvals, and current workspace more prominent than model
  branding.
- Preserve the bottom terminal/diff/browser system where it supports the active
  task instead of reproducing another workbench layout.

### Empty state

- Primary action: **Open a project**.
- Secondary actions: continue a recent session, attach a CLI session, or clone a
  repository when that workflow is implemented safely.
- Explain in one line that Gyro works in a local project and asks before
  mutating files or running commands according to the selected policy.
- Hide panels that have no truthful state; do not populate decorative examples.

### Composer

- Keep task input central but make context explicit around it: project, branch
  or worktree, provider/model, approval mode, and attachments.
- Translate permission modes into outcomes such as **Review every change**,
  **Allow safe project actions**, and **Unrestricted for this run**, with clear
  warnings for broad access.
- Provide project selection as a first-class action before submission.
- Disable submission with a concrete explanation when no executable provider or
  project is available.

## 5. Provider and Model Selection

### Goal

Support multiple provider CLIs without turning the picker into a catalogue of
logos or implying unsupported execution.

### Interaction model

- Use a two-level selection: provider first, then compatible model.
- Put configured and executable providers first.
- Group unavailable providers separately with the reason: not installed, not
  authenticated, unsupported adapter, or temporarily unhealthy.
- Selecting an unavailable provider opens setup or diagnostics; it does not
  silently change the active provider.
- Persist defaults per project when appropriate, while showing the effective
  selection on every run.
- Show model metadata only when useful: capability, context limits, cost source,
  local/remote behavior, and known tool support.

### Gyro-specific improvements

- Include provider health from real readiness checks.
- Show whether a session can resume on the selected adapter.
- Warn before switching when the new provider cannot preserve provider-native
  resume state.
- Keep experimental adapters visibly labelled and excluded from the default
  path.
- Derive the model list from adapter capabilities or a versioned catalogue; do
  not hard-code aspirational model names into the UI.

### Acceptance criteria

- The active provider and model cannot disagree with the execution adapter.
- Unavailable options are never selectable as though functional.
- Keyboard and screen-reader navigation work across both levels.
- A stale model catalogue fails safely and leaves a known-good selection.

## 6. Update Experience

### Goal

Keep the app current without surprising the user or interrupting an active run.

### Behavior

- Check signed updater metadata after launch and periodically with conservative
  backoff.
- Show a compact, dismissible notice containing the available version, current
  version, release channel, and a short reason to update.
- Offer **Review release notes** and **Download update**. Do not use **Update
  all** unless Gyro genuinely manages multiple independently updateable
  components.
- Never install or restart while an agent, terminal, edit approval, or file write
  is active.
- Verify the updater signature before exposing installation as ready.
- Preserve session state and provide a clear restart action when the download
  completes.
- Surface failure with retry, diagnostics, and manual-download fallback.

### CLI/provider updates

- Provider CLI update notices must be separate from the Gyro app update.
- Detect versions with supported CLI commands and label the source of the
  recommendation.
- Do not update third-party CLIs automatically. Link to or display the provider's
  supported update command after user review.

### Acceptance criteria

- Invalid or unsigned updater metadata is rejected.
- Dismissal behavior is predictable and scoped to the offered version.
- An update never discards an active or resumable session.
- Offline and update-server failure states do not block normal local use.

## 7. Delivery Sequence

### Phase A — Distribution foundation

- Production updater key, Apple signing, and notarization.
- Multi-architecture release artifacts and checksums.
- Standard DMG presentation and clean-machine installation testing.
- Release manifest and direct download endpoint.

**Exit:** a tagged release installs and passes Gatekeeper on clean Apple Silicon
and Intel test environments.

### Phase B — Download surface

- Gyro-owned public entry page and download page.
- Client-side OS/architecture recommendation with manual override.
- Release notes, checksum, previous-release, privacy, and Homebrew paths.
- Real download-event instrumentation only if a documented privacy decision is
  made.

**Exit:** a user can move from the landing page to the correct verified artifact
without visiting the GitHub release interface.

### Phase C — First-run activation

- Resumable environment checks and supported provider setup.
- Project-first onboarding and CLI-session attach.
- Plain-language approval-policy selection.
- Honest empty and recovery states.

**Exit:** a clean user opens a repository and completes one accepted change.

### Phase D — Provider clarity

- Readiness-backed provider/model hierarchy.
- Per-project defaults, resume compatibility, and diagnostic actions.
- Capability-driven model catalogue with safe fallback.

**Exit:** every visible provider/model state matches what Gyro can execute.

### Phase E — Safe updates

- Signed in-app update detection, download, deferred restart, and recovery.
- Separate informational checks for supported third-party provider CLIs.
- Update acceptance tests during active, idle, offline, and failure states.

**Exit:** an installed older version updates without losing project or session
state.

## 8. Validation Matrix

| Area      | Automated                                           | Manual                                            |
| --------- | --------------------------------------------------- | ------------------------------------------------- |
| Website   | responsive, accessibility, link and manifest checks | macOS browsers, reduced motion, keyboard path     |
| Downloads | artifact URL, hash, version, architecture checks    | interrupted download and retry                    |
| DMG       | signature, notarization, bundle metadata            | mount, drag, eject, first launch                  |
| First run | state-machine and readiness tests                   | clean account, offline, missing CLI, expired auth |
| Providers | adapter capability and stale-catalogue tests        | switch, setup, resume incompatibility             |
| Workbench | existing typecheck, test, lint, and smoke gates     | project/run/approval/recovery walkthrough         |
| Updates   | signature, channel, deferral, rollback-path tests   | active run, downloaded update, restart, failure   |

## 9. Explicit Non-Goals

- Recreating the reference product's brand, shell, landing-page layout, copy,
  navigation, provider menu, or visual styling.
- Expanding Gyro into a full IDE before its trusted agent loop and distribution
  path are dependable.
- Showing unsupported operating systems or providers merely to make the product
  appear broader.
- Automatic installation or upgrading of third-party provider CLIs.
- Account gating for a direct open-source download.
- Optimizing vanity download counts ahead of successful installs and completed
  trusted runs.

## Success Measures

- Download-to-first-launch completion rate.
- First-launch-to-project-open completion rate.
- Time to first accepted change.
- Provider setup success and diagnostic recovery rate.
- Successful signed update rate without lost sessions.
- Crash-free runs and recoverable interrupted runs.
- Percentage of visible actions that are functional, truthfully unavailable, or
  intentionally omitted.
