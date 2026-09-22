# Remote model catalog

Gyro keeps its bundled provider catalog as the offline baseline. Desktop startup
restores the last validated remote catalog before config normalization, then
refreshes in the background after the shell loads and every six hours.

The client fetches `https://usegyro.io/model-catalog.json` through a dedicated
native command. It sends no provider credentials or workspace data, refuses
redirects, limits responses to 256 KiB, and times out after ten seconds.
Transport or validation failures preserve the last working catalog. Storage
failure still allows updates for the current app session.

## Publishing a model addition

Edit `site/model-catalog.json`. The site build includes it as a static asset.
A model entry looks like this (illustrative ID, not a real model):

```json
{
  "schema": "gyro.model-catalog.v1",
  "revision": "2026-09-22.2",
  "enabled": true,
  "rolloutPercentage": 10,
  "models": [
    {
      "providerId": "openai",
      "id": "example-compatible-model",
      "displayName": "Example model",
      "description": "A newly supported model.",
      "minClientRevision": 1,
      "contextWindowTokens": 200000,
      "supportedReasoningEfforts": ["low", "high"],
      "defaultReasoningEffort": "high"
    }
  ]
}
```

Run `node --experimental-strip-types scripts/check-model-catalog.mjs`.
Verify the model ID and options against the actual supported integration before
publishing. Deploying the site is a separate release action; editing this file
does not publish it.

The document is a complete overlay, not an accumulating patch. Matching model
IDs replace bundled metadata; new IDs are appended to their existing provider.
An empty models list restores the bundled catalog. The initial document is empty
so this infrastructure introduces no unverified models.

## Compatibility, rollout, and withdrawal

- `minClientRevision` gates entries on an explicit catalog implementation
  revision bundled into the app. Revision 1 supports only the existing provider
  integrations and reasoning vocabulary. Increment it when a later app release
  adds capabilities that older clients cannot execute.
- `rolloutPercentage` uses a persistent installation bucket from 0 to 99.
  Raising it expands the rollout without transmitting an installation ID.
- Remove an overlay entry to withdraw it, publish an earlier document to roll
  back, or set `enabled: false` to restore all bundled entries. Already-running
  sessions retain their recorded model; this is picker rollback, not cancellation.

Saved custom models and local Ollama discovery remain intact. Catalog-derived
entries are marked in memory so normalization cannot resurrect withdrawn models.
Provider endpoints, credentials, executable settings, image/tool permissions,
and defaults cannot be changed by the document. Unknown providers and entries
requiring a later client revision are ignored. Other invalid data rejects the
whole document atomically.

## Scope and release requirements

This first version updates model-picker metadata and available choices. It does
not install or upgrade provider CLIs, change authentication, add runners, or
update the native fallback context-window tables. Runtime-reported context
limits remain authoritative; models requiring new native handling still need
an app release. Catalog publication must account for supported CLI versions.

Users need one app release containing this client, and the site catalog must
be deployed, before remote model additions work. No app release or site
deployment is performed by this implementation.

## Validation

The regression script covers parsing, size limits, field isolation, picker
merging, compatibility gates, rollout boundaries, withdrawal, corrupt caches,
offline restoration, storage failures, and deduplicated refreshes. It runs in
`pnpm test:reliability`. Native unit tests cover bounded UTF-8 transport reads.
