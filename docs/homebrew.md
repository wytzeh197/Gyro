# Homebrew CLI Packaging

Gyro's dedicated tap distributes the `gyro` CLI only:

```bash
brew tap wytzeh197/tap
brew install wytzeh197/tap/gyro
```

Install by the fully qualified name so the tap's Formula is unambiguous.
Homebrew needs no separate approval step for a third-party tap; `brew trust`
is not a Homebrew command.

Confirm the installation with:

```bash
gyro --version
gyro completions zsh >/dev/null
gyro doctor --json
```

Use the direct DMG from the
[download site](https://usegyro.io/) to install Gyro.app. There is
no app Cask while the public Alpha lacks Apple Developer ID signing and
notarization. A Cask must not disable or bypass Gatekeeper, so the old universal
DMG Cask template has been removed.

## Release automation

The tagged release workflow builds native Apple Silicon and Intel CLI archives.
It publishes a generated `gyro.rb` release asset whose URLs point to the tag and
whose SHA-256 values match those archives. The checked-in
`packaging/homebrew/Formula/gyro.rb` is only a validation template and retains
checksum markers; never copy it to the public tap.

When a GitHub release is published, `.github/workflows/publish-homebrew.yml`:

1. downloads the generated `gyro.rb` asset;
2. rejects placeholders, a mismatched version, or the wrong repository URL; and
3. installs and exercises the Formula independently on Apple Silicon and Intel
   runners, including version, completion, doctor JSON, and Formula tests.

Publishing happens on the other side. `sync-gyro-formula.yml` in
`wytzeh197/homebrew-tap` runs on a half-hourly schedule and on manual dispatch,
resolves the newest published non-prerelease Gyro release, refuses to continue
unless `publish-homebrew.yml` concluded successfully for that tag, re-runs the
same Formula metadata checks, and commits `Formula/gyro.rb` when it changed.

The tap pulls rather than Gyro pushing because a push needs a credential for a
second repository. The tap's own `GITHUB_TOKEN` can write to the tap, so the
arrangement needs no personal access token and nothing expires. The cost is
latency: brew users see a release up to thirty minutes after it publishes, or
immediately after `gh workflow run sync-gyro-formula.yml --repo
wytzeh197/homebrew-tap`, which also accepts a `tag` input for backfilling.

Both sides are idempotent. Re-running either one when the tap already serves
the same Formula is a no-op.

## One-time tap setup

Create the public `wytzeh197/homebrew-tap` repository with a `main` default
branch and add `sync-gyro-formula.yml` to it. No secret or repository variable
is needed on either side; the Gyro workflow only reads its own release assets,
and the tap workflow only writes to itself.

Protect the tap account as a release credential, and re-run the Homebrew
workflow only after confirming that the
published `gyro.rb` asset is the intended one.

## Upgrade or remove the CLI

```bash
brew update
brew upgrade gyro
```

To uninstall the CLI and optionally remove the tap:

```bash
brew uninstall gyro
brew untrust --formula wytzeh197/tap/gyro
brew untap wytzeh197/tap
```

Homebrew manages the CLI executable and generated shell completions. It does
not remove Gyro.app, app sessions, or settings.
