# Provider connection path — 21 September 2026

## Changes

- Unconfigured chats lead to provider settings rather than choosing Codex implicitly. The setup prompt remains available with a project open. Explicit provider repair actions remain provider-specific.
- Provider settings offers account, API-key, and local-model entry points. Each moves focus to its corresponding controls.
- API-only providers offer Add API key and select the matching provider in the form.
- Connection progress remains visible for the full async connection attempt. A per-provider guard prevents duplicate attempts and releases in finally.
- Usable providers expose Use in chat. It selects the chosen default model for the current chat/draft and opens the chat layout. Failed checks and in-progress setup do not expose the completion action.

## Evidence and limits

UI and desktop TypeScript checks, clean-machine path checks, workbench smoke checks, and UI token checks passed. git diff --check passed.

The development-only settings preview showed the real provider settings components. Browser interactions verified disabled Connecting controls, a simulated successful sign-in revealing Use in chat, and that action reporting the expected provider/model. Clicking DeepSeek's Add API key selected DeepSeek in the form, verified in a delivered screenshot.

The preview uses invented state. No real sign-in, credential submission, paid provider request, native persistence, or clean-machine end-to-end run was performed. The desktop chat navigation callback was checked in source and types, not exercised through authenticated desktop login.
