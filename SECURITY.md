# Security Policy

Gyro is local-first software that can read repositories and run commands, so security issues are taken seriously.

## Supported Versions

Gyro is pre-alpha. Security fixes target the latest `main` branch until the first public release.

## Reporting A Vulnerability

Do not file public issues for vulnerabilities.

For now, report privately to the maintainers through GitHub private vulnerability reporting once the public repository is enabled. Until then, contact the project owner directly.

Include:

- Affected commit or release.
- Reproduction steps.
- Expected and actual behavior.
- Whether model context, local files, terminal commands, credentials, updates, or IPC are involved.

## Security Principles

- BYOK only for v1.
- Store provider keys in macOS Keychain.
- No telemetry by default.
- Commands require approval unless the user explicitly changes policy.
- File edits require approval unless the user explicitly changes policy.
- Session logs redact common secret shapes.
- Workspace reads and writes must stay inside the selected workspace unless explicitly shown to the user.
- Updates must be signed and verified before install.

## High-Risk Areas

- Terminal command execution.
- File write tools.
- Model prompt context assembly.
- Local IPC between CLI and desktop app.
- Update manifests and signing keys.
- Provider API key storage.
