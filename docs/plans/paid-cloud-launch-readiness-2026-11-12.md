# Paid Gyro Cloud launch preparation

Updated 12 November 2026. Document, rules and implementation review; not a legal opinion. Public checkout remains off. The selected offer is **Cloud $19 / Plus $49 USD per month, before applicable tax; Max unavailable**. Local work and user-owned providers remain independent of Cloud.

## Correct source and release state

The desktop target is `/Users/wytze/Gyro`, branch `v0.1.3`, base `999437c3`. This workspace already contained extensive unrelated work. The v3 bridge was integrated into that current app and its current settings components; the old isolated app preview is superseded and is not acceptance evidence. Its task-specific settings edit was restored after porting.

Website source: `/Users/wytze/gyro-website`. Private service source: `/Users/wytze/.codex/worktrees/gyro-cloud-v3-20261106/cloud`. That service's current untracked v3 implementation owns the newer offer; its neighboring old app is not the desktop target. No commit, push, app installation, website publication, Worker deployment or hosted migration was performed during this preparation.

Both desktop switches remain false: `config/cloud-availability.json` and `config/cloud-v3.json`. Production v3 API, billing, ingress and recovery were read back disabled, with production authorization false. Stripe Cloud/Plus products remain inactive. Existing older service settings were preserved.

## Registration and tax administration

Wytze confirmed registration has not happened. There is no revenue threshold permitting an otherwise registrable business to postpone registration. KVK permits registration from one week before to one week after business activities start; its examples include putting a business website online. First paid sale does not necessarily establish the start date or begin a new grace period. This does **not** make completed registration an unconditional prerequisite for preparation or a legally compliant first sale. [KVK timing](https://www.kvk.nl/starten/op-welke-datum-moet-ik-mijn-bedrijf-inschrijven-bij-kvk/)

- [ ] Wytze: establish the actual business start date and applicable registration deadline, arrange identity/DigiD and KVK appointment.
- [ ] Wytze: after registration, update published registered name, legal form and KVK number. Add the public VAT identification number when applicable; never the private omzetbelastingnummer. Until then, keep the published incomplete-registration status truthful. [KVK disclosure](https://www.kvk.nl/over-het-handelsregister/kvk-nummer-alles-wat-je-moet-weten/)
- [ ] Wytze/accountant: record VAT treatment, any KOR effective date, and Stripe settlements, fees and refunds. Apply for KOR after receiving the VAT registration letter, allowing at least four weeks before its intended start. KOR is optional and waiting to join it is not itself a launch prerequisite. [Belastingdienst KOR](https://www.belastingdienst.nl/wps/wcm/connect/nl/btw/content/aanmelden-kor)
- [ ] Retain the actual Managed Payments agreement, contracting entity and settlement documents. Confirm Gyro-to-Stripe VAT/reporting obligations separately from customer sales. Net bank payout is not automatically taxable profit. Do not apply the EU direct-sales €10,000 threshold automatically to merchant-of-record settlements.

Stripe Managed Payments and ordinary Stripe Tax are different arrangements. Choosing KOR does not alone determine the tax displayed on the merchant's customer sale. Retain merchant-of-record claims only for verified eligible Managed Payments transactions. [Stripe eligibility](https://docs.stripe.com/payments/managed-payments/eligibility), [tax coverage](https://docs.stripe.com/payments/managed-payments/tax-compliance)

## Prepared changes

| Area | Implemented locally / observed live |
| --- | --- |
| Current desktop | Native v3 authentication/credential namespace and transfer bridge integrated into current `App.tsx`, native setup and settings slots. Both release gates stay off. Current billing keeps public rights routes available while unavailable, signed out or offline. |
| Offer and website | Terms/privacy updated to 12 November; terms version `2026-11-12-v4`. Cloud $19 / Plus $49 before tax, current v3 limits and countries; Max not for sale. Public pages retain coming-soon status. Withdrawal states the statutory refund deadline. No usage deduction is sought for valid initial statutory withdrawal. |
| Durable agreement | Full dated contract text and public manifest prepared at `/legal/2026-11-12-v4/cloud-contract.txt`; builder publishes them and integrity checks detect changed source/snapshot. SHA-256 `6918825c8724737f085b98c13466564dc6112e415a59acde9398cdb217966c9e`. The conditional purchase snapshot does not activate the service. |
| Checkout consent | Checkout requires accepted terms and pins version/hash/request metadata. Migration 5 retains immutable offered text and acceptance evidence in billing-only tables; browser/API roles cannot read them. Signed Stripe state, rather than a redirect, controls fulfillment. |
| Agreement email | Billing-only sender sends the exact retained agreement to the verified Stripe customer email before first positive fulfillment. Ambiguous transport results prevent automatic resend and new authority, requiring operator review. Transport acceptance is not proof of inbox delivery. |
| Markets | Trusted Cloudflare country metadata gates new intent, checkout and managed work; supported billing country is also verified. Client country headers cannot authorize purchases. Cancellation, recovery, exports, deletion and statutory rights are preserved. |
| Stripe public profile | Support email and contact URL, privacy URL and terms URL saved live. Existing operator identity/address were preserved. |
| Stripe readiness | Live dashboard shows Managed Payments “Ready to use”; default activation remains off. Account charges/payouts enabled with no current requirements is observed account status, not proof of successful Managed Payments checkout or tax treatment. Cloud/Plus products remain inactive. |
| Email infrastructure | Sending domain `usegyro.io` read back verified/enabled. Restricted Worker sender binding prepared; no message sent and no hosted binding deployed. |

The immutable text includes the terms, privacy, withdrawal, contact and model notice. Keep the public URL stable once any customer accepts it. A later substantive change requires a new version and hash; existing contracts retain their original text.

## Verification completed

| Evidence | Result and limit |
| --- | --- |
| Current native core | 94 Cloud connection tests passed, including the 26 v3 coordinator/transfer tests. 20 Keychain-related tests passed. No real owner Keychain/session acceptance inferred. |
| Current desktop native | Locked desktop library check and two v3 request tests passed. Existing compiler warnings remain. No installed-app or Intel acceptance claimed. |
| Current frontend | Desktop typecheck, production build, architecture boundary check and billing/settings render checks passed. All 12 v3 JS checks passed, including decoding responses captured from the current real local PostgreSQL/API test run. This is local wire evidence, not hosted acceptance. |
| Current visual check | Current workspace preview inspected in the current settings shell; rights links keyboard accessible. Synthetic sample account; not hosted/native acceptance. |
| Private service | 60 v3 tests passed, including local workerd tests. General and Worker TypeScript checks and billing Worker bundle dry run passed. 70 source/test/config files matched the validated scratch copy. No deployment occurred. |
| Real PostgreSQL | 14 tests passed, including billing-only contract access and immutable evidence. Local database, not hosted migration acceptance. |
| Website | Full `npm run site:check` passed, including snapshot/source integrity and existing withdrawal checks. No publication or live parity claimed. |

Logs are in `/private/tmp/gyro-paid-cloud-prep/`; the review packet and current screenshot are in `/Users/wytze/.codex/visualizations/2026/11/12/01a1cff8-b85e-7621-bc6a-1e5a2cb4a9ee/`. Preserve durable evidence before temporary files are cleared. The supplied handoff's live page/header review remains reported history; these website edits have not been published.

## Remaining acceptance before activation

These are execution/owner decisions, not missing local copy changes. Use the [activation runbook](paid-cloud-activation-runbook-2026-11-12.md) for the concrete order.

- [ ] Review and authorize publication/deployment of the exact prepared versions while all purchase/runtime admission remains disabled. Publish the immutable agreement before any checkout links to it; apply migration 5 and restricted email binding/config to the intended environment. Back up first; preserve existing service data and unrelated website/app edits.
- [ ] Hosted isolated test: real signed test-mode checkout/webhooks, consent/version retention, invoice-before-checkout, duplicates, agreement email transport and inbox delivery, failure/recovery, cancellation, refunds and disputes. Verify seller, recurring final total/tax, country support and receipts. Do not invent a live charge as a prerequisite.
- [ ] Installed current app in an isolated profile/credential scope: sign-in/rotation/reconnect, prepared transfer survival, save/restore/export/delete, recovery and every advertised benefit. Existing old-app staging results do not close this current-app acceptance.
- [ ] Recovery: unattended scheduling/freshness alert, full capacity/cost validation and recovery-key custody independent of this Mac. The prior manual pilot uses a 64 MiB run bound and cannot establish advertised 5/20 GB account recovery. Verify a new post-migration backup and restore, including contract tables.
- [ ] Plus: run the prepared model quality/cost comparison and Check qualification before advertising delivery as available. The local 40-request plan estimates at most 53,417 USD micros of token cost under its assumptions; no paid call was made. Keep Plus admission closed until its qualification gates pass.
- [ ] Validate concurrent/full-allowance and tiny-object costs, invoice/merchant fee reconciliation, service/global quotas, uncertain-request reconciliation and operator support handling.
- [ ] Complete operator registration/tax tasks against their real deadlines and update disclosures as facts change.
- [ ] Record exact accepted app/service/website versions, markets, rollback controls and remaining exceptions. Public purchase activation is a separate authorized action; this task leaves it off.

Withdrawal, stopping renewal, refunds and deletion stay separate. Starting service does not silently waive withdrawal rights. Test the online withdrawal function, durable acknowledgement and merchant refund execution; a notice receipt does not establish that a refund happened. [ACM guidance](https://www.acm.nl/nl/verkoop-aan-consumenten/klantenservice/bedenktijd)
