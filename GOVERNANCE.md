# Governance

Gyro starts as a maintainer-led open-source project.

## Maintainers

Maintainers own releases, roadmap ordering, repository permissions, security response, and final merge decisions.

## Decision Model

- Minor fixes can be merged by one maintainer after CI passes.
- User-facing behavior changes should be reviewed by at least one maintainer.
- Security-sensitive changes require maintainer review even when small.
- License, governance, telemetry, hosted services, or monetization changes require an explicit public proposal.

## Contribution Model

Gyro uses DCO signoff, not a CLA.

## Commercial Direction

The v1 core remains free and open source. Chat, CLI, and IDE unification in one
local session will never be paywalled. Any future paid offering must sit around
that core rather than inside it.

The current priority order is cross-device session continuity, a unified
provider usage and cost dashboard, team sync after demonstrated team usage, and
later organization policy controls and audit exports. Hosted model credits are
a possible low-priority convenience, while priority support and onboarding may
be a small later add-on. See [Vision](docs/vision.md#open-core-and-what-stays-free)
for the product boundary and rationale.
