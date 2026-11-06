# Alpha 48 preflight — 13 September 2026

Local automated preflight passed for the release candidate. Artifact acceptance
must be recorded separately against the tagged builds.

## Changes reviewed

Chat completion and saved/live event reconciliation, browser actions and host
visibility, Full Access guarded file writes, file review, attachment routing,
chat tiling, composer resizing, and daily usage pace calculations.

Updated all version surfaces to 0.1.0-alpha.48 and added matching release notes.
Workbench assertions now follow the 48px headers and completed-work collapse
behavior. The failure baseline and architecture ceilings were not raised.

## Verified

- Frozen dependency installation and development environment doctor.
- TypeScript checks, full reliability suite, and package tests.
- Rust formatting and workspace tests: 619 passed, 4 ignored, 0 failed.
- CLI build, Apple Silicon packaging smoke, and doctor JSON schema.
- Release configuration, workbench/UI tokens, and download-site checks.
- Production frontend build; existing Vite large-chunk advisory remains.
- Native browser smoke against a loopback fixture in an isolated data directory:
  open/read, stable refs, click, type/submit, form controls, scroll, screenshot,
  credential/stale-ref rejection, console/network, navigation/history/reload,
  and close all passed.

The chat-owned browser preview could not be inspected in this session. Native
smoke results above come from the candidate desktop executable and its emitted
test report; they do not establish clean-user Gatekeeper or updater acceptance.

## Publication acceptance

Follow docs/release.md: passing PR CI, merge into main, tag the exact merge,
build both architectures, verify downloaded draft assets, and complete clean-user
installation and signed updater/session-preservation acceptance before publication.
