# Homebrew CLI Packaging

Gyro's dedicated tap distributes the `gyro` CLI only:

```bash
brew tap wytzeh197/tap
brew trust --formula wytzeh197/tap/gyro
brew install gyro
```

Homebrew requires explicit trust for third-party taps. Trusting only
`wytzeh197/tap/gyro` keeps that approval scoped to Gyro's Formula instead of
all present and future Formulae in the tap.

Confirm the installation with:

```bash
gyro --version
gyro completions zsh >/dev/null
gyro doctor --json
```

Use the direct DMG from the
[download site](https://wytzeh197.github.io/Gyro/) to install Gyro.app. There is
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
2. rejects placeholders, a mismatched version, or the wrong repository URL;
3. installs and exercises the Formula independently on Apple Silicon and Intel
   runners, including version, completion, doctor JSON, and Formula tests; and
4. copies the same validated file to `Formula/gyro.rb` in
   `wytzeh197/homebrew-tap` and pushes it.

The publish job runs only after both architectures pass and the repository
variable `HOMEBREW_TAP_PUBLISH_ENABLED` is set to `true`. Re-running it is
idempotent when the tap already contains the same Formula. A manual workflow
dispatch accepts a published tag so maintainers can validate or retry a release
after configuring the tap credentials.

## One-time tap setup

Create the public `wytzeh197/homebrew-tap` repository with a `main` default
branch. In the Gyro repository, add a fine-grained personal access token as the
`HOMEBREW_TAP_TOKEN` Actions secret. Limit the token to that tap repository and
grant only **Contents: Read and write**. The normal `GITHUB_TOKEN` remains
read-only and is used to download assets from the published Gyro release. Set
the `HOMEBREW_TAP_PUBLISH_ENABLED` repository variable to `true` only after the
secret is present; until then, both native Formula validation jobs still run
and the publishing job is safely skipped.

Protect the tap account and token as release credentials. Rotate the token if
it is exposed, and re-run the Homebrew workflow only after confirming that the
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
