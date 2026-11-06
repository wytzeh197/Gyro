# AI-Assisted Development

Gyro welcomes responsible use of AI tools in design, implementation,
documentation, testing, and review. AI can accelerate the work, but it does not
replace contributor judgment or maintainer accountability.

This policy applies to code, tests, documentation, release notes, generated
assets, and review comments submitted to the Gyro repository.

## Responsibility

The person submitting a change owns the complete result, regardless of which
tools helped create it. Before submission, contributors must understand the
change well enough to explain its behavior, risks, and validation.

- Review every AI-produced change before including it.
- Keep changes focused and remove speculative or unrelated output.
- Confirm that generated code follows Gyro's architecture, trust boundaries,
  and local-first principles.
- Do not present generated claims, test results, or release evidence as verified
  unless they were actually checked.
- Preserve authorship and license obligations for any material used as input.

## Privacy and Context

Only provide an AI service with information you are authorized to share. Never
send credentials, signing keys, private session logs, customer code, embargoed
release data, or other sensitive material to a model.

Prefer the smallest useful context. Redact personal paths, tokens, account
details, and private repository content from prompts, screenshots, fixtures,
and transcripts. Provider authentication must remain in provider-owned storage
or macOS Keychain, as described in Gyro's privacy and architecture documents.

## Verification

AI-assisted changes follow the same quality bar as any other contribution.

1. Inspect the final diff and remove accidental or unrelated changes.
2. Run the checks required by `CONTRIBUTING.md` and any checks appropriate to
   the affected subsystem.
3. Test user-visible behavior directly when automated checks cannot prove it.
4. Review security, privacy, compatibility, migration, and recovery impact.
5. Record what was actually verified in the pull request.

Tests written by the same AI tool are useful evidence, but not independent
proof. High-risk changes involving releases, storage, updates, providers,
terminals, approvals, permissions, or file mutations require human review and
the additional acceptance evidence requested by maintainers.

## Disclosure and Review

AI assistance does not require a special commit label. Disclose material AI use
in the pull request when it helps reviewers understand provenance, limitations,
or areas needing extra scrutiny. Always disclose generated assets or content
whose licensing or factual accuracy may not be obvious.

Reviewers should evaluate the resulting change rather than assume it is safe or
unsafe because AI was involved. Unclear, unverifiable, or unnecessarily broad
changes should be revised before merge.

## Releases

AI may help draft release notes, checklists, commands, or summaries, but it may
not serve as release evidence. A maintainer remains responsible for every
release decision.

- Release versions, tags, checksums, signatures, artifacts, and updater metadata
  must come from the repository and release automation, not model output.
- Required commands and manual acceptance checks in `docs/release.md` must run
  against the exact release candidate.
- Generated release notes must be checked against the merged diff and known
  limitations.
- Never provide release secrets or signing material to an AI service.
- Do not publish, replace assets, move tags, or update release channels solely
  because a model recommends it.

If AI output conflicts with repository state, test evidence, security policy,
or the documented release process, the verified repository evidence wins.
