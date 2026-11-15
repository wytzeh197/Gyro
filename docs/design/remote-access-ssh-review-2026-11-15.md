# Remote access SSH implementation review

Selected design: the second displayed ImageGen result, method switch within Remote access settings. Reference: `/Users/wytze/.codex/generated_images/01a1da8d-4293-7833-acde-29410916950d/exec-8d51209d-4364-4e54-ba4d-6e972d897dad.png`.

## Result

Production source implements the selected hierarchy: This Mac card, Gyro pairing / SSH switch, flat saved-host list, config host choice/manual entry, Advanced settings, and one primary Connect action. Existing Gyro navigation, typography, semantic surface tokens, and settings sizing are preserved rather than importing the prototype's custom dimensions. Pairing remains the initial method; existing pairing functionality stays inside its panel.

Evidence: `artifacts/ssh-remote-access-2026-11-15/ssh-settings-dark.png`, `ssh-settings-compact.png`, and the browser suite's result artifacts. Native Brave CUA also inspected these production components and verified SSH folders while hosting was off. These are fixture UI captures, not installed-native transport acceptance. Real transport evidence comes separately from the isolated OpenSSH integration test.

## Review-screen checklist

- **Pass — Tokens/components.** Uses SettingsSection, SettingsSegmented/SelectionTrack, SettingsSelect, SettingsStatus, SettingsEmptyState, the existing switch/buttons, local Geist, and the existing Lucide library. SSH styles use Gyro semantic tokens; the selected method rail is scoped against minimal-settings overrides.
- **Pass — States.** Browser regression covers empty hosts, missing selection, failed connection, success, manual entry, and saved-host reconnect/disconnect/remove. Backend tests cover in-flight disconnect, live updates, scope revocation, watch replacement, saved settings, and server shutdown.
- **Pass — Truthful status.** Production rows derive connection state from the backend stream. Saved hosts are recorded only after an authorized Hello. No simulated delay/result code is used in production; simulation stays in preview-ports.ts. Notice and error output is announced and scrolled into view.
- **Pass — Action hierarchy.** One primary Connect action on the SSH panel. Per-host actions are secondary menu items. Pairing's pending approval/invitation priority is retained in its panel.
- **Pass — Status meaning.** Existing status component uses green for a connected stream, neutral for disconnected. No decorative status badges.
- **Pass — Focus baseline.** Method buttons expose pressed state; native selects and labelled fields retain keyboard behavior; manual entry focuses the address; invalid hidden advanced fields reveal their containing details before validation. Visible focus uses the existing focus token. Exhaustive screen-reader and native VoiceOver testing was not performed.
- **Pass — Responsive layout.** Browser checked 1440 × 1000 and 900 × 900; compact fields do not create viewport overflow. Host controls can wrap and the connect footer stacks at narrow widths.
- **Pass — Installed native app.** Reinstalled the complete pending application changes on the Mac Mini, verified its signature and executable UUID, inspected the native SSH tab and expandable Environment card, and read real host data over a temporary local OpenSSH connection. All 218 pre-install session IDs and 735 session files were retained; config and credential file hashes were unchanged immediately after install.
- **Unverified — Physical two-device acceptance.** The MacBook was not available for a cross-device check. Both devices need this build for the new SSH socket protocol.

## Fixes during review

The existing minimal-settings selectors initially hid the intended rail border; scoped specificity restores the approved method-switch treatment. Fixture navigation now honors the destination passed to Back to Workspace, enabling the SSH-off-hosting regression. A reused watch's cancellation is fenced by watch UUID; stream-close events are scoped to the matching session. Disconnect also settles in-flight requests promptly and a second alias from the same client keeps its host authority until its own connection closes.

No P0/P1/P2 UI findings remain in the inspected states. Feature limitations and setup are documented in `docs/features/remote-access-ssh.md`.
