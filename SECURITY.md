# Security Policy

Gyro can read source code, invoke local provider tools, and run terminal
commands. Please report security issues privately and give maintainers time to
investigate before public disclosure.

## Supported Versions

Gyro is currently alpha software. Security fixes target the latest `main`
branch and the newest published preview only. Older commits and preview builds
do not receive security updates.

## Report a Vulnerability

**Do not open a public issue.** Use
[GitHub private vulnerability reporting](https://github.com/wytzeh197/Gyro/security/advisories/new).

Include, when possible:

- affected commit or version and macOS version;
- impact and the conditions needed to trigger it;
- minimal reproduction steps or a proof of concept;
- whether files, model context, commands, credentials, updates, IPC, or session
  history are involved; and
- any suggested mitigation.

Remove real credentials and private repository content from the report. If a
minimal reproduction requires sensitive material, first describe the situation
without attaching it so maintainers can arrange a safer exchange.

Maintainers will acknowledge a report as soon as practical, investigate it,
coordinate a fix and release, and credit the reporter if requested. Response
times are best-effort while the project is maintainer-led.

## Security Model

- Sessions, configuration, and history remain local by default.
- Gyro sends no telemetry by default.
- Provider credentials remain in provider-owned storage or macOS Keychain.
- Commands and file changes follow the user's explicit approval policy.
- Common secret patterns are redacted from diagnostics and session logs.
- Workspace access is bounded to the selected workspace unless another path is
  explicitly shown and approved.
- Direct application updates must be signed and verified before installation.

High-risk areas include terminal execution, file writes, context assembly,
provider adapters, local CLI-to-app IPC, updater manifests and signing keys,
worktree boundaries, and diagnostic exports.

For non-sensitive bugs or setup questions, see [Support](SUPPORT.md).
