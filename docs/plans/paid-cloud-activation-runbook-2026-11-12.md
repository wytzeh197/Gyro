# Paid Cloud activation runbook — prepared, not executed

12 November 2026. Cloud $19 / Plus $49 USD monthly before applicable tax; Max unavailable. This is a reviewable execution plan. It does not authorize deployment, messages, payments, provider spend or activation.

## Source and preparation

Use the current desktop `/Users/wytze/Gyro` (`v0.1.3`), website `/Users/wytze/gyro-website` and private service `/Users/wytze/.codex/worktrees/gyro-cloud-v3-20261106/cloud`. Review task-specific changes against preserved pre-task copies, not every unrelated working-tree edit. Do not build or install the old neighboring app worktree.

1. Preserve the current app and website work. Record reviewed source hashes, generated contract hash and deployable artifacts. Preserve any task acceptance evidence outside temporary storage.
2. Keep desktop `cloud-availability.enabled=false`, `cloud-v3.enabled=false`, v3 production enabled/authorized false, product active false, Managed Payments default activation off and Max unavailable throughout preparation. Read back actual values rather than trusting local templates.
3. Review the final public offer against private policy, Stripe prices and tax settings. The immutable version is `2026-11-12-v4`, SHA-256 `6918825c8724737f085b98c13466564dc6112e415a59acde9398cdb217966c9e`.
4. Publish only reviewed website changes and the immutable text/manifest after authorization. Fetch exact bytes and hash, confirm attachment/no-sniff headers, usable rights routes, withdrawal acknowledgement and final public contact/operator statements. Do not mutate an already accepted version.

## Private rollout, with admission closed

5. Use the exact intended staging/production environment identity, verified TLS, restricted database roles and private configs. Base `wrangler.v3.*.jsonc` files contain unprovisioned placeholder resource IDs; do not deploy them as production configuration.
6. Take an encrypted consistent backup, retain required keys separately and verify decryption/archive listing. Apply additive migration 5, including all contract tables/RLS/grants. Read back identity, schema version and denied API/browser access. Preserve existing v2/v3 data.
7. Prepare the private billing config locally with the checked-in tool. These arguments are placeholders for reviewed owner-only files; the command neither uploads a secret nor enables checkout:

```sh
node --import tsx scripts/prepare-v3-contract.ts --plan
node --import tsx scripts/prepare-v3-contract.ts --billing PRIVATE_BILLING_JSON --manifest PUBLIC_MANIFEST --snapshot CONTRACT_TEXT --output NEW_PRIVATE_FILE
```

8. Review the new private file without logging values. Use the exact product/price/environment pins, legal text/hash/URL and byte limit. Add restricted `CONTRACT_EMAIL` sender binding to the actual environment's billing Worker config. Upload/redeploy only after authorization; keep all sales/work flags closed. Read back deployed version, nonsecret bindings and false gates. Never expose config/credential bytes in reports.
9. Test isolated hosted test-mode billing with a named test account and designated test inbox. This requires a supported sandbox/test configuration; do not point test credentials or fixtures at production or substitute a live charge. Record Stripe seller/total/tax/consent, signed event IDs, retained version/hash, entitlement and confirmation delivery. Check retries/order/duplicate events, failure/recovery, cancellation and refund/dispute revocation. Ensure the merchant accepts the consent/custom-text parameters used here.
10. On uncertain confirmation email, inspect provider evidence and the retained delivery row before resolving it manually. Do not blindly reset `sending`/`uncertain` or resend. Preserve the original offer/acceptance and audit the resolution. A successful API send response alone is not inbox delivery; test recipient delivery and handling of bounces.

## Recovery, capacity and owner custody

11. Use the existing private `docs/cloud-v3-supabase-recovery.md` runbook. Prepare the selected independent runner with pinned runtime/tools, private configs, verified TLS and bounded credentials; retain operator/backup/journal keys outside Cloudflare and independently of this Mac. Selecting/purchasing a runner or moving keys requires the owner; no runner or recurring job is installed by this preparation.
12. Proposed operating target: one successful backup each day, alert if no complete authenticated point within 26 hours, and an immediate failure alert. The runner must serialize executions and publish a success receipt only after backup plus bootstrap publication finish. Do not count process start, partial uploads or failed runs as freshness. Keep seven latest-per-day points and test retention against restore references.
13. Size run budgets to all admitted customer data, retained chunks/database/key material and required transfer overhead. The existing 64 MiB pilot and the helper's 1 GiB maximum per-run cap cannot cover the full advertised 5/20 GB account allowances. Resolve capacity/batching/streaming design and costs before admitting such data; do not merely increase a configuration beyond its validated bounds.
14. Rehearse loss of the Cloudflare account using a new backup containing migration 5 evidence, isolated PostgreSQL, authenticated file restoration, retained historical object keys and newer deletion/revocation journal outcomes. Restore must leave admission off. Reconcile Stripe authority and required grants before any restored access. A backup is not accepted until its restore succeeds.

## Current app and Plus

15. Build the current desktop in an isolated verification identity/profile. Do not replace the user's installed app. Verify the current shell, native sign-in/refresh rotation, explicit remember choice, reconnect/sign-out races, prepared transfer preservation, maximum save/restore, export/delete and offline/rights paths. Keep test accounts/data labelled and credentials private.
16. Generate the Plus quality/cost plan locally:

```sh
node --import tsx scripts/qualify-v3.ts --plan gpt-6-luna
```

The prepared plan has 40 requests and an estimated token-cost bound of $0.053417 under its stated assumptions, excluding taxes and unexpected billing. It executes no model requests. Obtain concrete paid-call scope/budget before execution; review useful output and critical failures per the checked-in rubric. Do not enable model/Check acceptance simply because a request succeeds. Cloud has no included managed AI; Plus remains unavailable until qualified.

## Release and rollback

17. Validate concurrent usage, full allowances/tiny-object costs, global admission limits, billing/fee invoices, monitoring, support and incident ownership. Close registration/tax administration by the actual applicable deadlines and update operator disclosures when facts change.
18. Record accepted source/artifact/deployment identities and evidence. Obtain separate explicit purchase-activation authorization. Enable only the accepted plan/market intersection, with Max closed. Read back actual gates/products, final site availability and native release configuration. Never activate a plan whose advertised delivery is not accepted.
19. If rollout fails, keep new purchases and managed work closed. Preserve data/evidence and append-only contract records; do not undo migration 5 by deleting accepted contracts. Preserve cancellation, statutory withdrawal, export/read recovery and deletion. Reconcile uncertain email, provider and payment outcomes before retrying. Revert code to a compatible reviewed version; do not blindly deploy a pre-migration role grant script.

The private service's `AGENTS.md` requires explicit authorization for public publishing, production deployment and paid calls. No action above overrides that rule or the user's instruction to keep checkout off.
