# Roadmap to v1.0

Gyro is a public macOS alpha. This roadmap describes intended work, not
verified runtime behavior or release commitments. See [release notes](releases/v0.1.0-alpha.48.md)
for the alpha.48 changes and [GitHub Releases](https://github.com/wytzeh197/Gyro/releases)
for published versions. The [vision](vision.md) defines the product principles
and the free local core.

## Release goal

A new user should be able to install Gyro, open a repository, run an agent
through a real change, inspect and approve its actions, review the result,
and resume the session later from the app or CLI.

## Contributor priorities

1. **Dependable installation.** Deliver Developer ID signed and notarized
   macOS builds and prove installation on clean Apple Silicon and Intel
   machines. Keep current alpha installation disclosures until the released
   artifacts have passed those checks. See [installation](install-macos.md)
   and [release verification](release.md).
2. **A proven coding loop.** Verify project setup, provider readiness, agent
   execution, approvals, review, and app/CLI continuity for supported
   providers. Extend the [clean-machine acceptance path](clean-machine-path.md)
   and report remaining limitations explicitly.
3. **A useful shared work panel.** Make browser and terminal activity visible,
   support clear user takeover, and connect files and review to the active
   session. Capability labels must match actual provider and backend support.
4. **Recovery and continuity.** Preserve useful task context across restarts
   and surface running processes, pending approvals, changed files, and
   failures clearly. Verify cancellation and recovery in the desktop app.
5. **Maintainable implementation.** Extract large UI and native modules along
   existing responsibility boundaries while preserving behavior. Keep
   architecture checks and focused regression coverage.
6. **Release hardening.** Ensure every visible control works, explains its
   limitations, or is omitted. Verify CLI output and session compatibility,
   migrations, and rollback before declaring v1.0 stable.

## Scope

The immediate priority is a dependable single-agent workflow on macOS 14+.
Automatic multi-agent orchestration, additional operating systems, general
computer control, and hosted collaboration are outside that immediate scope.
Council remains frozen; retain its existing safeguards while it is present.
The integrated editor supports the agent workflow without a commitment to
full standalone IDE parity.

## Contributing

Use [CONTRIBUTING.md](../CONTRIBUTING.md) for development and verification
requirements. Describe proposed work in terms of observable user outcomes,
include evidence appropriate to the change, and distinguish source inspection
from runtime verification.
