# Anthropic approval email draft

Prepared 2026-11-16 and revised 2026-11-21 for Wytze’s review. Unsent draft.
Anthropic's [Claude Code commercial guidance](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products)
directs questions about authentication to [Anthropic Sales](https://www.anthropic.com/contact-sales).

Subject: Written confirmation for Gyro’s hosted Claude Code pilot

Hi Anthropic team,

I'm building Gyro, a local-first macOS coding workspace. I'd like written
confirmation that our proposed hosted pilot fits your Claude Code commercial
guidance before we run it on hosted infrastructure.

The proposed feature would let a user start a coding task from their Mac and run
the unmodified Claude Code CLI in a dedicated cloud sandbox while their Mac is
asleep. They could inspect logs, stop the task, and review a generated Git branch
locally. Each run would have a prepaid compute allowance, a runtime cap and an
idle timeout. Gyro would charge for sandbox compute, separately from model usage.

Our prototype uses the user's own Anthropic API key, with model usage billed
directly to that user by Anthropic. Gyro encrypts the key in its control plane
and attaches it to permitted outbound Anthropic API requests. The coding
process receives a placeholder and the sandbox filesystem never receives the
real key. We run the published Claude Code binary and keep account credentials
and subscription tokens out of Gyro's control plane.

Is that outbound key handling compatible with your commercial conditions on
intermediating usage? The prototype restricts outbound traffic to the provider
API, public npm and PyPI package reads, and the user's selected GitHub
repository, which means Claude account sign-in cannot complete inside the
sandbox. Your guidance says hosted products may not remove, disable or restrict
Claude Code's built-in authentication methods. Does an API-key-only pilot with
that network restriction meet this condition, or must the sandbox network
permit Claude account sign-in before we run it? Is a separate agreement needed
for Gyro to charge for sandbox time?

For a later phase, we’re considering letting the user sign in directly through
Anthropic’s own flow inside the unmodified Claude Code CLI. Gyro would neither
import the session from the Mac nor broker the sign-in. Please confirm how the
guidance applies to this setup, including which plans are eligible and whether
any restrictions apply to sandbox pause, resume, and session persistence.

Thanks,
Wytze
